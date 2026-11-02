import type { Tool } from "../lib/sdk/types";

/**
 * The `/v1/chat/completions` shapes the coding agent speaks: OpenAI's, as
 * MatterWave's `/v1` relays them. The server passes `tools` to the model and
 * hands back `tool_calls` unexecuted; the agent runs them here and answers
 * each with a `tool` message.
 */

export type { Tool };

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  tools?: Tool[];
  tool_choice?: "auto" | "none";
  stream_options?: { include_usage: boolean };
  /** `conversation_id` records the run into that conversation on the server. */
  metadata?: { conversation_id: string };
  max_tokens?: number;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** One `chat.completion.chunk`; with `include_usage` the last carries `usage` and no choices. */
export interface ChatCompletionChunk {
  id?: string;
  choices?: {
    index: number;
    delta?: {
      role?: string;
      content?: string | null;
      tool_calls?: { index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: Usage | null;
}

/** What one streamed step came to: its words, its calls in order, why it ended and what it cost. */
export interface StepResult {
  text: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: Usage | null;
}

/**
 * Folds a step's chunks into its result as they arrive. Tool calls stream
 * as fragments keyed by `index`: the first names the call and its id, the
 * rest append to its arguments.
 */
export class StepAccumulator {
  private text = "";
  private readonly calls = new Map<number, { id: string; name: string; arguments: string }>();
  private finishReason: string | null = null;
  private usage: Usage | null = null;

  /** Feed one chunk; returns the answer text it added, for streaming to the view. */
  add(chunk: ChatCompletionChunk): string {
    if (chunk.usage) this.usage = chunk.usage;
    let added = "";
    for (const choice of chunk.choices ?? []) {
      if (choice.index !== 0 && choice.index !== undefined) continue;
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string" && delta.content) {
        this.text += delta.content;
        added += delta.content;
      }
      for (const fragment of delta.tool_calls ?? []) {
        const at = typeof fragment.index === "number" ? fragment.index : this.calls.size;
        const call = this.calls.get(at) ?? { id: "", name: "", arguments: "" };
        if (fragment.id) call.id = fragment.id;
        if (fragment.function?.name) call.name += fragment.function.name;
        if (fragment.function?.arguments) call.arguments += fragment.function.arguments;
        this.calls.set(at, call);
      }
      if (choice.finish_reason) this.finishReason = choice.finish_reason;
    }
    return added;
  }

  result(): StepResult {
    const toolCalls = [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([at, call]) => ({
        // A call the stream never gave an id still needs one to be answered by.
        id: call.id || `call_${at}`,
        type: "function" as const,
        function: { name: call.name, arguments: call.arguments },
      }))
      .filter((call) => call.function.name !== "");
    return { text: this.text, toolCalls, finishReason: this.finishReason, usage: this.usage };
  }
}
