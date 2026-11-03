import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as nodePath from "node:path";
import { systemPrompt } from "../lib/sdk/agent/modes";
import { DEFAULT_MODE, MODE_NAMES, MODES_BY_NAME, type ContextFile, type ModeName } from "../lib/sdk/agent/types";
import type { ToolsVerdict } from "../lib/matterwaveClient";
import type { Memento } from "../promptLibrary";
import type { AgentMcpView, AgentPendingView, AgentRunView, AgentView } from "../chat/protocol";
import { compactHistory, transcriptText, type CompactionResult } from "./compaction";
import { initPrompt, loadProjectContext } from "./contextFiles";
import { definitionDirs, loadCustomCommands, loadSubagents, type CustomCommand, type SubagentDefinition } from "./definitions";
import { taskTool, todoTool, webFetchTool, type TodoItem } from "./extraTools";
import { contractTools, type HostOptions } from "./host";
import { estimateTokens, newBudget, runLoop, type LoopStatus, type ModelClient, type RunBudget } from "./loop";
import type { McpManager, McpServerConfig } from "./mcp";
import { buildPromptContext, type EditorContext } from "./promptContext";
import {
  isPiAvailable,
  PiAgentBackend,
  type PiAgentBackendOptions,
  type PiBackendCallbacks,
  type PiDoneEvent,
  type PiFallbackRunner,
  type PiPromptOptions,
} from "./piBackend";
import { failure, ok, promptTools, type Approvals, type ChangeOutcome, type ChangeRequest, type ConfirmRequest, type ToolContext, type ToolOutcome, type ToolSpec } from "./tools";
import { StepAccumulator, type ChatMessage, type ToolCall } from "./wire";

export type AgentEngine = "auto" | "pi" | "builtin";

export const AGENT_ENGINES: readonly AgentEngine[] = ["auto", "pi", "builtin"] as const;

/**
 * The coding agent's session: everything about agent mode that is not the
 * editor. It holds the toggle, the approval mode, the workspace root, the
 * approval being waited on, the todo list and each conversation's agent
 * history, and it runs the loop for one prompt at a time.
 *
 * The editor side is behind `ReviewSurface` (the native diff and the
 * WorkspaceEdit that applies a change) and a few callbacks, so a whole run
 * -- approvals included -- is testable with a fake `/v1` and a fake editor.
 */

/** The diff editor's side of a change under review. */
export interface ReviewHandle {
  /** The proposal as the person left it: what Accept writes, their edits included. */
  proposal(): Promise<string>;
  reveal(): Promise<void>;
  close(): Promise<void>;
}

export interface ReviewSurface {
  /** Open the native diff of the file against the proposal, which the person may edit. */
  open(change: ChangeRequest, id: string): Promise<ReviewHandle>;
  /** Write `content` through the editor (a WorkspaceEdit, so Ctrl+Z undoes it), save, and return what the file holds. */
  apply(change: ChangeRequest, content: string): Promise<string>;
}

export interface AgentSettings {
  maxSteps: number;
  maxTokens: number;
  defaultMode: ModeName;
  webFetch: boolean;
  editorContext: boolean;
  engine?: AgentEngine;
  piBinaryPath?: string;
}

export interface AgentSessionDeps {
  client: ModelClient & {
    baseUrl?: string;
    compact?(conversationId: string, model?: string): Promise<{ parts: { type: string; text?: string | null }[] }>;
    myInstructions?(): Promise<{ about: string | null; style: string | null }>;
  };
  review: ReviewSurface;
  /** Keep what a file was before an applied change, for `/restore`. */
  checkpoint?(conversationId: string | null, relative: string, before: string | null, absolute: string): Promise<void>;
  /** The per-session flag yolo needs: a modal the person must confirm. */
  confirmYolo(): Promise<boolean>;
  pickRoot?(roots: { name: string; path: string }[]): Promise<string | null>;
  settings(): AgentSettings;
  workspace(): { roots: { name: string; path: string }[]; trusted: boolean };
  editorContext?(): EditorContext | null;
  readText?: HostOptions["readText"];
  runShell?: HostOptions["runShell"];
  /** Workspace state: the mode (never yolo), the root, each conversation's agent history. */
  state?: Memento;
  mcp?: McpManager;
  /** The servers to sync before a run; may ask the person about a workspace's servers first. */
  mcpConfigs?(): Record<string, McpServerConfig> | Promise<Record<string, McpServerConfig>>;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** The home folder for `~/.matterwave`; tests point it elsewhere. */
  home?: string;
  /** API key or bearer token injected into Pi 1.0 (`MATTERWAVE_API_KEY`). */
  apiKey?: () => string | null | Promise<string | null>;
  /** Base URL injected into Pi 1.0 (`MATTERWAVE_BASE_URL`). */
  baseUrl?: () => string;
  /** Optional custom arguments passed to `pi` (defaults to `["--mode", "rpc"]`). */
  piArgs?: string[];
  /** Optional override for probing whether the `pi` binary is available. */
  probePiAvailable?: (binaryPath: string) => Promise<boolean>;
  onChange(): void;
  log?(line: string): void;
}

export interface RunEvents {
  onText?(text: string): void;
  onToolCall?(call: ToolCall, label: string): void;
  onToolResult?(call: ToolCall, outcome: ToolOutcome): void;
  onNotice?(text: string): void;
}

