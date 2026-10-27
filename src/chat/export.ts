import type { Message, Part } from "../api/types";
import type { ViewState } from "./protocol";

/**
 * The active conversation as a Markdown file: the same record the web app's
 * share page shows, in a form that outlives the editor. Pure, so the exact
 * output is testable without a save dialog.
 */

const HEADING: Record<string, string> = { user: "You", assistant: "MatterWave", system: "System" };

/** One message's Markdown: its text parts, its attachments named, its tools summarised. */
export function messageToMarkdown(message: Message): string {
  const blocks: string[] = [];
  for (const part of message.parts) blocks.push(partToMarkdown(part));
  if (blocks.length === 0 && message.content) blocks.push(message.content);
  if (message.truncated) blocks.push("_This answer was cut off before it finished._");
  return blocks.join("\n\n");
}

function partToMarkdown(part: Part): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "reasoning":
      return part.text ? `<details>\n<summary>Reasoning</summary>\n\n${part.text}\n\n</details>` : "";
    case "tool_call":
      return `> Tool call: \`${part.name}\``;
    case "tool_result":
      return part.is_error ? `> Tool result (error): ${part.output}` : `> Tool result: ${part.output}`;
    case "image":
      return `_(attached image: ${part.filename})_`;
    case "document":
      return part.truncated ? `_(attached ${part.filename} — only its start was read)_` : `_(attached ${part.filename})_`;
    case "summary":
      return `> Earlier turns were summarised: ${part.text}`;
  }
}

/** The whole conversation: a heading, then every message under its role. */
export function conversationToMarkdown(state: ViewState): string {
  const lines: string[] = [];
  const current = state.conversations.find((c) => c.id === state.activeId);
  lines.push(`# ${current?.title || "MatterWave conversation"}`);
  lines.push("");
  const bits = [`Exported from the MatterWave VS Code extension, ${new Date().toISOString().slice(0, 10)}`];
  if (state.model) bits.push(`model: ${state.model.label}`);
  lines.push(`_${bits.join("; ")}._`);
  lines.push("");
  let role: string | null = null;
  for (const entry of state.transcript) {
    const message = entry.message;
    // A summary message is rendered by its parts (the divider quote), not as a "System" section.
    const heading = HEADING[message.role] ?? message.role;
    if (heading !== role && !(message.role === "system" && message.parts.some((p) => p.type === "summary"))) {
      role = heading;
      lines.push(`## ${heading}`);
      lines.push("");
    }
    const body = messageToMarkdown(message);
    if (body) {
      lines.push(body);
      lines.push("");
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
