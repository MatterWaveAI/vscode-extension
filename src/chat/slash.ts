/**
 * Slash commands in the composer: the first word decides. A built-in runs
 * its action here instead of sending; any other `/name` is the prompt
 * custom command's (`.matterwave/commands/<name>.md`) or the prompt
 * library's, sent as the text expanded. A leading `//` is the escape
 * for a message that genuinely starts with a slash.
 */

export const BUILT_IN_COMMANDS = [
  "model",
  "clear",
  "compact",
  "share",
  "export",
  "help",
  "approval-mode",
  "context",
  "restore",
  "init",
  "resume",
] as const;

/** One line per built-in, for `/help`. */
export const BUILT_IN_HELP: Record<(typeof BUILT_IN_COMMANDS)[number], string> = {
  help: "this list",
  model: "pick the model",
  "approval-mode": "set the agent's approval mode: /approval-mode plan | ask | auto-edit | yolo (Shift+Tab cycles)",
  compact: "summarise earlier turns (in agent mode, fold old tool output and summarise the run)",
  context: "what the next request carries and how much of the window it fills",
  restore: "put files back as they were before an applied change",
  init: "draft a MATTERWAVE.md for this workspace with the agent",
  resume: "pick up an earlier agent run with its tool rounds",
  clear: "start a new chat",
  share: "copy a read-only link to this conversation",
  export: "save this conversation as Markdown",
};

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