export interface RunRequest {
  prompt: string;
  conversationId: string | null;
  model: { id: string; context_window: number | null } | null;
  signal: AbortSignal;
  /** The conversation so far, for one the agent has no history of (begun in chat, or on the web). */
  seed?: ChatMessage[];
  events?: RunEvents;
}

export interface RunSummary {
  status: LoopStatus;
  text: string;
  message?: string;
  error?: unknown;
  usage: AgentRunView;
}

interface Pending extends AgentPendingView {
  resolve(decision: { accept: boolean; reason?: string }): void;
  handle?: ReviewHandle;
}

interface StoredRun {
  conversationId: string;
  title: string;
  root: string;
  updatedAt: string;
  messages: ChatMessage[];
}

const MODE_KEY = "matterwave.agent.mode";
const ROOT_KEY = "matterwave.agent.root";
const ENABLED_KEY = "matterwave.agent.enabled";
const RUNS_KEY = "matterwave.agent.runs";
/** Agent histories kept per workspace, newest first, and the size one may take in workspace state. */
const MAX_STORED_RUNS = 30;
const MAX_STORED_CHARS = 600_000;
const MAX_SESSION_RUNS = 50;
const MAX_OUTPUT_TAIL = 2_000;

const SUMMARY_SYSTEM =
  "You summarise a coding agent's session so it can continue with less context. Keep: the task and the person's requests, decisions made, files read and changed (with paths), commands run and their outcomes, and what is left to do. Plain prose and lists, no preamble.";

