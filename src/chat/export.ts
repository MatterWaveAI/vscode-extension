import type { Message, Part } from "../api/types";
import type { ViewState } from "./protocol";

/**
 * The active conversation as a Markdown file, in the shape the web app's
 * export writes: a heading, an export stamp carrying the conversation id,
 * then every message under its own role heading. Pure, so the exact output
 * is testable without a save dialog.
 */

const HEADING: Record<string, string> = { user: "You", assistant: "Assistant", system: "System" };

/** Windows treats these base names as devices, in any letter case. */
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/**
 * The conversation title as a file's base name: NFKC-normalised, whitespace
 * collapsed to single spaces, control characters and the punctuation a
 * filename may not carry taken out, cut to 80 characters. A name Windows
 * would read as a device (`CON`, `LPT1`) gains " conversation" instead of
 * failing to save.
 */
export function safeFilename(title: string): string {
  // Whitespace collapses first, so a tab or newline becomes the single space
  // it stands for; then the rest of the control range and the punctuation go.
  const stripped = title.normalize("NFKC").replace(/\s+/g, " ").replace(/[\p{Cc}<>:"/\\|?*]/gu, "");
  const name = stripped.trim().slice(0, 80).trim();
  if (WINDOWS_RESERVED.test(name)) return `${name} conversation`;
  return name || "conversation";
}

/** `2026-10-27T01:02:03Z`: the instant, ISO without the milliseconds. */
function exportStamp(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

/** One message's Markdown: its parts, its attachments named, its tools as the web writes them. */
export function messageToMarkdown(message: Message): string {
  const blocks: string[] = [];
  for (const part of message.parts) {
    const block = partToMarkdown(part);
    if (block) blocks.push(block);
  }
  if (blocks.length === 0 && message.content) blocks.push(message.content);
  if (message.truncated) blocks.push("_This answer was cut off before it finished._");
  return blocks.join("\n\n");
}

function partToMarkdown(part: Part): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "reasoning":
      // The web export leaves the model's reasoning out; so does this.
      return "";
    case "tool_call":
      return `Tool call \`${part.name}\`:\n\n\`\`\`json\n${part.arguments}\n\`\`\``;
    case "tool_result":
      return part.is_error ? `> Tool result (error): ${part.output}` : `> Tool result: ${part.output}`;
    case "image":
      return `*Attached image: ${part.filename}*`;
    case "document":
      return `*Attached file: ${part.filename}*`;
    case "summary":
      return `> Earlier turns were summarised: ${part.text}`;
  }
}

/** `## You`, or `## Assistant (model)` naming the model that answered. */
function roleHeading(message: Message, state: ViewState): string {
  const base = HEADING[message.role] ?? message.role;
  if (message.role !== "assistant") return base;
  const model = message.model ?? state.model?.id;
  return model ? `${base} (${model})` : base;
}

/** The whole conversation: a heading and stamp, then every message under its own role heading. */
export function conversationToMarkdown(state: ViewState): string {
  const current = state.conversations.find((c) => c.id === state.activeId);
  const lines: string[] = [];
  lines.push(`# ${current?.title || "MatterWave conversation"}`);
  lines.push("");
  const stamp = `Exported from MatterWave on ${exportStamp()}`;
  lines.push(state.activeId ? `${stamp}. Conversation \`${state.activeId}\`.` : `${stamp}.`);
  lines.push("");
  for (const entry of state.transcript) {
    lines.push(`## ${roleHeading(entry.message, state)}`);
    lines.push("");
    const body = messageToMarkdown(entry.message);
    if (body) {
      lines.push(body);
      lines.push("");
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
