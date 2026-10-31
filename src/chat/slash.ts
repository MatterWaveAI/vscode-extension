/**
 * Slash commands in the composer: the first word decides. A built-in runs
 * its action here instead of sending; any other `/name` is the prompt
 * library's, sent as the saved text expanded. A leading `//` is the escape
 * for a message that genuinely starts with a slash.
 */

export const BUILT_IN_COMMANDS = ["model", "clear", "compact", "share", "export"] as const;

export type BuiltInCommand = (typeof BUILT_IN_COMMANDS)[number];

export type SlashCommand =
  | { kind: "built-in"; command: BuiltInCommand; args: string }
  | { kind: "library"; name: string; args: string };

const BUILT_IN_SET = new Set<string>(BUILT_IN_COMMANDS);

/** `/name` and its arguments, or null when the message is not a command. */
export function parseSlashCommand(content: string): SlashCommand | null {
  const match = /^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+([\s\S]+))?$/.exec(content.trim());
  if (!match) return null;
  const name = (match[1] ?? "").toLowerCase();
  const args = (match[2] ?? "").trim();
  if (BUILT_IN_SET.has(name)) return { kind: "built-in", command: name as BuiltInCommand, args };
  return { kind: "library", name, args };
}