export class AgentSession {
  private enabledFlag: boolean;
  private currentMode: ModeName;
  private yoloAllowed = false;
  private chosenRoot: string | null;
  private pending: Pending | null = null;
  private running = false;
  private status: string | null = null;
  private output: string | null = null;
  private todos: TodoItem[] = [];
  private contextFiles: string[] = [];
  private contextNotice: string | null = null;
  private budget: RunBudget | null = null;
  private readonly runs: AgentRunView[] = [];
  private readonly histories = new Map<string, ChatMessage[]>();
  private instructionsCache: string | null | undefined;
  private nextId = 1;
  private soon: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: AgentSessionDeps) {
    const saved = deps.state?.get<string>(MODE_KEY);
    const fallback = MODES_BY_NAME[deps.settings().defaultMode]?.persistable ? deps.settings().defaultMode : DEFAULT_MODE;
    // A saved mode is one the contract lets be saved: yolo never is.
    this.currentMode = saved && MODES_BY_NAME[saved as ModeName]?.persistable ? (saved as ModeName) : fallback;
    this.chosenRoot = deps.state?.get<string>(ROOT_KEY) ?? null;
    this.enabledFlag = deps.state?.get<boolean>(ENABLED_KEY) === true;
  }

  // --- the toggle, the mode, the root --------------------------------------------

  get enabled(): boolean {
    return this.enabledFlag;
  }

  get mode(): ModeName {
    return this.currentMode;
  }

  get isRunning(): boolean {
    return this.running;
  }

  setEnabled(on: boolean): void {
    this.enabledFlag = on;
    void this.deps.state?.update(ENABLED_KEY, on);
    this.changed();
  }

  /** The modes Shift+Tab cycles through: yolo only once this session allowed it. */
  modes(): ModeName[] {
    return MODE_NAMES.filter((m) => m !== "yolo" || this.yoloAllowed);
  }

  /**
   * Switch modes. Yolo asks for the session's flag first (a modal the person
   * confirms) and is never saved; the other modes are kept for the workspace.
   * False when the person declined.
   */
  async setMode(name: ModeName): Promise<boolean> {
    if (!MODE_NAMES.includes(name)) return false;
    if (name === "yolo" && !this.yoloAllowed) {
      if (!(await this.deps.confirmYolo())) return false;
      this.yoloAllowed = true;
    }
    this.currentMode = name;
    if (MODES_BY_NAME[name].persistable) void this.deps.state?.update(MODE_KEY, name);
    this.changed();
    return true;
  }

  async cycleMode(): Promise<ModeName> {
    const modes = this.modes();
    const next = modes[(modes.indexOf(this.currentMode) + 1) % modes.length] ?? DEFAULT_MODE;
    await this.setMode(next);
    return this.currentMode;
  }

  /** The workspace folder the agent works in: the one picked, or the first. */
  root(): { name: string; path: string } | null {
    const roots = this.deps.workspace().roots;
    return roots.find((r) => r.path === this.chosenRoot) ?? roots[0] ?? null;
  }

  async pickRoot(): Promise<void> {
    const roots = this.deps.workspace().roots;
    if (roots.length < 2 || !this.deps.pickRoot) return;
    const picked = await this.deps.pickRoot(roots);
    if (!picked) return;
    this.chosenRoot = picked;
    void this.deps.state?.update(ROOT_KEY, picked);
    this.changed();
  }

  /**
   * Whether agent mode can run now, and the sentence for the greyed-out
   * toggle when not. `tools` and `localAgentTools` are the SDK's verdicts
   * (`toolsOf`, `localAgentToolsOf`): only "no" refuses, and "unknown" (a
   * deployment that does not say) is let through.
   */
  availability(input: { signedIn: boolean; model: { label: string; tools: ToolsVerdict } | null; localAgentTools: ToolsVerdict }): {
    available: boolean;
    reason: string | null;
  } {
    const { trusted } = this.deps.workspace();
    const no = (reason: string) => ({ available: false, reason });
    if (!input.signedIn) return no("Sign in to use the agent.");
    if (!trusted) return no("The agent is off in an untrusted workspace: it reads files and runs commands. Trust the folder to use it.");
    if (!this.root()) return no("Open a folder: the agent works inside a workspace folder.");
    if (input.localAgentTools === "no") return no("Your organisation has turned off local agent tools.");
    if (input.model?.tools === "no") return no(`${input.model.label} cannot call tools. Pick a model that can to use the agent.`);
    return { available: true, reason: null };
  }

  // --- approvals ------------------------------------------------------------------

  /** Accept or reject the approval waited on; a stale id (already decided) is ignored. */
  decide(id: string, accept: boolean, reason?: string): boolean {
    if (!this.pending || this.pending.id !== id) return false;
    this.pending.resolve(reason === undefined ? { accept } : { accept, reason });
    return true;
  }

  /** The approval waited on (of `kind`, when given), for the editor's Accept and Reject commands. */
  pendingId(kind?: AgentPendingView["kind"]): string | null {
    if (!this.pending || (kind && this.pending.kind !== kind)) return null;
    return this.pending.id;
  }

  async showDiff(id: string): Promise<void> {
    if (this.pending?.id === id) await this.pending.handle?.reveal();
  }

  private wait(view: AgentPendingView, signal: AbortSignal, handle?: ReviewHandle): Promise<{ accept: boolean; reason?: string }> {
    return new Promise((resolve) => {
      const onAbort = () => finish({ accept: false });
      const finish = (decision: { accept: boolean; reason?: string }) => {
        if (this.pending?.id === view.id) this.pending = null;
        signal.removeEventListener("abort", onAbort);
        this.status = this.running ? "Working…" : null;
        this.changed();
        resolve(decision);
      };
      this.pending = { ...view, resolve: finish, ...(handle ? { handle } : {}) };
      this.status = view.kind === "edit" ? `Review the change to ${view.path}` : "Waiting for your approval";
      this.changed();
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private approvals(conversationId: string | null): Approvals {
    const apply = async (change: ChangeRequest, content: string): Promise<ChangeOutcome> => {
      // The file may have changed, or its path been relinked, while the change waited for the person.
      const stale = await change.stale?.();
      if (stale) return { status: "failed", reason: stale };
      await this.deps.checkpoint?.(conversationId, change.relative, change.before, change.absolute);
      this.status = `Writing ${change.relative}`;
      this.changed();
      return { status: "applied", content: await this.deps.review.apply(change, content), edited: content !== change.after };
    };
    return {
      change: async (change, ask, signal): Promise<ChangeOutcome> => {
        if (!ask) return apply(change, change.after);
        const id = `a${this.nextId++}`;
        const handle = await this.deps.review.open(change, id);
        const decision = await this.wait(
          {
            id,
            kind: "edit",
            tool: change.tool,
            title: revealInvisible(change.before === null ? `Create ${change.relative}` : `Change ${change.relative}`),
            detail: revealInvisible(change.relative),
            path: revealInvisible(change.relative),
            diff: revealInvisible(change.diff),
          },
          signal,
          handle,
        );
        if (!decision.accept) {
          await handle.close();
          return decision.reason ? { status: "rejected", reason: decision.reason } : { status: "rejected" };
        }
        // What the diff's right side holds now: the proposal, or the person's edit of it.
        const proposal = await handle.proposal();
        await handle.close();
        return apply(change, proposal);
      },
      confirm: async (request: ConfirmRequest, signal) => {
        const decision = await this.wait(
          {
            id: `a${this.nextId++}`,
            kind: request.kind,
            tool: request.tool,
            title: revealInvisible(request.title),
            detail: revealInvisible(request.detail),
            path: null,
            diff: null,
          },
          signal,
        );
        return decision.reason ? { approved: decision.accept, reason: decision.reason } : { approved: decision.accept };
      },
    };
  }

  // --- the run --------------------------------------------------------------------

  private home(): string {
    return this.deps.home ?? homedir();
  }

  private async instructions(): Promise<string | null> {
    if (this.instructionsCache !== undefined) return this.instructionsCache;
    try {
      const mine = await this.deps.client.myInstructions?.();
      const text = [mine?.about ? `About the person: ${mine.about}` : "", mine?.style ? `How to answer: ${mine.style}` : ""]
        .filter(Boolean)
        .join("\n");
      this.instructionsCache = text || null;
    } catch {
      this.instructionsCache = null;
    }
    return this.instructionsCache;
  }

  /** Forget cached account instructions (after an account switch). */
  resetAccount(): void {
    this.instructionsCache = undefined;
  }

  /**
   * The system prompt for a step: the SDK's, with the extension's own tools
   * this mode offers and the workspace's notes in its slots, then the
   * account's instructions, which are this client's to add.
   */
  private systemFor(mode: ModeName, root: string, specs: ToolSpec[], contextFiles: ContextFile[], instructions: string | null): string {
    const prompt = systemPrompt(mode, root, { extraTools: promptTools(specs, mode), contextFiles });
    return instructions ? `${prompt}\n\nThe person's account instructions:\n${instructions}` : prompt;
  }

  private async specs(root: string, settings: AgentSettings, trusted: boolean, run: { budget: RunBudget; model: string | undefined; events?: RunEvents }): Promise<ToolSpec[]> {
    const specs: ToolSpec[] = [...contractTools({ readText: this.deps.readText, runShell: this.deps.runShell })];
    specs.push(
      todoTool((items) => {
        this.todos = items;
        this.changed();
      }),
    );
    if (settings.webFetch && this.deps.fetch) specs.push(webFetchTool(this.deps.fetch));
    if (this.deps.mcp && this.deps.mcpConfigs) {
      this.status = "Connecting to MCP servers…";
      this.changed();
      await this.deps.mcp.sync(await this.deps.mcpConfigs());
      specs.push(...this.deps.mcp.specs());
    }
    const subagents = await loadSubagents(definitionDirs("agents", root, trusted, this.home()));
    const task = taskTool(subagents, (definition, prompt, ctx) => this.runSubagent(definition, prompt, ctx, specs, root, run));
    if (task) specs.push(task);
    return specs;
  }

  /**
   * A subagent: a nested loop with the definition's own prompt and its tool
   * allow-list (never `task`, so subagents do not nest), on the parent's
   * budget, signal and approvals. Its steps count against the parent's caps.
   */
  private async runSubagent(
    definition: SubagentDefinition,
    prompt: string,
    ctx: ToolContext,
    parentSpecs: ToolSpec[],
    root: string,
    run: { budget: RunBudget; model: string | undefined; events?: RunEvents },
  ): Promise<ToolOutcome> {
    const allow = definition.tools ? new Set(definition.tools) : null;
    const specs = parentSpecs.filter((s) => s.name !== "task" && (!allow || allow.has(s.name)));
    const history: ChatMessage[] = [{ role: "user", content: prompt }];
    const nested = (call: ToolCall): ToolCall => ({ ...call, function: { ...call.function, name: `${definition.name} › ${call.function.name}` } });
    const result = await runLoop({
      client: this.deps.client,
      model: run.model,
      mode: () => this.currentMode,
      system: (mode) =>
        [
          systemPrompt(mode, root, { extraTools: promptTools(specs, mode) }),
          `You are the "${definition.name}" subagent, doing one job for the main agent. Only your final answer reaches it, so end with what you found or did.`,
          `Your instructions:\n${definition.prompt}`,
        ].join("\n\n"),
      history,
      tools: specs,
      root,
      approvals: ctx.approvals,
      budget: run.budget,
      signal: ctx.signal,
      conversationId: null,
      events: {
        onToolCall: (call, label) => run.events?.onToolCall?.(nested(call), label),
        onToolResult: (call, outcome) => run.events?.onToolResult?.(nested(call), outcome),
        onUsage: () => this.changed(),
      },
    });
    if (result.status === "done") return ok(result.text || `(${definition.name} finished without an answer)`);
    if (result.status === "stopped") return failure("The person stopped the run.");
    if (result.status === "error") return failure(`The subagent's model call failed: ${result.error instanceof Error ? result.error.message : String(result.error)}`);
    return failure(`The subagent ${definition.name} stopped: ${result.message ?? result.status}`);
  }

  /** The conversation's agent history, from this session, workspace state, or nothing. */
  private history(key: string): ChatMessage[] | null {
    const live = this.histories.get(key);
    if (live) return live;
    const stored = this.deps.state?.get<StoredRun>(`${RUNS_KEY}:${key}`);
    if (stored && Array.isArray(stored.messages)) {
      this.histories.set(key, stored.messages);
      return stored.messages;
    }
    return null;
  }

  hasHistory(conversationId: string): boolean {
    return this.history(conversationId) !== null;
  }

  /** The stored agent runs of this workspace, newest first, for `/resume`. */
  resumable(): { conversationId: string; title: string; updatedAt: string; root: string; messages: number }[] {
    const index = this.deps.state?.get<{ conversationId: string; title: string; updatedAt: string; root: string; messages: number }[]>(RUNS_KEY);
    return Array.isArray(index) ? index : [];
  }

  private async store(conversationId: string | null, root: string, prompt: string): Promise<void> {
    const state = this.deps.state;
    if (!state || !conversationId) return;
    const history = this.histories.get(conversationId);
    if (!history) return;
    // Workspace state is not a log: a long history keeps its newest part.
    let messages = history;
    while (messages.length > 2 && JSON.stringify(messages).length > MAX_STORED_CHARS) {
      const cut = Math.max(1, Math.floor(messages.length / 4));
      let at = cut;
      while (at < messages.length && messages[at]!.role === "tool") at += 1;
      messages = messages.slice(at);
    }
    const index = this.resumable().filter((r) => r.conversationId !== conversationId);
    const previous = state.get<StoredRun>(`${RUNS_KEY}:${conversationId}`);
    const title = previous?.title ?? prompt.split("\n", 1)[0]!.slice(0, 80);
    const row = { conversationId, title, updatedAt: new Date().toISOString(), root, messages: messages.length };
    const kept = [row, ...index].slice(0, MAX_STORED_RUNS);
    for (const dropped of [row, ...index].slice(MAX_STORED_RUNS)) await state.update(`${RUNS_KEY}:${dropped.conversationId}`, undefined);
    await state.update(`${RUNS_KEY}:${conversationId}`, { conversationId, title, root, updatedAt: row.updatedAt, messages } satisfies StoredRun);
    await state.update(RUNS_KEY, kept);
  }

  async run(request: RunRequest): Promise<RunSummary> {
    const root = this.root();
    const settings = this.deps.settings();
    const started = Date.now();
    const usage: AgentRunView = {
      startedAt: new Date(started).toISOString(),
      prompt: request.prompt.split("\n", 1)[0]!.slice(0, 80),
      status: "running",
      steps: 0,
      toolCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      tokens: 0,
      durationMs: 0,
    };
    if (!root) return { status: "error", text: "", error: new Error("No workspace folder is open."), usage: { ...usage, status: "error" } };
    const budget = newBudget(Math.max(1, settings.maxSteps), Math.max(1000, settings.maxTokens));
    this.budget = budget;
    this.running = true;
    this.status = "Working…";
    this.output = null;
    this.runs.unshift(usage);
    this.runs.splice(MAX_SESSION_RUNS);
    this.changed();
    const events = request.events;
    const sync = () => {
      usage.steps = budget.steps;
      usage.toolCalls = budget.toolCalls;
      usage.promptTokens = budget.promptTokens;
      usage.completionTokens = budget.completionTokens;
      usage.tokens = budget.tokens;
      usage.durationMs = Date.now() - started;
    };
    try {
      const { trusted } = this.deps.workspace();
      const project = await loadProjectContext(root.path, { trusted, userFile: nodePath.join(this.home(), ".matterwave", "MATTERWAVE.md") });
      this.contextFiles = project.files;
      this.contextNotice = project.notice;
      if (project.notice) events?.onNotice?.(project.notice);
      const instructions = await this.instructions();
      const shouldRouteEngine =
        settings.engine !== undefined ||
        settings.piBinaryPath !== undefined ||
        this.deps.probePiAvailable !== undefined;
      const activeEngine: "pi" | "builtin" = shouldRouteEngine
        ? await resolveAgentEngine({
            engine: settings.engine ?? "auto",
            piBinaryPath: settings.piBinaryPath,
            workspaceRoot: root.path,
            probeAvailable: this.deps.probePiAvailable,
          })
        : "builtin";

      if (activeEngine === "pi") {
        const prompt = await buildPromptContext(root.path, request.prompt, settings.editorContext ? (this.deps.editorContext?.() ?? null) : null);
        for (const note of prompt.notes) events?.onNotice?.(note);
        const key = request.conversationId ?? "local";
        let history = this.history(key);
        if (!history) {
          history = [...(request.seed ?? [])];
          this.histories.set(key, history);
        }
        history.push({ role: "user", content: prompt.content });
        this.status = "Working…";
        this.changed();
        const resolvedKey = (await this.deps.apiKey?.()) ?? "";
        const resolvedBaseUrl = this.deps.baseUrl?.() ?? this.deps.client.baseUrl ?? "https://app.matterwave.ai";
        const binaryPath = settings.piBinaryPath?.trim() || "pi";
        const piBackend = new PiAgentBackend({
          binaryPath,
          args: this.deps.piArgs,
          workspaceRoot: root.path,
          apiKey: resolvedKey,
          baseUrl: resolvedBaseUrl,
          probeAvailable: () => Promise.resolve(true),
          onDelta: (delta) => {
            events?.onText?.(delta);
          },
          onToolStart: (evt) => {
            budget.toolCalls += 1;
            const call: ToolCall = {
              id: evt.toolCallId,
              type: "function",
              function: { name: evt.toolName, arguments: JSON.stringify(evt.args ?? {}) },
            };
            const label =
              typeof evt.args?.path === "string"
                ? evt.args.path
                : typeof evt.args?.command === "string"
                  ? evt.args.command
                  : "";
            this.status = `${evt.toolName}${label ? ` ${label.split("\n", 1)[0]!.slice(0, 80)}` : ""}`;
            this.output = null;
            this.deps.log?.(`[${evt.toolName}] ${label}`);
            events?.onToolCall?.(call, label);
            sync();
            this.changed();
          },
          onToolUpdate: (evt) => {
            if (evt.delta) {
              this.output = ((this.output ?? "") + evt.delta).slice(-MAX_OUTPUT_TAIL);
              this.deps.log?.(evt.delta.replace(/\n$/, ""));
              this.changedSoon();
            }
          },
          onToolEnd: (evt) => {
            const call: ToolCall = {
              id: evt.toolCallId,
              type: "function",
              function: { name: evt.toolName, arguments: "{}" },
            };
            const content = typeof evt.result === "string" ? evt.result : JSON.stringify(evt.result ?? "");
            events?.onToolResult?.(call, { content, isError: evt.isError });
            sync();
            this.changed();
          },
        });
        try {
          const done = await piBackend.prompt(prompt.content, { signal: request.signal });
          budget.steps += 1;
          budget.promptTokens += Math.ceil(prompt.content.length / 4);
          budget.completionTokens += Math.ceil(done.text.length / 4);
          budget.tokens = budget.promptTokens + budget.completionTokens;
          if (done.text) {
            history.push({ role: "assistant", content: done.text });
          }
          const status: LoopStatus = done.aborted || request.signal.aborted ? "stopped" : "done";
          sync();
          usage.status = status;
          await this.store(request.conversationId, root.path, request.prompt);
          return { status, text: done.text, usage };
        } finally {
          await piBackend.dispose();
        }
      }

      const specs = await this.specs(root.path, settings, trusted, { budget, model: request.model?.id, events });
      const prompt = await buildPromptContext(root.path, request.prompt, settings.editorContext ? (this.deps.editorContext?.() ?? null) : null);
      for (const note of prompt.notes) events?.onNotice?.(note);
      const key = request.conversationId ?? "local";
      let history = this.history(key);
      if (!history) {
        history = [...(request.seed ?? [])];
        this.histories.set(key, history);
      }
      history.push({ role: "user", content: prompt.content });
      this.status = "Working…";
      this.changed();
      const system = (mode: ModeName) => this.systemFor(mode, root.path, specs, project.contextFiles, instructions);
      const result = await runLoop({
        client: this.deps.client,
        model: request.model?.id,
        mode: () => this.currentMode,
        system,
        history,
        tools: specs,
        root: root.path,
        approvals: this.approvals(request.conversationId),
        budget,
        signal: request.signal,
        conversationId: request.conversationId,
        events: {
          onStep: () => {
            this.status = "Thinking…";
            this.output = null;
            this.changed();
          },
          onText: (text) => events?.onText?.(text),
          onToolCall: (call, label) => {
            this.status = `${call.function.name}${label ? ` ${label.split("\n", 1)[0]!.slice(0, 80)}` : ""}`;
            this.output = null;
            this.deps.log?.(`[${call.function.name}] ${label}`);
            events?.onToolCall?.(call, label);
            this.changed();
          },
          onToolOutput: (_call, text) => {
            this.output = ((this.output ?? "") + text).slice(-MAX_OUTPUT_TAIL);
            this.deps.log?.(text.replace(/\n$/, ""));
            this.changedSoon();
          },
          onToolResult: (call, outcome) => {
            events?.onToolResult?.(call, outcome);
            sync();
            this.changed();
          },
          onUsage: () => {
            sync();
            this.changed();
          },
        },
        beforeStep: async (messages, signal) => {
          const compacted = await compactHistory(
            messages,
            { contextWindow: request.model?.context_window ?? null },
            (older) => this.summarise(older, request, budget, signal),
            { system: system(this.currentMode) },
          );
          const note = compactionNote(compacted);
          if (note) events?.onNotice?.(note);
        },
      });
      sync();
      usage.status = result.status;
      await this.store(request.conversationId, root.path, request.prompt);
      return { status: result.status, text: result.text, ...(result.message ? { message: result.message } : {}), ...(result.error !== undefined ? { error: result.error } : {}), usage };
    } catch (error) {
      sync();
      usage.status = request.signal.aborted ? "stopped" : "error";
      return { status: usage.status, text: "", error, usage };
    } finally {
      this.running = false;
      this.status = null;
      this.output = null;
      this.pending = null;
      this.changed();
    }
  }

  /**
   * The summary that replaces older history: the conversation's own
   * compaction when the run is stored there, else a `/v1` call over the
   * older messages (its tokens count against the run).
   */
  private async summarise(older: ChatMessage[], request: RunRequest, budget: RunBudget, signal: AbortSignal): Promise<string | null> {
    this.status = "Summarising earlier steps…";
    this.changed();
    if (request.conversationId && this.deps.client.compact) {
      try {
        const message = await this.deps.client.compact(request.conversationId, request.model?.id);
        const text = message.parts.find((p) => p.type === "summary" && typeof p.text === "string")?.text;
        if (text?.trim()) return text;
      } catch {
        // Nothing the server could fold (or no route): summarise here instead.
      }
    }
    const window = request.model?.context_window ?? 64_000;
    const transcript = transcriptText(older);
    const room = Math.max(4_000, Math.floor(window * 0.6) * 4);
    const accumulator = new StepAccumulator();
    try {
      for await (const chunk of this.deps.client.chatCompletionsStream(
        {
          ...(request.model ? { model: request.model.id } : {}),
          messages: [
            { role: "system", content: SUMMARY_SYSTEM },
            { role: "user", content: transcript.length > room ? transcript.slice(-room) : transcript },
          ],
          stream_options: { include_usage: true },
        },
        signal,
      )) {
        accumulator.add(chunk);
      }
    } catch (error) {
      if (signal.aborted) throw error;
      return null;
    }
    const result = accumulator.result();
    budget.tokens += result.usage?.total_tokens ?? Math.ceil((transcript.length + result.text.length) / 4);
    return result.text || null;
  }

  /** `/compact` in agent mode: fold and summarise the conversation's agent history now. */
  async compactNow(conversationId: string | null, model: { id: string; context_window: number | null } | null, signal: AbortSignal): Promise<string> {
    const history = this.history(conversationId ?? "local");
    if (!history || history.length < 4) return "Nothing to compact yet: this conversation's agent history is short.";
    const budget = newBudget(1, Number.MAX_SAFE_INTEGER);
    const result = await compactHistory(
      history,
      { contextWindow: model?.context_window ?? null },
      (older) => this.summarise(older, { prompt: "", conversationId, model, signal }, budget, signal),
      { force: true },
    );
    this.status = null;
    if (conversationId) await this.store(conversationId, this.root()?.path ?? "", "");
    this.changed();
    return compactionNote(result) ?? "Nothing to compact: there is no old tool output to fold and nothing to summarise.";
  }

  /** `/context`: what the next step would carry, in a few lines. */
  async contextReport(conversationId: string | null, model: { id: string; label: string; context_window: number | null } | null): Promise<string> {
    const root = this.root();
    if (!root) return "No workspace folder is open.";
    const { trusted } = this.deps.workspace();
    const project = await loadProjectContext(root.path, { trusted, userFile: nodePath.join(this.home(), ".matterwave", "MATTERWAVE.md") });
    const history = this.history(conversationId ?? "local") ?? [];
    const system = systemPrompt(this.currentMode, root.path, { contextFiles: project.contextFiles });
    const tokens = estimateTokens(history) + Math.ceil(system.length / 4);
    const window = model?.context_window ?? null;
    const lines = [
      `Agent context for ${model?.label ?? "the default model"}: about ${tokens.toLocaleString("en-US")} tokens${window ? ` of ${window.toLocaleString("en-US")} (${Math.round((tokens / window) * 100)}%)` : ""}.`,
      `Mode ${this.currentMode}; root ${root.path}.`,
      `History: ${history.length} messages (${history.filter((m) => m.role === "tool").length} tool results).`,
      project.files.length > 0 ? `Notes loaded: ${project.files.join(", ")}.` : "No MATTERWAVE.md or AGENTS.md loaded.",
      ...(project.notice ? [project.notice] : []),
      ...(this.deps.mcp ? this.deps.mcp.status().map((s) => `MCP ${s.name}: ${s.state}, ${s.tools} tools${s.hidden ? ` (${s.hidden} kept back by its allow-list)` : ""}${s.error ? ` — ${s.error}` : ""}.`) : []),
    ];
    return lines.join("\n");
  }

  /** The prompt `/init` sends: draft (or improve) the workspace's MATTERWAVE.md. */
  async initPrompt(): Promise<string> {
    const root = this.root();
    let existing: string | null = null;
    if (root) {
      try {
        existing = await readFile(nodePath.join(root.path, "MATTERWAVE.md"), "utf8");
      } catch {
        existing = null;
      }
    }
    return initPrompt(existing);
  }

  /** Custom commands (`.matterwave/commands/*.md`) for this workspace and the person. */
  async customCommands(): Promise<CustomCommand[]> {
    const root = this.root();
    return loadCustomCommands(definitionDirs("commands", root?.path ?? null, this.deps.workspace().trusted, this.home()));
  }

  async subagents(): Promise<SubagentDefinition[]> {
    const root = this.root();
    return loadSubagents(definitionDirs("agents", root?.path ?? null, this.deps.workspace().trusted, this.home()));
  }

  // --- the view -------------------------------------------------------------------

  private changed(): void {
    clearTimeout(this.soon);
    this.soon = undefined;
    this.deps.onChange();
  }

  /** A change worth showing but not worth a state post per chunk: a command's output, at most four times a second. */
  private changedSoon(): void {
    if (this.soon !== undefined) return;
    this.soon = setTimeout(() => this.changed(), 250);
  }

  snapshot(availability: { available: boolean; reason: string | null }): AgentView {
    const root = this.root();
    const mcp: AgentMcpView[] = this.deps.mcp?.status() ?? [];
    const pending = this.pending
      ? { id: this.pending.id, kind: this.pending.kind, tool: this.pending.tool, title: this.pending.title, detail: this.pending.detail, path: this.pending.path, diff: this.pending.diff }
      : null;
    return {
      enabled: this.enabledFlag,
      available: availability.available,
      reason: availability.reason,
      mode: this.currentMode,
      modes: this.modes(),
      modeSummary: MODES_BY_NAME[this.currentMode].summary,
      root,
      multiRoot: this.deps.workspace().roots.length > 1,
      running: this.running,
      status: this.status,
      output: this.output,
      pending,
      todos: this.todos.map((t) => ({ ...t })),
      contextFiles: [...this.contextFiles],
      contextNotice: this.contextNotice,
      mcp,
      steps: this.budget?.steps ?? 0,
      maxSteps: this.budget?.maxSteps ?? this.deps.settings().maxSteps,
      tokens: this.budget?.tokens ?? 0,
      maxTokens: this.budget?.maxTokens ?? this.deps.settings().maxTokens,
      runs: this.runs.map((r) => ({ ...r })),
    };
  }
}

/** Code points that change how a command reads without being seen: controls, bidi overrides and isolates, zero-width and tag characters. */
const INVISIBLE: readonly (readonly [number, number])[] = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x61c, 0x61c],
  [0x115f, 0x1160],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff9, 0xfffb],
  [0xe0000, 0xe007f],
  [0xe0100, 0xe01ef],
];

