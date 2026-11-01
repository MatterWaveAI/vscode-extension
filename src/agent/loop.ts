import { ApiError } from "../api/errors";
import { toolsForMode } from "../lib/sdk/agent/modes";
import type { ModeName } from "../lib/sdk/agent/types";
import { CONTRACT_TOOL_NAMES } from "./host";
import { failure, parseArguments, type Approvals, type ToolOutcome, type ToolSpec } from "./tools";
import { StepAccumulator, type ChatCompletionChunk, type ChatCompletionRequest, type ChatMessage, type StepResult, type Tool, type ToolCall } from "./wire";

/**
 * The agent loop: ask `/v1` for a step with the mode's tools, run the calls
 * it hands back (each through its approval), send the results, and go
 * again until the model answers without a call -- or Stop, a cap, or an
 * error ends it. The loop owns no state of its own: the history it appends
 * to and the budget it spends are the caller's, so a subagent's nested loop
 * counts against its parent's caps.
 */

export interface ModelClient {
  chatCompletionsStream(request: ChatCompletionRequest, signal?: AbortSignal): AsyncGenerator<ChatCompletionChunk>;
}

/** The run's caps and what has been spent against them; shared by a run and its subagents. */
export interface RunBudget {
  maxSteps: number;
  maxTokens: number;
  steps: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  toolCalls: number;
}

export function newBudget(maxSteps: number, maxTokens: number): RunBudget {
  return { maxSteps, maxTokens, steps: 0, tokens: 0, promptTokens: 0, completionTokens: 0, toolCalls: 0 };
}

export interface LoopEvents {
  onStep?(step: number): void;
  /** Answer text as it streams. */
  onText?(text: string): void;
  onToolCall?(call: ToolCall, label: string): void;
  onToolOutput?(call: ToolCall, text: string): void;
  onToolResult?(call: ToolCall, outcome: ToolOutcome): void;
  onUsage?(budget: RunBudget): void;
}

export interface LoopOptions {
  client: ModelClient;
  model?: string;
  /** Read before every step: Shift+Tab during a run changes the next step's tools and prompt. */
  mode: () => ModeName;
  system: (mode: ModeName) => string;
  /** Appended to as the run goes: assistant steps and tool results. */
  history: ChatMessage[];
  tools: ToolSpec[];
  root: string;
  approvals: Approvals;
  budget: RunBudget;
  signal: AbortSignal;
  conversationId?: string | null;
  events?: LoopEvents;
  /** Called before each step with the history about to be sent; may fold or summarise it in place. */
  beforeStep?: (history: ChatMessage[], signal: AbortSignal) => Promise<void>;
}

export type LoopStatus = "done" | "stopped" | "step_cap" | "token_cap" | "error";

export interface LoopResult {
  status: LoopStatus;
  /** The last answer text the model gave. */
  text: string;
  error?: unknown;
  /** The sentence to show for a cap. */
  message?: string;
}

/** The `tools` a step offers in `mode`: the contract's through the SDK's `toolsForMode`, then the extension's own that the mode does not deny. */
export function offeredTools(specs: readonly ToolSpec[], mode: ModeName): Tool[] {
  const local = new Set(specs.map((s) => s.name));
  const contract = toolsForMode(mode).filter((tool) => local.has(tool.function.name));
  const extra = specs.filter((s) => !CONTRACT_TOOL_NAMES.has(s.name) && s.decide(mode) !== "deny").map((s) => s.definition);
  return [...contract, ...extra];
}

/** A rough count for a message list when the server reports none: four characters a token. */
export function estimateTokens(messages: readonly ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += typeof m.content === "string" ? m.content.length : 0;
    if (m.role === "assistant") for (const call of m.tool_calls ?? []) chars += call.function.arguments.length + call.function.name.length;
  }
  return Math.ceil(chars / 4) + messages.length * 4;
}

export function capMessage(budget: RunBudget, which: "steps" | "tokens"): string {
  return which === "steps"
    ? `Stopped after ${budget.steps} model calls, this run's step cap (matterwave.agent.maxSteps). Send another message to carry on.`
    : `Stopped: this run used ${budget.tokens.toLocaleString("en-US")} tokens, past its cap of ${budget.maxTokens.toLocaleString("en-US")} (matterwave.agent.maxTokens). Send another message to carry on.`;
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}

