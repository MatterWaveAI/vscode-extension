import type { DeltaFrame, PartStartFrame } from "@matterwave/sdk";
import type { Message, Part } from "../api/types";

/**
 * Building the streaming assistant message from `part_start` / `delta`
 * frames. Pure and shared by the host (which keeps the authoritative copy)
 * and the webview (which applies the same frames to draw without waiting for
 * a full state post).
 */

export function emptyAssistant(conversationId: string, parentId: string | null): Message {
  return {
    id: "",
    conversation_id: conversationId,
    role: "assistant",
    parts: [],
    content: "",
    created_at: new Date().toISOString(),
    parent_id: parentId,
    model: null,
    truncated: false,
  };
}

/** The part a `part_start` frame opens. Unknown types become text so nothing arrives invisible. */
export function partFromStart(frame: PartStartFrame): Part {
  switch (frame.type) {
    case "reasoning":
      return { type: "reasoning", text: "" };
    case "tool_call":
      return { type: "tool_call", id: frame.call_id ?? "", name: frame.name ?? "", arguments: frame.arguments ?? "" };
    case "tool_result":
      return { type: "tool_result", id: frame.call_id ?? "", output: frame.output ?? "", is_error: frame.is_error };
    default:
      return { type: "text", text: "" };
  }
}

export function setPart(message: Message, index: number, part: Part): void {
  while (message.parts.length < index) message.parts.push({ type: "text", text: "" });
  message.parts[index] = part;
}

/** Append streamed text to the text or reasoning part at `index`. */
export function appendDelta(message: Message, index: number, text: string): void {
  let part = message.parts[index];
  if (!part) {
    part = { type: "text", text: "" };
    setPart(message, index, part);
  }
  if (part.type === "text" || part.type === "reasoning") {
    part.text += text;
    if (part.type === "text") message.content += text;
  }
}

/** The text a `delta` frame carries: `content` for answer text, `reasoning` for thinking. */
export function deltaText(frame: DeltaFrame): string {
  return frame.content ?? frame.reasoning ?? "";
}