/**
 * `text` with every invisible code point written out as `<U+202E>`, so what
 * the approval card shows is what runs. Tabs and line breaks stay as they
 * are; a carriage return not followed by a line feed is shown.
 */
export function revealInvisible(text: string): string {
  let out = "";
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    const code = c.codePointAt(0)!;
    const hidden = INVISIBLE.some(([lo, hi]) => code >= lo && code <= hi) || (code === 0x0d && chars[i + 1] !== "\n");
    out += hidden ? `<U+${code.toString(16).toUpperCase().padStart(4, "0")}>` : c;
  }
  return out;
}

function compactionNote(result: CompactionResult): string | null {
  if (result.summarised) {
    return `Earlier steps were summarised to fit the context window (about ${result.tokensBefore.toLocaleString("en-US")} → ${result.tokensAfter.toLocaleString("en-US")} tokens).`;
  }
  if (result.folded > 0) {
    return `Older tool output was folded to save context (${result.folded} result${result.folded === 1 ? "" : "s"}; about ${result.tokensBefore.toLocaleString("en-US")} → ${result.tokensAfter.toLocaleString("en-US")} tokens).`;
  }
  return null;
}

export interface ResolveAgentEngineOptions {
  engine?: AgentEngine;
  piBinaryPath?: string;
  workspaceRoot?: string;
  env?: NodeJS.ProcessEnv;
  probeAvailable?: (binaryPath: string) => Promise<boolean>;
}