async function step(options: LoopOptions, messages: ChatMessage[], tools: Tool[]): Promise<StepResult> {
  const accumulator = new StepAccumulator();
  const request: ChatCompletionRequest = {
    ...(options.model ? { model: options.model } : {}),
    messages,
    ...(tools.length > 0 ? { tools, tool_choice: "auto" as const } : {}),
    stream_options: { include_usage: true },
    ...(options.conversationId ? { metadata: { conversation_id: options.conversationId } } : {}),
  };
  for await (const chunk of options.client.chatCompletionsStream(request, options.signal)) {
    const text = accumulator.add(chunk);
    if (text) options.events?.onText?.(text);
  }
  return accumulator.result();
}

export async function runLoop(options: LoopOptions): Promise<LoopResult> {
  const { budget, history, signal, events } = options;
  const byName = new Map(options.tools.map((spec) => [spec.name, spec]));
  let lastText = "";
  for (;;) {
    if (signal.aborted) return { status: "stopped", text: lastText };
    if (budget.steps >= budget.maxSteps) return { status: "step_cap", text: lastText, message: capMessage(budget, "steps") };
    if (budget.tokens >= budget.maxTokens) return { status: "token_cap", text: lastText, message: capMessage(budget, "tokens") };
    const mode = options.mode();
    let result: StepResult;
    let sent: ChatMessage[];
    try {
      await options.beforeStep?.(history, signal);
      sent = [{ role: "system", content: options.system(mode) }, ...history];
      budget.steps += 1;
      events?.onStep?.(budget.steps);
      result = await step(options, sent, offeredTools(options.tools, mode));
    } catch (error) {
      if (isAbort(error, signal)) return { status: "stopped", text: lastText };
      return { status: "error", text: lastText, error };
    }
    // Usage when the server reports it; an estimate when it does not, so the
    // token cap still holds against a deployment that sends none.
    const prompt = result.usage?.prompt_tokens ?? estimateTokens(sent);
    const completion = result.usage?.completion_tokens ?? Math.ceil((result.text.length + JSON.stringify(result.toolCalls).length) / 4);
    budget.promptTokens += prompt;
    budget.completionTokens += completion;
    budget.tokens += result.usage?.total_tokens ?? prompt + completion;
    events?.onUsage?.(budget);
    if (result.text) lastText = result.text;
    history.push({
      role: "assistant",
      content: result.text || null,
      ...(result.toolCalls.length > 0 ? { tool_calls: result.toolCalls } : {}),
    });
    if (result.toolCalls.length === 0) return { status: "done", text: lastText };
    for (const call of result.toolCalls) {
      // A call Stop overtook still gets an answer, so the history stays a
      // valid exchange for the next run.
      const outcome = signal.aborted ? failure("Not run: the person stopped the run.") : await runTool(options, byName, call, mode);
      budget.toolCalls += 1;
      events?.onToolResult?.(call, outcome);
      history.push({ role: "tool", tool_call_id: call.id, content: outcome.content });
    }
    if (signal.aborted) return { status: "stopped", text: lastText };
    // The cap is checked again before the next step, with this step's spend in.
  }
}

async function runTool(options: LoopOptions, byName: Map<string, ToolSpec>, call: ToolCall, mode: ModeName): Promise<ToolOutcome> {
  const spec = byName.get(call.function.name);
  const args = parseArguments(call.function.arguments);
  const label = spec?.label && typeof args !== "string" ? spec.label(args) : "";
  options.events?.onToolCall?.(call, label);
  if (!spec) return failure(`There is no tool named "${call.function.name}". Use one of the tools you were given.`);
  if (typeof args === "string") return failure(args);
  const decision = spec.decide(mode);
  if (decision === "deny") return failure(`${spec.name} is not available in ${mode} mode.`);
  try {
    return await spec.run(args, decision, {
      root: options.root,
      mode,
      signal: options.signal,
      approvals: options.approvals,
      call,
      onOutput: (text) => options.events?.onToolOutput?.(call, text),
    });
  } catch (error) {
    if (isAbort(error, options.signal)) return failure("Not finished: the person stopped the run.");
    if (error instanceof ApiError) return failure(`The tool failed: ${error.detail}`);
    return failure(`The tool failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
