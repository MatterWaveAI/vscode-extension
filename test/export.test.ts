import { describe, expect, it } from "vitest";
import type { Message } from "../src/api/types";
import { conversationToMarkdown, messageToMarkdown } from "../src/chat/export";
import type { ViewState } from "../src/chat/protocol";

function message(partial: Partial<Message> & Pick<Message, "id" | "role" | "parts">): Message {
  return {
    conversation_id: "c_1",
    content: "",
    created_at: "2026-10-18T10:00:00+00:00",
    parent_id: null,
    model: null,
    truncated: false,
    ...partial,
  };
}

function view(transcript: Message[]): ViewState {
  return {
    signedIn: true,
    offline: false,
    identity: "Ada",
    conversations: [{ id: "c_1", title: "The clock question", pinned: false, archived: false }],
    archivedConversations: [],
    searchResults: null,
    activeId: "c_1",
    transcript: transcript.map((m) => ({ message: m, siblingIndex: 1, siblingCount: 1 })),
    live: null,
    model: { id: "partner-x", label: "Partner X" },
    meter: null,
    streaming: false,
    error: null,
    notice: null,
  };
}

describe("conversationToMarkdown", () => {
  it("renders the conversation under role headings, with the model named", () => {
    const markdown = conversationToMarkdown(
      view([
        message({ id: "u1", role: "user", parts: [{ type: "text", text: "What time is it?" }], content: "What time is it?" }),
        message({
          id: "a1",
          role: "assistant",
          parent_id: "u1",
          model: "partner-x",
          parts: [{ type: "text", text: "It is **10:00 UTC**." }],
          content: "It is 10:00 UTC.",
        }),
      ]),
    );
    expect(markdown).toContain("# The clock question");
    expect(markdown).toContain("model: Partner X");
    expect(markdown).toContain("## You\n\nWhat time is it?");
    expect(markdown).toContain("## MatterWave\n\nIt is **10:00 UTC**.");
  });

  it("names attachments, quotes tool traffic, and marks a cut answer", () => {
    const markdown = conversationToMarkdown(
      view([
        message({
          id: "u2",
          role: "user",
          parts: [
            { type: "text", text: "Read this." },
            { type: "image", attachment_id: "att_1", filename: "shot.png", content_type: "image/png" },
            { type: "document", attachment_id: "att_2", filename: "notes.pdf", content_type: "application/pdf", text: null, truncated: true },
          ],
          content: "Read this.",
        }),
        message({
          id: "a2",
          role: "assistant",
          parent_id: "u2",
          truncated: true,
          parts: [
            { type: "tool_call", id: "t1", name: "get_time", arguments: "{}" },
            { type: "tool_result", id: "t1", output: "10:00", is_error: false },
            { type: "text", text: "Part of an answer" },
          ],
          content: "Part of an answer",
        }),
      ]),
    );
    expect(markdown).toContain("_(attached image: shot.png)_");
    expect(markdown).toContain("_(attached notes.pdf — only its start was read)_");
    expect(markdown).toContain("> Tool call: `get_time`");
    expect(markdown).toContain("> Tool result: 10:00");
    expect(markdown).toContain("_This answer was cut off before it finished._");
  });

  it("keeps a compaction summary as a quote, not a section", () => {
    const markdown = conversationToMarkdown(
      view([message({ id: "s1", role: "system", parts: [{ type: "summary", text: "Earlier: the clock.", covers_from: "u1", covers_to: "a1", tokens_before: 100, tokens_after: 10 }] })]),
    );
    expect(markdown).not.toContain("## System");
    expect(markdown).toContain("> Earlier turns were summarised: Earlier: the clock.");
  });

  it("falls back to a plain heading when the open conversation is not in the list", () => {
    const state = view([]);
    state.activeId = null;
    expect(conversationToMarkdown(state)).toContain("# MatterWave conversation");
  });
});

describe("messageToMarkdown", () => {
  it("renders reasoning as a collapsed block", () => {
    const markdown = messageToMarkdown(
      message({ id: "a1", role: "assistant", parts: [{ type: "reasoning", text: "thinking" }, { type: "text", text: "Answer" }] }),
    );
    expect(markdown).toContain("<details>");
    expect(markdown).toContain("thinking");
    expect(markdown.endsWith("Answer")).toBe(true);
  });

  it("falls back to the flattened content when the parts list is empty", () => {
    expect(messageToMarkdown(message({ id: "u1", role: "user", parts: [], content: "Just text" }))).toBe("Just text");
  });
});