/**
 * Resolve which agent execution engine (`"pi"` or `"builtin"`) to use:
 * - `"builtin"` always selects the built-in loop without probing `pi`.
 * - `"pi"` requires Pi 1.0 (`isPiAvailable(piBinaryPath)` must return `true`, otherwise throws).
 * - `"auto"` (default) uses Pi 1.0 when `await isPiAvailable(piBinaryPath)` is `true` and falls back to `"builtin"` otherwise.
 */
export async function resolveAgentEngine(options: ResolveAgentEngineOptions = {}): Promise<"pi" | "builtin"> {
  const mode: AgentEngine = options.engine ?? "auto";
  if (mode === "builtin") {
    return "builtin";
  }
  const binaryPath = options.piBinaryPath?.trim() || "pi";
  const available = options.probeAvailable
    ? await options.probeAvailable(binaryPath)
    : await isPiAvailable(binaryPath, { cwd: options.workspaceRoot, env: options.env });
  if (mode === "pi") {
    if (!available) {
      throw new Error(`Pi 1.0 binary "${binaryPath}" was not found on PATH (required when matterwave.agent.engine is "pi").`);
    }
    return "pi";
  }
  return available ? "pi" : "builtin";
}

export interface CreateAgentRunnerOptions extends Omit<PiAgentBackendOptions, "binaryPath" | "fallbackLoop" | "probeAvailable"> {
  engine?: AgentEngine;
  piBinaryPath?: string;
  binaryPath?: string;
  probeAvailable?: (binaryPath: string) => Promise<boolean>;
  fallbackLoop?: PiFallbackRunner;
}

