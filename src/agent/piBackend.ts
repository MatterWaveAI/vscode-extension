import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";

import { localAgentToolsOf, type ToolsVerdict } from "../lib/matterwaveClient";
import {
  confine,
  DEFAULT_DENY,
  DenyList,
  loadDenyList,
  PathRefusedError,
} from "../lib/sdk/agent/node";
import { childEnv } from "./env";
import { killTree } from "./shell";

export interface PiToolStartEvent {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  parentToolCallId?: string;
}

export interface PiToolUpdateEvent {
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
  partialResult?: unknown;
  delta?: string;
}

export interface PiToolEndEvent {
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
}

export interface PiToolExecutionRecord {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  updates: PiToolUpdateEvent[];
  result?: unknown;
  isError?: boolean;
}

export interface PiDoneEvent {
  text: string;
  messages?: unknown[];
  toolCalls: PiToolExecutionRecord[];
  aborted?: boolean;
  usedFallback?: boolean;
}

export interface PiBackendCallbacks {
  onDelta?: (delta: string) => void;
  onToolStart?: (event: PiToolStartEvent) => void;
  onToolUpdate?: (event: PiToolUpdateEvent) => void;
  onToolEnd?: (event: PiToolEndEvent) => void;
  onDone?: (event: PiDoneEvent) => void;
  onError?: (error: Error) => void;
}

export interface AgentAvailability {
  available: boolean;
  reason?: string | null;
}

export interface AgentCapabilityPolicy {
  local_agent_tools?: boolean | ToolsVerdict | null;
}

export interface PiPolicyContext {
  signedIn?: boolean;
  trusted?: boolean;
  workspaceRoot?: string;
  localAgentTools?: ToolsVerdict | boolean | null;
  policy?: AgentCapabilityPolicy | null;
  model?: {
    id?: string;
    label?: string;
    tools?: ToolsVerdict | boolean | null;
    supports_tools?: boolean | null;
  } | null;
}

export type PiAvailabilitySource =
  | AgentAvailability
  | PiPolicyContext
  | (() => AgentAvailability | PiPolicyContext);

export interface PiRpcProcessOptions {
  /** Path or name of the Pi binary. Defaults to `"pi"`. */
  binaryPath?: string;
  /** Arguments passed to the Pi binary. Defaults to `["--mode", "rpc"]`. */
  args?: string[];
  /** Workspace root directory where Pi RPC runs. */
  workspaceRoot: string;
  /** MatterWave API key or bearer token injected as `MATTERWAVE_API_KEY`. */
  apiKey: string;
  /** MatterWave API base URL injected as `MATTERWAVE_BASE_URL`. */
  baseUrl: string;
  /** Optional MatterWave preset ID injected as `MATTERWAVE_PRESET_ID`. */
  presetId?: string;
  /** Base process environment (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Request timeout in milliseconds for control commands (defaults to 30_000). */
  commandTimeoutMs?: number;
}

export interface PiPromptOptions {
  signal?: AbortSignal;
  streamingBehavior?: "steer" | "followUp";
  images?: unknown[];
  callbacks?: PiBackendCallbacks;
  /** Optional pre-flight tool calls or approvals to validate against the `.env`/secret deny-list. */
  toolApprovals?: Array<{ toolName: string; args: Record<string, unknown> }>;
}

export type PiFallbackRunner = (
  prompt: string,
  callbacks: PiBackendCallbacks,
  options?: PiPromptOptions,
) => Promise<PiDoneEvent | string | void>;

export interface PiAgentBackendOptions extends PiRpcProcessOptions, PiBackendCallbacks {
  /** MatterWave org/workspace availability policy check. */
  agentAvailability?: PiAvailabilitySource;
  /** Optional custom probe override for testing. */
  probeAvailable?: () => Promise<boolean>;
  /** Built-in agent loop fallback invoked automatically when the `pi` binary is not installed. */
  fallbackLoop?: PiFallbackRunner;
  /** Optional additional deny-list globs on top of `.gitignore` / `.ignore` / `DEFAULT_DENY`. */
  extraDenyGlobs?: readonly string[];
}

export interface PiRpcResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export type PiRpcEvent = Record<string, unknown> & { type: string };

