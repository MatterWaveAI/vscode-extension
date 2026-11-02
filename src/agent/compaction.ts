import { estimateTokens } from "./loop";
import type { ChatMessage } from "./wire";

/**
 * Compaction for an agent run. `/v1` leaves the context to the caller, so
 * the run keeps its own history under the model's window in two moves:
 * first old tool output is folded to a one-line stub (no model call, and
 * the bulk of an agent's context is what its tools returned), then, if that
 * is not enough, everything but the latest rounds is summarised -- by the
 * conversation's own compaction when the run is stored, by a `/v1` call
 * otherwise -- and replaced with the summary.
 */

export const FOLDED_PREFIX = "[Output folded to save context:";
/** Under this a tool result is left alone: folding it would save nothing. */
const FOLD_MIN_CHARS = 600;
/** When the model's window is unknown, compaction plans for one this size. */
export const DEFAULT_CONTEXT_WINDOW = 64_000;

export interface CompactionPolicy {
  contextWindow: number | null;
  /** Fold old tool output past this share of the window. */
  foldAt?: number;
  /** Summarise past this share, after folding. */
  summariseAt?: number;
  /** The latest assistant rounds whose tool output is never folded. */
  keepRounds?: number;
}

export interface CompactionResult {
  folded: number;
  summarised: boolean;
  tokensBefore: number;
  tokensAfter: number;
}

/** Fold every tool result older than the latest `keepRounds` assistant steps; returns how many were folded. */
export function foldToolOutput(history: ChatMessage[], keepRounds = 2): number {
  let rounds = 0;
  let cutoff = history.length;
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]!;
    if (message.role === "assistant" && message.tool_calls?.length) {
      rounds += 1;
      if (rounds > keepRounds) {
        cutoff = i + 1;
        break;
      }
    }
    if (i === 0) cutoff = 0;
  }
  if (rounds <= keepRounds) return 0;
  let folded = 0;
  for (let i = 0; i < cutoff; i++) {
    const message = history[i]!;
    if (message.role !== "tool" || message.content.startsWith(FOLDED_PREFIX) || message.content.length < FOLD_MIN_CHARS) continue;
    const first = message.content.split("\n", 1)[0]!.slice(0, 120);
    history[i] = {
      ...message,
      content: `${FOLDED_PREFIX} it began "${first}" and ran to ${message.content.length.toLocaleString("en-US")} characters. Call the tool again if you need it.]`,
    };
    folded += 1;
  }
  return folded;
}

/**
 * Where the kept tail of the history starts: at most `keep` messages back,
 * moved earlier so a tool result is never separated from the call it
 * answers.
 */
export function tailStart(history: readonly ChatMessage[], keep: number): number {
  let at = Math.max(0, history.length - keep);
  while (at > 0 && history[at]!.role === "tool") at -= 1;
  return at;
}

/** The history as plain text, for a summariser that reads prose. */
export function transcriptText(history: readonly ChatMessage[]): string {
  return history
    .map((m) => {
      if (m.role === "assistant") {
        const calls = (m.tool_calls ?? []).map((c) => `[called ${c.function.name} ${c.function.arguments}]`).join("\n");
        return `Assistant: ${[m.content ?? "", calls].filter(Boolean).join("\n")}`;
      }
      if (m.role === "tool") return `Tool result: ${m.content}`;
      return `${m.role === "user" ? "User" : "System"}: ${m.content}`;
    })
    .join("\n\n");
}

export const SUMMARY_LEAD = "Summary of the earlier part of this session, written to save context:";

/**
 * Keep `history` under the policy's window: fold, then summarise. `force`
 * does both regardless of size (the `/compact` command). The summariser
 * answers null when it could not, and the history then stays as folding
 * left it.
 */
export async function compactHistory(
  history: ChatMessage[],
  policy: CompactionPolicy,
  summarise: (older: ChatMessage[]) => Promise<string | null>,
  options: { force?: boolean; system?: string } = {},
): Promise<CompactionResult> {
  const window = policy.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const systemTokens = Math.ceil((options.system?.length ?? 0) / 4);
  const size = () => estimateTokens(history) + systemTokens;
  const tokensBefore = size();
  let folded = 0;
  if (options.force || tokensBefore > window * (policy.foldAt ?? 0.5)) {
    folded = foldToolOutput(history, options.force ? 1 : (policy.keepRounds ?? 2));
  }
  let summarised = false;
  if (options.force || size() > window * (policy.summariseAt ?? 0.75)) {
    const start = tailStart(history, 6);
    if (start > 0) {
      const older = history.slice(0, start);
      const summary = await summarise(older);
      if (summary && summary.trim()) {
        const lead: ChatMessage[] = [{ role: "user", content: `${SUMMARY_LEAD}\n\n${summary.trim()}` }];
        // Keep the roles alternating where the tail opens with the user.
        if (history[start]?.role === "user") lead.push({ role: "assistant", content: "Understood. I will carry on from that summary." });
        history.splice(0, start, ...lead);
        summarised = true;
      }
    }
  }
  return { folded, summarised, tokensBefore, tokensAfter: size() };
}