export interface AgentRunner {
  readonly engine: AgentEngine;
  readonly piBinaryPath: string;
  resolveEngine(): Promise<"pi" | "builtin">;
  prompt(text: string, options?: PiPromptOptions): Promise<PiDoneEvent>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Create an agent runner that routes turns according to `engine` (`"auto"`, `"pi"`, or `"builtin"`)
 * and `piBinaryPath`:
 * - `"auto"` delegates to `PiAgentBackend` when `isPiAvailable(piBinaryPath)` is true, falling back to `fallbackLoop` otherwise.
 * - `"pi"` requires `PiAgentBackend` (fails when `pi` is not available, never falling back).
 * - `"builtin"` always runs the built-in `fallbackLoop` without spawning `pi`.
 */
export function createAgentRunner(options: CreateAgentRunnerOptions): AgentRunner {
  const engine: AgentEngine = options.engine ?? "auto";
  const piBinaryPath = options.piBinaryPath?.trim() || options.binaryPath?.trim() || "pi";
  const probe = options.probeAvailable
    ? () => options.probeAvailable!(piBinaryPath)
    : () => isPiAvailable(piBinaryPath, { cwd: options.workspaceRoot, env: options.env });

  const backend = new PiAgentBackend({
    ...options,
    binaryPath: piBinaryPath,
    probeAvailable: probe,
    fallbackLoop: engine === "auto" ? options.fallbackLoop : undefined,
  });

  return {
    engine,
    piBinaryPath,
    resolveEngine: () =>
      resolveAgentEngine({
        engine,
        piBinaryPath,
        workspaceRoot: options.workspaceRoot,
        env: options.env,
        probeAvailable: options.probeAvailable,
      }),
    async prompt(text: string, promptOptions?: PiPromptOptions): Promise<PiDoneEvent> {
      if (engine === "builtin") {
        if (!options.fallbackLoop) {
          throw new Error("Built-in agent loop runner is required when engine is \"builtin\".");
        }
        const callbacks: PiBackendCallbacks = {
          onDelta: promptOptions?.callbacks?.onDelta ?? options.onDelta,
          onToolStart: promptOptions?.callbacks?.onToolStart ?? options.onToolStart,
          onToolUpdate: promptOptions?.callbacks?.onToolUpdate ?? options.onToolUpdate,
          onToolEnd: promptOptions?.callbacks?.onToolEnd ?? options.onToolEnd,
          onDone: promptOptions?.callbacks?.onDone ?? options.onDone,
          onError: promptOptions?.callbacks?.onError ?? options.onError,
        };
        let accumulated = "";
        const wrappedCallbacks: PiBackendCallbacks = {
          ...callbacks,
          onDelta: (delta) => {
            accumulated += delta;
            callbacks.onDelta?.(delta);
          },
        };
        const res = await options.fallbackLoop(text, wrappedCallbacks, promptOptions);
        const doneEvent: PiDoneEvent =
          res && typeof res === "object" && "text" in res
            ? { ...res, usedFallback: true }
            : {
                text: typeof res === "string" ? res : accumulated,
                toolCalls: [],
                usedFallback: true,
              };
        callbacks.onDone?.(doneEvent);
        return doneEvent;
      }
      return backend.prompt(text, promptOptions);
    },
    abort: () => backend.abort(),
    dispose: () => backend.dispose(),
  };
}