interface PendingRequest {
  command: string;
  resolve: (response: PiRpcResponse) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

/**
 * Probe whether the `pi` CLI binary is installed and runnable on `PATH`
 * (or at the configured `binaryPath`).
 */
export async function isPiAvailable(
  binaryPath = "pi",
  options?: { args?: string[]; env?: NodeJS.ProcessEnv; timeoutMs?: number; cwd?: string },
): Promise<boolean> {
  if (!binaryPath || !binaryPath.trim()) {
    return false;
  }
  const probeArgs = options?.args ?? ["--version"];
  const timeoutMs = options?.timeoutMs ?? 3000;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binaryPath, probeArgs, {
        cwd: options?.cwd,
        env: options?.env ? childEnv(options.env) : childEnv(process.env),
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      finish(false);
      return;
    }

    const timer = setTimeout(() => {
      killTree(child);
      finish(false);
    }, timeoutMs);

    child.on("error", () => {
      finish(false);
    });

    child.on("close", (code) => {
      finish(code === 0);
    });
  });
}

function normalizeVerdict(val: ToolsVerdict | boolean | null | undefined): ToolsVerdict {
  if (val === false || val === "no") return "no";
  if (val === true || val === "yes") return "yes";
  return "unknown";
}

/**
 * Evaluate MatterWave org and workspace policy (`agentAvailability`) before
 * starting or forwarding prompts to Pi.
 */
export function resolveAgentAvailability(
  source?: PiAvailabilitySource,
  workspaceRoot?: string,
): AgentAvailability {
  if (!source) {
    if (!workspaceRoot) {
      return { available: false, reason: "Open a folder to use Agent Mode." };
    }
    return { available: true, reason: null };
  }

  const resolved = typeof source === "function" ? source() : source;
  if ("available" in resolved && typeof resolved.available === "boolean") {
    return resolved;
  }

  const ctx = resolved as PiPolicyContext;
  if (ctx.signedIn === false) {
    return { available: false, reason: "Sign in to MatterWave to use Agent Mode." };
  }
  if (ctx.trusted === false) {
    return { available: false, reason: "Agent Mode is disabled in untrusted workspaces." };
  }
  const root = ctx.workspaceRoot ?? workspaceRoot;
  if (!root) {
    return { available: false, reason: "Open a folder to use Agent Mode." };
  }

  const directLocal = normalizeVerdict(ctx.localAgentTools);
  const policyRaw = ctx.policy?.local_agent_tools;
  const policyLocal =
    typeof policyRaw === "boolean" || policyRaw === null || policyRaw === undefined
      ? localAgentToolsOf(ctx.policy ? { local_agent_tools: policyRaw } : null)
      : normalizeVerdict(policyRaw);

  if (directLocal === "no" || policyLocal === "no") {
    return { available: false, reason: "Your organization has disabled local agent tools." };
  }

  if (ctx.model) {
    const modelVerdict =
      ctx.model.tools !== undefined
        ? normalizeVerdict(ctx.model.tools)
        : normalizeVerdict(ctx.model.supports_tools);
    if (modelVerdict === "no") {
      return {
        available: false,
        reason: `${ctx.model.label ?? ctx.model.id ?? "This model"} does not support tool calling.`,
      };
    }
  }

  return { available: true, reason: null };
}

