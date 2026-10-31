/**
 * @-mentions in the composer: the tokens that pull context into a message.
 *
 * Pure parsing, so the exact set a prompt carries is testable without an
 * editor. A mention is `@` followed by a provider's name as its own word --
 * `@file`, `@folder`, `@terminal`, `@git`, `@docs` -- case-insensitive, once
 * each however many times it is typed. Anything else (`a@b`, `@unknown`)
 * is the message's own text, not context.
 */

export const MENTION_KINDS = ["file", "folder", "terminal", "git", "docs"] as const;

export type MentionKind = (typeof MENTION_KINDS)[number];

export interface Mention {
  kind: MentionKind;
  /** The token as the prompt spells it, e.g. `@file`. */
  token: string;
}

const MENTION_KIND_SET = new Set<string>(MENTION_KINDS);

/** `@word`, not preceded by a letter, digit or another `@` (so emails stay text). */
const MENTION = /(^|[^A-Za-z0-9_@])@([A-Za-z]+)(?![A-Za-z0-9_])/g;

/** Every provider mention in the prompt, first appearance first, each once. */
export function parseMentions(content: string): Mention[] {
  const seen = new Set<MentionKind>();
  const mentions: Mention[] = [];
  for (const match of content.matchAll(MENTION)) {
    const kind = (match[2] ?? "").toLowerCase();
    if (!MENTION_KIND_SET.has(kind) || seen.has(kind as MentionKind)) continue;
    seen.add(kind as MentionKind);
    mentions.push({ kind: kind as MentionKind, token: `@${kind}` });
  }
  return mentions;
}

/** Whether the prompt asks for context at all. */
export function hasMentions(content: string): boolean {
  return parseMentions(content).length > 0;
}
