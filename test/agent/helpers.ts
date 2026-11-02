import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ModelClient } from "../../src/agent/loop";
import type { ReviewHandle, ReviewSurface } from "../../src/agent/session";
import type { Approvals, ChangeRequest, ConfirmRequest } from "../../src/agent/tools";
import type { ChatCompletionChunk, ChatCompletionRequest } from "../../src/agent/wire";

/**
 * A real folder with `files` in it (paths `/`-separated), resolved, removed
 * by `cleanup`. Removal is retried for a few seconds: on Windows a command
 * that was just stopped in the folder holds it until the OS lets go.
 */
export function workspace(files: Record<string, string> = {}): { root: string; cleanup(): Promise<void> } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-agent-")));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split("/"));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  const cleanup = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(root, { recursive: true, force: true });
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if ((code !== "EPERM" && code !== "EBUSY") || attempt >= 50) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  };
  return { root, cleanup };
}

export function textChunk(text: string): ChatCompletionChunk {
  return { choices: [{ index: 0, delta: { content: text } }] };
}

export function callChunk(id: string, name: string, args: Record<string, unknown>, index = 0): ChatCompletionChunk {
  return { choices: [{ index: 0, delta: { tool_calls: [{ index, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] };
}

export function usageChunk(prompt: number, completion: number): ChatCompletionChunk {
  return { choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion } };
}

type Step = ChatCompletionChunk[] | ((request: ChatCompletionRequest) => ChatCompletionChunk[] | Promise<ChatCompletionChunk[]>) | Error;

/**
 * A scripted `/v1`: each request takes the next step (chunks, a function of
 * the request, or an error to throw); past the script it answers `fallback`.
 * Every request is kept, deep-copied as sent.
 */
export class FakeModel implements ModelClient {
  readonly requests: ChatCompletionRequest[] = [];
  constructor(
    private readonly script: Step[],
    private readonly fallback: Step = [textChunk("done")],
  ) {}

  async *chatCompletionsStream(request: ChatCompletionRequest, signal?: AbortSignal): AsyncGenerator<ChatCompletionChunk> {
    this.requests.push(JSON.parse(JSON.stringify(request)) as ChatCompletionRequest);
    const step = this.script.shift() ?? this.fallback;
    if (step instanceof Error) throw step;
    const chunks = typeof step === "function" ? await step(request) : step;
    for (const chunk of chunks) {
      if (signal?.aborted) {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
      yield chunk;
    }
  }

  toolNames(at: number): string[] {
    return (this.requests[at]?.tools ?? []).map((t) => t.function.name);
  }
}

/** Approvals that answer as told and write accepted changes to disk; every request is recorded. */
export class ScriptedApprovals implements Approvals {
  readonly changes: { change: ChangeRequest; ask: boolean }[] = [];
  readonly confirms: ConfirmRequest[] = [];
  constructor(
    private readonly answer: { change?: boolean; confirm?: boolean; edited?: (after: string) => string } = {},
  ) {}

  async change(change: ChangeRequest, ask: boolean) {
    this.changes.push({ change, ask });
    if (ask && this.answer.change === false) return { status: "rejected" as const };
    const content = ask && this.answer.edited ? this.answer.edited(change.after) : change.after;
    mkdirSync(dirname(change.absolute), { recursive: true });
    writeFileSync(change.absolute, content);
    return { status: "applied" as const, content, edited: content !== change.after };
  }

  async confirm(request: ConfirmRequest) {
    this.confirms.push(request);
    return { approved: this.answer.confirm !== false };
  }
}

/** The editor's diff, without an editor: the person's edit of the proposal is `edit`, and Accept writes to disk. */
export class FakeReview implements ReviewSurface {
  readonly opened: { change: ChangeRequest; id: string }[] = [];
  readonly applied: { change: ChangeRequest; content: string }[] = [];
  readonly closed: string[] = [];
  /** What the person typed into the right side of the diff, if anything. */
  edit: ((proposal: string) => string) | null = null;

  async open(change: ChangeRequest, id: string): Promise<ReviewHandle> {
    this.opened.push({ change, id });
    return {
      proposal: async () => (this.edit ? this.edit(change.after) : change.after),
      reveal: async () => undefined,
      close: async () => void this.closed.push(id),
    };
  }

  async apply(change: ChangeRequest, content: string): Promise<string> {
    this.applied.push({ change, content });
    mkdirSync(dirname(change.absolute), { recursive: true });
    writeFileSync(change.absolute, content);
    return content;
  }
}

/** Wait until `check` holds (polling), or fail after `ms`. */
export async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export class MemoryState {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, JSON.parse(JSON.stringify(value)));
    return Promise.resolve();
  }
}