const SECRET_TOKEN_PATTERNS: readonly RegExp[] = [
  /(?:^|[\s"'`=:/\\])\.env(?:\.[A-Za-z0-9._-]+)?(?:$|[\s"'`:;])/i,
  /(?:^|[\s"'`=:/\\])id_(?:rsa|ed25519|ecdsa|dsa)(?:$|[\s"'`:;])/i,
  /(?:^|[\s"'`=:/\\])[A-Za-z0-9._-]+\.(?:pem|key)(?:$|[\s"'`:;])/i,
];

function safeLoadDenyList(workspaceRoot: string, extra?: readonly string[]): DenyList {
  try {
    const base = loadDenyList(workspaceRoot);
    return extra && extra.length > 0 ? new DenyList([...base.patterns, ...extra]) : base;
  } catch {
    return new DenyList([...DEFAULT_DENY, ...(extra ?? [])]);
  }
}

function checkTargetSync(
  workspaceRoot: string,
  candidatePath: string,
  deny: DenyList,
): { denied: boolean; reason?: string } {
  const trimmed = candidatePath.trim();
  if (!trimmed) {
    return { denied: false };
  }
  if (trimmed.includes("\0")) {
    return { denied: true, reason: "Path contains a null byte." };
  }

  const normalizedInput = trimmed.replace(/\\/g, "/").replace(/^\.\//, "");
  const baseName = path.posix.basename(normalizedInput);
  if (deny.matches(normalizedInput) || deny.matches(baseName)) {
    return {
      denied: true,
      reason: `Access to "${candidatePath}" is blocked by the MatterWave .env/secret deny-list.`,
    };
  }

  try {
    confine(workspaceRoot, trimmed, { deny });
  } catch (err) {
    if (err instanceof PathRefusedError) {
      return {
        denied: true,
        reason: `Access to "${candidatePath}" is refused (${err.reason}): ${err.message}`,
      };
    }
    throw err;
  }

  let realRoot = path.resolve(workspaceRoot);
  try {
    realRoot = fs.realpathSync(realRoot);
  } catch {
    // Use resolved path if workspaceRoot does not exist on disk yet
  }

  const joined = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(realRoot, trimmed);
  let realTarget = joined;
  try {
    realTarget = fs.realpathSync(joined);
  } catch {
    // Target may not exist yet (e.g. write/edit new file)
  }

  const rel = path.relative(realRoot, realTarget);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return {
      denied: true,
      reason: `Access to "${candidatePath}" is refused (outside_root): escapes workspace root.`,
    };
  }

  const relPosix = rel.split(path.sep).join("/");
  if (relPosix && (deny.matches(relPosix) || deny.matches(path.posix.basename(relPosix)))) {
    return {
      denied: true,
      reason: `Access to "${candidatePath}" is blocked by the MatterWave .env/secret deny-list.`,
    };
  }

  return { denied: false };
}

/**
 * Check whether a file path references a denied `.env` or secret file
 * or escapes the workspace root.
 */
export async function checkSecretOrDeniedTarget(
  workspaceRoot: string,
  candidatePath: string,
  denyList?: DenyList,
): Promise<{ denied: boolean; reason?: string }> {
  const deny = denyList ?? safeLoadDenyList(workspaceRoot);
  const syncResult = checkTargetSync(workspaceRoot, candidatePath, deny);
  if (syncResult.denied) {
    return syncResult;
  }

  try {
    confine(workspaceRoot, candidatePath.trim(), { deny });
  } catch (err) {
    if (err instanceof PathRefusedError) {
      return {
        denied: true,
        reason: `Access to "${candidatePath}" is refused (${err.reason}): ${err.message}`,
      };
    }
    throw err;
  }

  return { denied: false };
}

/**
 * Synchronously inspect a prompt or tool invocation (`read`, `edit`, `write`, `bash`, etc.)
 * against a preloaded workspace `DenyList`.
 */
export function enforceDenyListSync(
  workspaceRoot: string,
  input: { prompt?: string; toolName?: string; args?: Record<string, unknown> },
  deny: DenyList,
): void {
  if (input.args) {
    const pathKeys = ["path", "file_path", "filePath", "target", "cwd"];
    for (const key of pathKeys) {
      const val = input.args[key];
      if (typeof val === "string" && val.trim()) {
        const res = checkTargetSync(workspaceRoot, val, deny);
        if (res.denied) {
          throw new Error(res.reason ?? `Access to "${val}" is denied.`);
        }
      }
    }

    const cmd = input.args.command ?? input.args.cmd;
    if (typeof cmd === "string" && cmd.trim()) {
      for (const pattern of SECRET_TOKEN_PATTERNS) {
        if (pattern.test(cmd)) {
          throw new Error(
            `Tool "${input.toolName ?? "bash"}" command references a protected .env or secret file and was blocked by policy.`,
          );
        }
      }
    }
  }

  if (typeof input.prompt === "string" && input.prompt.trim()) {
    for (const pattern of SECRET_TOKEN_PATTERNS) {
      if (pattern.test(input.prompt)) {
        const actionPattern = /\b(read|cat|print|dump|show|open|edit|write|exfiltrate|type|get-content)\b/i;
        if (actionPattern.test(input.prompt)) {
          throw new Error(
            "Prompt references a protected .env or secret file and was blocked by the MatterWave secret deny-list.",
          );
        }
      }
    }
  }
}

/**
 * Inspect a prompt or tool invocation (`read`, `edit`, `write`, `bash`, etc.)
 * against the workspace `.env`/secret deny-list.
 */
export async function enforceDenyListOnToolOrPrompt(
  workspaceRoot: string,
  input: { prompt?: string; toolName?: string; args?: Record<string, unknown> },
  denyList?: DenyList,
): Promise<void> {
  const deny = denyList ?? safeLoadDenyList(workspaceRoot);
  enforceDenyListSync(workspaceRoot, input, deny);
}

/**
 * Low-level JSONL `stdin`/`stdout` RPC process wrapper for `pi --mode rpc`.
 */
export class PiRpcProcess {
  private readonly options: PiRpcProcessOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly decoder = new StringDecoder("utf8");
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private nextReqId = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventListeners = new Set<(event: PiRpcEvent) => void>();
  private readonly exitListeners = new Set<(code: number | null, error?: Error) => void>();

  constructor(options: PiRpcProcessOptions) {
    this.options = options;
  }

  get isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get stderr(): string {
    return this.stderrBuffer;
  }

  /**
   * Build the sanitized child environment with `MATTERWAVE_API_KEY`,
   * `MATTERWAVE_BASE_URL`, and optional `MATTERWAVE_PRESET_ID` injected.
   */
  buildEnv(): NodeJS.ProcessEnv {
    const extra: Record<string, string> = {
      MATTERWAVE_API_KEY: this.options.apiKey,
      MATTERWAVE_BASE_URL: this.options.baseUrl,
    };
    if (this.options.presetId) {
      extra.MATTERWAVE_PRESET_ID = this.options.presetId;
    }
    return childEnv(this.options.env ?? process.env, extra);
  }

  /**
   * Spawn the `pi --mode rpc` child process in `workspaceRoot`.
   */
  start(): void {
    if (this.isRunning) {
      return;
    }

    const binary = this.options.binaryPath ?? "pi";
    const args = this.options.args ?? ["--mode", "rpc"];
    const env = this.buildEnv();

    const child = spawn(binary, args, {
      cwd: this.options.workspaceRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.child = child;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";

    child.stdout.on("data", (chunk: Buffer) => {
      this.handleStdoutChunk(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBuffer += chunk.toString("utf8");
      if (this.stderrBuffer.length > 16_384) {
        this.stderrBuffer = this.stderrBuffer.slice(-16_384);
      }
    });

    child.on("error", (err) => {
      this.rejectAllPending(err);
      for (const listener of this.exitListeners) {
        listener(null, err);
      }
    });

    child.on("close", (code) => {
      const remaining = this.decoder.end();
      if (remaining) {
        this.stdoutBuffer += remaining;
      }
      this.flushStdoutLines(true);
      this.child = null;
      const err = new Error(
        `Pi RPC process exited with code ${code ?? "null"}${this.stderrBuffer.trim() ? `: ${this.stderrBuffer.trim()}` : ""}`,
      );
      this.rejectAllPending(err);
      for (const listener of this.exitListeners) {
        listener(code);
      }
    });
  }

  onEvent(listener: (event: PiRpcEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  onExit(listener: (code: number | null, error?: Error) => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  /**
   * Write a raw JSONL message to `stdin` without waiting for a response.
   */
  writeLine(payload: Record<string, unknown>): void {
    if (!this.child || !this.isRunning) {
      throw new Error("Pi RPC process is not running.");
    }
    const line = `${JSON.stringify(payload)}\n`;
    this.child.stdin.write(line);
  }

  /**
   * Send an RPC command and resolve when the matching `{ type: "response", id }` arrives.
   */
  async request(command: Record<string, unknown>, timeoutMs?: number): Promise<PiRpcResponse> {
    if (!this.child || !this.isRunning) {
      this.start();
    }
    const id = typeof command.id === "string" ? command.id : `req_${++this.nextReqId}`;
    const payload = { ...command, id };
    const cmdName = typeof command.type === "string" ? command.type : "unknown";
    const effectiveTimeout = timeoutMs ?? this.options.commandTimeoutMs ?? 30_000;

    return new Promise<PiRpcResponse>((resolve, reject) => {
      const pendingReq: PendingRequest = {
        command: cmdName,
        resolve,
        reject,
      };

      if (effectiveTimeout > 0) {
        pendingReq.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Pi RPC command "${cmdName}" timed out after ${effectiveTimeout}ms.`));
        }, effectiveTimeout);
      }

      this.pending.set(id, pendingReq);

      try {
        this.writeLine(payload);
      } catch (err) {
        if (pendingReq.timer) clearTimeout(pendingReq.timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Terminate the child process tree cleanly.
   */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      child.once("close", finish);
      try {
        child.stdin.end();
      } catch {
        // Ignore stdin close errors
      }
      killTree(child);
      const timer = setTimeout(finish, 1000);
    });
  }

  private handleStdoutChunk(chunk: Buffer): void {
    this.stdoutBuffer += this.decoder.write(chunk);
    this.flushStdoutLines(false);
  }

  private flushStdoutLines(flushRemainder: boolean): void {
    while (true) {
      const newlineIdx = this.stdoutBuffer.indexOf("\n");
      if (newlineIdx === -1) break;
      let line = this.stdoutBuffer.slice(0, newlineIdx);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      this.processJsonLine(line);
    }

    if (flushRemainder && this.stdoutBuffer.trim()) {
      let line = this.stdoutBuffer;
      this.stdoutBuffer = "";
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      this.processJsonLine(line);
    }
  }

  private processJsonLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== "object") return;
    const obj = parsed as Record<string, unknown>;

    if (obj.type === "response") {
      const resp = obj as unknown as PiRpcResponse;
      if (typeof resp.id === "string" && this.pending.has(resp.id)) {
        const req = this.pending.get(resp.id)!;
        this.pending.delete(resp.id);
        if (req.timer) clearTimeout(req.timer);
        if (resp.success === false) {
          req.reject(new Error(resp.error ?? `Pi RPC command "${resp.command}" failed.`));
        } else {
          req.resolve(resp);
        }
        return;
      }
      for (const [key, req] of this.pending.entries()) {
        if (req.command === resp.command) {
          this.pending.delete(key);
          if (req.timer) clearTimeout(req.timer);
          if (resp.success === false) {
            req.reject(new Error(resp.error ?? `Pi RPC command "${resp.command}" failed.`));
          } else {
            req.resolve(resp);
          }
          return;
        }
      }
    }

    if (typeof obj.type === "string") {
      for (const listener of this.eventListeners) {
        listener(obj as PiRpcEvent);
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [, req] of this.pending) {
      if (req.timer) clearTimeout(req.timer);
      req.reject(error);
    }
    this.pending.clear();
  }
}

/**
 * Pi 1.0 (`pi --mode rpc`) execution backend for the MatterWave VS Code extension.
 *
 * - Spawns `pi --mode rpc` in `workspaceRoot` with `MATTERWAVE_API_KEY`,
 *   `MATTERWAVE_BASE_URL`, and optional `MATTERWAVE_PRESET_ID`.
 * - Translates Pi 1.0 JSONL events (`message_update`, `tool_execution_start`,
 *   `tool_execution_update`, `tool_execution_end`, `agent_end`) into the
 *   extension's callbacks (`onDelta`, `onToolStart`, `onToolEnd`, `onDone`, `onError`).
 * - Enforces MatterWave org policy (`agentAvailability`) and `.env`/secret deny-list
 *   before forwarding prompts or tool approvals/executions.
 * - Probes `isPiAvailable()` and automatically falls back to the built-in loop
 *   when the `pi` binary is not installed on `PATH`.
 */
export class PiAgentBackend {
  private readonly options: PiAgentBackendOptions;
  private rpc: PiRpcProcess | null = null;
  private denyList: DenyList | null = null;
  private activeTurnCancel: (() => void) | null = null;
  private currentModelId: string | null = null;

  constructor(options: PiAgentBackendOptions) {
    this.options = options;
  }

  /**
   * Check whether the configured `pi` binary (default `"pi"`) is available on `PATH`.
   */
  async isPiAvailable(): Promise<boolean> {
    if (this.options.probeAvailable) {
      return this.options.probeAvailable();
    }
    return isPiAvailable(this.options.binaryPath ?? "pi", {
      cwd: this.options.workspaceRoot,
      env: this.options.env,
    });
  }

  /**
   * Validate a tool call or approval against the workspace `.env`/secret deny-list
   * and workspace root confinement.
   */
  async validateToolApproval(toolName: string, args: Record<string, unknown>): Promise<void> {
    const deny = this.getDenyList();
    await enforceDenyListOnToolOrPrompt(this.options.workspaceRoot, { toolName, args }, deny);
  }

  /**
   * Switch the active model in the Pi RPC session (`set_model`).
   * Accepts either `"provider/modelId"` or `"modelId"` (defaulting provider to `"matterwave"`).
   */
  async setModel(modelId: string, provider = "matterwave"): Promise<void> {
    const trimmed = modelId.trim();
    if (!trimmed) {
      throw new Error("Model ID must not be empty.");
    }
    let resolvedProvider = provider;
    let resolvedModel = trimmed;
    const slashIdx = trimmed.indexOf("/");
    if (slashIdx > 0) {
      resolvedProvider = trimmed.slice(0, slashIdx);
      resolvedModel = trimmed.slice(slashIdx + 1);
    }
    this.currentModelId = `${resolvedProvider}/${resolvedModel}`;

    const proc = this.ensureRpcProcess();
    await proc.request({
      type: "set_model",
      provider: resolvedProvider,
      modelId: resolvedModel,
    });
  }

  get modelId(): string | null {
    return this.currentModelId;
  }

  /**
   * Abort the active turn by sending `{ type: "abort" }` over RPC and resolving
   * the active turn cleanly.
   */
  async abort(): Promise<void> {
    if (this.rpc && this.rpc.isRunning) {
      try {
        this.rpc.writeLine({ type: "abort" });
      } catch {
        // Ignore write errors if process already exited
      }
    }
    if (this.activeTurnCancel) {
      this.activeTurnCancel();
    }
  }

  /**
   * Send a user prompt to `pi --mode rpc` (or fall back to the built-in loop if
   * `pi` is not installed on `PATH`) and stream events to the configured callbacks.
   */
  async prompt(text: string, options?: PiPromptOptions): Promise<PiDoneEvent> {
    const callbacks = this.mergeCallbacks(options?.callbacks);

    // 1. Enforce MatterWave org policy (agentAvailability) before forwarding prompts
    const availability = resolveAgentAvailability(
      this.options.agentAvailability,
      this.options.workspaceRoot,
    );
    if (!availability.available) {
      const policyError = new Error(availability.reason ?? "Agent Mode is disabled by organization policy.");
      callbacks.onError?.(policyError);
      throw policyError;
    }

    // 2. Enforce .env / secret deny-list on prompt and any pre-flight tool approvals
    const deny = this.getDenyList();
    try {
      await enforceDenyListOnToolOrPrompt(this.options.workspaceRoot, { prompt: text }, deny);
      if (options?.toolApprovals) {
        for (const approval of options.toolApprovals) {
          await enforceDenyListOnToolOrPrompt(
            this.options.workspaceRoot,
            { toolName: approval.toolName, args: approval.args },
            deny,
          );
        }
      }
    } catch (err) {
      const denyError = err instanceof Error ? err : new Error(String(err));
      callbacks.onError?.(denyError);
      throw denyError;
    }

    // 3. Check whether `pi` binary is available; fall back to built-in loop if not
    const available = await this.isPiAvailable();
    if (!available) {
      if (this.options.fallbackLoop) {
        return this.runFallback(text, callbacks, options);
      }
      const missingError = new Error(
        `Pi binary "${this.options.binaryPath ?? "pi"}" was not found on PATH and no fallback loop is configured.`,
      );
      callbacks.onError?.(missingError);
      throw missingError;
    }

    // 4. Execute turn over Pi 1.0 RPC
    const proc = this.ensureRpcProcess();
    if (!proc.isRunning) {
      proc.start();
    }

    let accumulatedText = "";
    const toolMap = new Map<string, PiToolExecutionRecord>();
    const toolOrder: PiToolExecutionRecord[] = [];
    let settled = false;

    return new Promise<PiDoneEvent>((resolve, reject) => {
      const cleanup = () => {
        offEvent();
        offExit();
        if (options?.signal) {
          options.signal.removeEventListener("abort", onSignalAbort);
        }
        if (this.activeTurnCancel === cancelTurn) {
          this.activeTurnCancel = null;
        }
      };

      const finishSuccess = (doneEvent: PiDoneEvent) => {
        if (settled) return;
        settled = true;
        cleanup();
        callbacks.onDone?.(doneEvent);
        resolve(doneEvent);
      };

      const finishError = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        callbacks.onError?.(err);
        reject(err);
      };

      const cancelTurn = () => {
        finishSuccess({
          text: accumulatedText,
          toolCalls: toolOrder,
          aborted: true,
        });
      };

      this.activeTurnCancel = cancelTurn;

      const onSignalAbort = () => {
        void this.abort();
      };

      if (options?.signal) {
        if (options.signal.aborted) {
          void this.abort();
          return;
        }
        options.signal.addEventListener("abort", onSignalAbort, { once: true });
      }

      const offExit = proc.onExit((code, err) => {
        if (settled) return;
        finishError(
          err ??
            new Error(
              `Pi RPC exited unexpectedly during turn (code ${code ?? "null"})${proc.stderr.trim() ? `: ${proc.stderr.trim()}` : ""}`,
            ),
        );
      });

      const offEvent = proc.onEvent((event) => {
        if (settled) return;
        this.handleRpcEvent(
          event,
          deny,
          proc,
          callbacks,
          (delta) => {
            accumulatedText += delta;
          },
          toolMap,
          toolOrder,
          (messages) => {
            finishSuccess({
              text: accumulatedText,
              messages,
              toolCalls: toolOrder,
            });
          },
          finishError,
        );
      });

      const promptCommand: Record<string, unknown> = {
        type: "prompt",
        message: text,
      };
      if (options?.images) {
        promptCommand.images = options.images;
      }
      if (options?.streamingBehavior) {
        promptCommand.streamingBehavior = options.streamingBehavior;
      }

      proc.request(promptCommand).catch((err) => {
        finishError(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  /**
   * Stop and dispose the underlying `PiRpcProcess`.
   */
  async dispose(): Promise<void> {
    if (this.activeTurnCancel) {
      this.activeTurnCancel();
      this.activeTurnCancel = null;
    }
    if (this.rpc) {
      const proc = this.rpc;
      this.rpc = null;
      await proc.stop();
    }
  }

  private ensureRpcProcess(): PiRpcProcess {
    if (!this.rpc) {
      this.rpc = new PiRpcProcess({
        binaryPath: this.options.binaryPath,
        args: this.options.args,
        workspaceRoot: this.options.workspaceRoot,
        apiKey: this.options.apiKey,
        baseUrl: this.options.baseUrl,
        presetId: this.options.presetId,
        env: this.options.env,
        commandTimeoutMs: this.options.commandTimeoutMs,
      });
    }
    return this.rpc;
  }

  private getDenyList(): DenyList {
    if (!this.denyList) {
      this.denyList = safeLoadDenyList(this.options.workspaceRoot, this.options.extraDenyGlobs);
    }
    return this.denyList;
  }

  private mergeCallbacks(override?: PiBackendCallbacks): PiBackendCallbacks {
    return {
      onDelta: override?.onDelta ?? this.options.onDelta,
      onToolStart: override?.onToolStart ?? this.options.onToolStart,
      onToolUpdate: override?.onToolUpdate ?? this.options.onToolUpdate,
      onToolEnd: override?.onToolEnd ?? this.options.onToolEnd,
      onDone: override?.onDone ?? this.options.onDone,
      onError: override?.onError ?? this.options.onError,
    };
  }

  private async runFallback(
    text: string,
    callbacks: PiBackendCallbacks,
    options?: PiPromptOptions,
  ): Promise<PiDoneEvent> {
    let accumulated = "";
    const wrappedCallbacks: PiBackendCallbacks = {
      ...callbacks,
      onDelta: (delta) => {
        accumulated += delta;
        callbacks.onDelta?.(delta);
      },
    };
    const res = await this.options.fallbackLoop!(text, wrappedCallbacks, options);
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

  private handleRpcEvent(
    event: PiRpcEvent,
    deny: DenyList,
    proc: PiRpcProcess,
    callbacks: PiBackendCallbacks,
    appendText: (delta: string) => void,
    toolMap: Map<string, PiToolExecutionRecord>,
    toolOrder: PiToolExecutionRecord[],
    onAgentEnd: (messages?: unknown[]) => void,
    onError: (err: Error) => void,
  ): void {
    switch (event.type) {
      case "message_update": {
        const delta = extractMessageDelta(event);
        if (delta) {
          appendText(delta);
          callbacks.onDelta?.(delta);
        }
        break;
      }

      case "tool_execution_start": {
        const toolCallId = String(event.toolCallId ?? event.id ?? `call_${toolOrder.length + 1}`);
        const toolName = String(event.toolName ?? event.name ?? "unknown");
        const args =
          event.args && typeof event.args === "object"
            ? (event.args as Record<string, unknown>)
            : event.input && typeof event.input === "object"
              ? (event.input as Record<string, unknown>)
              : {};
        const parentToolCallId =
          typeof event.parentToolCallId === "string" ? event.parentToolCallId : undefined;

        try {
          enforceDenyListSync(this.options.workspaceRoot, { toolName, args }, deny);
        } catch (err) {
          try {
            proc.writeLine({ type: "abort" });
          } catch {
            // ignore
          }
          onError(err instanceof Error ? err : new Error(String(err)));
          return;
        }

        const record: PiToolExecutionRecord = {
          toolCallId,
          toolName,
          args,
          updates: [],
        };
        toolMap.set(toolCallId, record);
        toolOrder.push(record);
        callbacks.onToolStart?.({
          toolCallId,
          toolName,
          args,
          parentToolCallId,
        });
        break;
      }

      case "tool_execution_update": {
        const toolCallId = String(event.toolCallId ?? event.id ?? "");
        const toolName = String(event.toolName ?? event.name ?? "unknown");
        const args =
          event.args && typeof event.args === "object"
            ? (event.args as Record<string, unknown>)
            : undefined;
        const partialResult = event.partialResult;
        const delta = extractToolUpdateDelta(event);

        const updateEvt: PiToolUpdateEvent = {
          toolCallId,
          toolName,
          args,
          partialResult,
          delta,
        };
        const record = toolMap.get(toolCallId);
        if (record) {
          record.updates.push(updateEvt);
        }
        callbacks.onToolUpdate?.(updateEvt);
        break;
      }

      case "tool_execution_end": {
        const toolCallId = String(event.toolCallId ?? event.id ?? "");
        const toolName = String(event.toolName ?? event.name ?? "unknown");
        const result = event.result;
        const isError = Boolean(event.isError);

        const record = toolMap.get(toolCallId);
        if (record) {
          record.result = result;
          record.isError = isError;
        }
        callbacks.onToolEnd?.({
          toolCallId,
          toolName,
          result,
          isError,
        });
        break;
      }

      case "extension_ui_request": {
        const reqId = typeof event.id === "string" ? event.id : undefined;
        const toolName = typeof event.toolName === "string" ? event.toolName : undefined;
        const args =
          event.args && typeof event.args === "object"
            ? (event.args as Record<string, unknown>)
            : undefined;
        if (reqId) {
          try {
            enforceDenyListSync(
              this.options.workspaceRoot,
              { toolName, args, prompt: typeof event.message === "string" ? event.message : undefined },
              deny,
            );
            proc.writeLine({ type: "extension_ui_response", id: reqId, confirmed: true });
          } catch (err) {
            proc.writeLine({ type: "extension_ui_response", id: reqId, confirmed: false, cancelled: true });
            onError(err instanceof Error ? err : new Error(String(err)));
          }
        }
        break;
      }

      case "agent_end": {
        if (event.willRetry === true) {
          break;
        }
        const messages = Array.isArray(event.messages) ? event.messages : undefined;
        onAgentEnd(messages);
        break;
      }

      case "error":
      case "turn_error": {
        const message =
          typeof event.error === "string"
            ? event.error
            : typeof event.message === "string"
              ? event.message
              : "Pi RPC reported an error.";
        onError(new Error(message));
        break;
      }

      default:
        break;
    }
  }
}

function extractMessageDelta(event: PiRpcEvent): string | undefined {
  const assistantEvt = event.assistantMessageEvent;
  if (assistantEvt && typeof assistantEvt === "object") {
    const ae = assistantEvt as Record<string, unknown>;
    if ((ae.type === "text_delta" || ae.type === undefined) && typeof ae.delta === "string") {
      return ae.delta;
    }
  }
  if (typeof event.delta === "string") {
    return event.delta;
  }
  if (typeof event.textDelta === "string") {
    return event.textDelta;
  }
  return undefined;
}

function extractToolUpdateDelta(event: PiRpcEvent): string | undefined {
  if (typeof event.delta === "string") {
    return event.delta;
  }
  const partial = event.partialResult;
  if (typeof partial === "string") {
    return partial;
  }
  if (partial && typeof partial === "object") {
    const obj = partial as Record<string, unknown>;
    if (typeof obj.delta === "string") return obj.delta;
    if (Array.isArray(obj.content)) {
      for (const item of obj.content) {
        if (item && typeof item === "object" && typeof (item as Record<string, unknown>).text === "string") {
          return (item as Record<string, unknown>).text as string;
        }
      }
    }
  }
  return undefined;
}
