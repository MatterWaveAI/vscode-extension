import type { Message } from "../api/types";
import type { ViewState } from "../chat/protocol";

/**
 * What a screen reader is told, and when: once when an answer finishes,
 * with its opening words, and once when an error appears -- never the
 * stream token by token, which made the whole transcript a live region
 * that read every delta aloud.
 */

/** How much of an answer is read out when it finishes; the rest is in the transcript. */
const SPOKEN_CHARS = 300;

/** An answer's words as speech: its text, without the Markdown marks, cut at a readable length. */
export function spokenText(message: Message): string {
  const text = message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join(" ")
    .replace(/```[^\n]*\n[\s\S]*?```/g, " (code) ")
    .replace(/[*_`#>]+/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > SPOKEN_CHARS ? `${text.slice(0, SPOKEN_CHARS).trimEnd()}…` : text;
}

/** What changed between two states that deserves saying, or null for nothing. */
export function announcement(previous: ViewState | null, next: ViewState): string | null {
  if (next.error && next.error.title !== previous?.error?.title) return `${next.error.title}. ${next.error.guidance}`;
  if (previous?.streaming && !next.streaming && !next.error) {
    const last = next.transcript.at(-1)?.message;
    if (last?.role === "assistant") return `MatterWave answered: ${spokenText(last)}`;
  }
  return null;
}
