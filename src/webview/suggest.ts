import { MENTION_KINDS } from "../chat/mentions";
import { BUILT_IN_COMMANDS } from "../chat/slash";

/**
 * Composer autocomplete: what the token at the caret could become. An `@`
 * word anywhere offers the context providers; a `/` word at the very start
 * offers the built-in commands and the person's saved prompts. Pure, so
 * the offers for any text and caret are testable without a page.
 */

export interface Suggestion {
  /** What replaces the token, e.g. `@file` or `/review`. */
  insert: string;
  /** A word about it for the list. */
  detail: string;
}

export interface Suggestions {
  /** The token's span in the text, replaced on accept. */
  start: number;
  end: number;
  items: Suggestion[];
}

const MENTION_DETAIL: Record<string, string> = {
  file: "a file's contents",
  folder: "a folder's tree",
  terminal: "a terminal's recent commands and output",
  git: "the working tree's or last commit's diff",
  docs: "the text of a web page",
};

const COMMAND_DETAIL: Record<string, string> = {
  model: "pick the model",
  clear: "start a new chat",
  compact: "summarise earlier turns",
  share: "copy a share link",
  export: "save as Markdown",
};

/** The offers for the token ending at `caret`, or null when it is not one that completes. */
export function suggestionsAt(text: string, caret: number, promptNames: readonly string[]): Suggestions | null {
  const before = text.slice(0, caret);
  const mention = /(^|[^A-Za-z0-9_@])@([A-Za-z]*)$/.exec(before);
  if (mention) {
    const typed = (mention[2] ?? "").toLowerCase();
    const items = MENTION_KINDS.filter((kind) => kind.startsWith(typed) && kind !== typed).map((kind) => ({
      insert: `@${kind}`,
      detail: MENTION_DETAIL[kind] ?? "",
    }));
    return items.length > 0 ? { start: caret - typed.length - 1, end: caret, items } : null;
  }
  const slash = /^\/([A-Za-z0-9_-]*)$/.exec(before);
  if (slash) {
    const typed = (slash[1] ?? "").toLowerCase();
    const names = [
      ...BUILT_IN_COMMANDS.map((name) => ({ name, detail: COMMAND_DETAIL[name] ?? "" })),
      ...promptNames.filter((name) => !(BUILT_IN_COMMANDS as readonly string[]).includes(name)).map((name) => ({ name, detail: "saved prompt" })),
    ];
    const items = names
      .filter(({ name }) => name.startsWith(typed) && name !== typed)
      .map(({ name, detail }) => ({ insert: `/${name}`, detail }));
    return items.length > 0 ? { start: 0, end: caret, items } : null;
  }
  return null;
}
