/**
 * @-mentions in the composer: the tokens that pull context into a message.
 *
 * Pure parsing, so the exact set a prompt carries is testable without an
 * editor. A mention is `@` followed by a provider's name as its own word --
 * `@file`, `@folder`, `@terminal`, `@git`, `@docs` -- case-insensitive.
 * Every one typed is its own mention: "compare @file with @file" names two
 * files, each picked on its own. Anything else (`a@b`, `@unknown`) is the
 * message's own text, not context.
 */

export const MENTION_KINDS = ["file", "folder", "terminal", "git", "docs"] as const;

export type MentionKind = (typeof MENTION_KINDS)[number];

export interface Mention {
  kind: MentionKind;
  /** The token as the prompt spells it, e.g. `@file`. */
  token: string;
  /** 1-based position among this message's mentions of the same kind, and how many there are. */
  ordinal: number;
  of: number;
}

const MENTION_KIND_SET = new Set<string>(MENTION_KINDS);

/** `@word`, not preceded by a letter, digit or another `@` (so emails stay text). */
const MENTION = /(^|[^A-Za-z0-9_@])@([A-Za-z]+)(?![A-Za-z0-9_])/g;

/** Every provider mention in the prompt, in the order typed. */
export function parseMentions(content: string): Mention[] {
  const kinds: MentionKind[] = [];
  for (const match of content.matchAll(MENTION)) {
    const kind = (match[2] ?? "").toLowerCase();
    if (MENTION_KIND_SET.has(kind)) kinds.push(kind as MentionKind);
  }
  const seen = new Map<MentionKind, number>();
  return kinds.map((kind) => {
    const ordinal = (seen.get(kind) ?? 0) + 1;
    seen.set(kind, ordinal);
    return { kind, token: `@${kind}`, ordinal, of: kinds.filter((k) => k === kind).length };
  });
}

/** Whether the prompt asks for context at all. */
export function hasMentions(content: string): boolean {
  return parseMentions(content).length > 0;
}

/** How a pick names the mention it is for: `@file`, or `@file (2 of 3)` when there are several. */
export function mentionTitle(mention: Mention): string {
  return mention.of > 1 ? `${mention.token} (${mention.ordinal} of ${mention.of})` : mention.token;
}
