import { describe, expect, it } from "vitest";
import type { Message } from "../src/api/types";
import { conversationToMarkdown, messageToMarkdown, safeFilename } from "../src/chat/export";
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
    conversations: [{ id: "c_1", title: "The clock question", pinned: false, archived: false, badge: null }],
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
    temporary: false,
    instructions: null,
    feedback: {},
    notifications: null,
    unreadNotifications: 0,
    notificationsUnreadOnly: false,
    notificationsComplete: true,
    usage: null,
  };
}

describe("conversationToMarkdown", () => {
  it("writes the web format: title, stamp with the conversation id, one heading per message", () => {
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
    expect(markdown).toMatch(
      /^# The clock question\n\nExported from MatterWave on \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\. Conversation `c_1`\.\n\n/,
    );
    expect(markdown).toContain("## You\n\nWhat time is it?");
    // The heading names the model that answered, as the web's export does.
    expect(markdown).toContain("## Assistant (partner-x)\n\nIt is **10:00 UTC**.");
    expect(markdown.endsWith("\n")).toBe(true);
  });

  it("names the message's model, falling back to the view's, and heads the assistant plainly when neither is known", () => {
    const markdown = conversationToMarkdown(view([message({ id: "a1", role: "assistant", parts: [{ type: "text", text: "Yes." }] })]));
    expect(markdown).toContain("## Assistant (partner-x)\n\nYes.");
    const state = view([message({ id: "a1", role: "assistant", parts: [{ type: "text", text: "Yes." }] })]);
    state.model = null;
    expect(conversationToMarkdown(state)).toContain("## Assistant\n\n");
  });

  it("drops reasoning, renders tool calls as json fences, and names attachments in the web's wording", () => {
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
            { type: "reasoning", text: "secret thinking" },
            { type: "tool_call", id: "t1", name: "get_time", arguments: '{"tz": "UTC"}' },
            { type: "tool_result", id: "t1", output: "10:00", is_error: false },
            { type: "text", text: "Part of an answer" },
          ],
          content: "Part of an answer",
        }),
      ]),
    );
    expect(markdown).not.toContain("secret thinking");
    expect(markdown).not.toContain("<details>");
    expect(markdown).toContain("*Attached image: shot.png*");
    expect(markdown).toContain("*Attached file: notes.pdf*");
    expect(markdown).toContain("Tool call `get_time`:\n\n```json\n{\"tz\": \"UTC\"}\n```");
    expect(markdown).toContain("> Tool result: 10:00");
    expect(markdown).toContain("_This answer was cut off before it finished._");
  });

  it("gives consecutive messages of one role their own headings, the merged-role dedup dropped", () => {
    const markdown = conversationToMarkdown(
      view([
        message({ id: "u1", role: "user", parts: [{ type: "text", text: "One" }] }),
        message({ id: "u2", role: "user", parts: [{ type: "text", text: "Two" }] }),
      ]),
    );
    expect(markdown.match(/## You/g)).toHaveLength(2);
    expect(markdown).toContain("## You\n\nOne\n\n## You\n\nTwo");
  });

  it("keeps a compaction summary as a quote, not a section", () => {
    const markdown = conversationToMarkdown(
      view([message({ id: "s1", role: "system", parts: [{ type: "summary", text: "Earlier: the clock.", covers_from: "u1", covers_to: "a1", tokens_before: 100, tokens_after: 10 }] })]),
    );
    expect(markdown).toContain("> Earlier turns were summarised: Earlier: the clock.");
  });

  it("falls back to a plain heading and drops the id clause when the conversation is not in the list", () => {
    const state = view([]);
    state.activeId = null;
    const markdown = conversationToMarkdown(state);
    expect(markdown).toContain("# MatterWave conversation");
    expect(markdown).toMatch(/^# MatterWave conversation\n\nExported from MatterWave on \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\.\n/);
    expect(markdown).not.toContain("Conversation");
  });
});

describe("messageToMarkdown", () => {
  it("leaves the reasoning out and keeps the answer", () => {
    const markdown = messageToMarkdown(
      message({ id: "a1", role: "assistant", parts: [{ type: "reasoning", text: "thinking" }, { type: "text", text: "Answer" }] }),
    );
    expect(markdown).not.toContain("thinking");
    expect(markdown).not.toContain("<details>");
    expect(markdown).toBe("Answer");
  });

  it("falls back to the flattened content when the parts list is empty", () => {
    expect(messageToMarkdown(message({ id: "u1", role: "user", parts: [], content: "Just text" }))).toBe("Just text");
  });
});

describe("safeFilename", () => {
  it("strips what a filename may not carry and collapses the whitespace", () => {
    expect(safeFilename('  a <b>:"c/\\d|e?f*g  ')).toBe("a bcdefg");
    expect(safeFilename("Multiple   spaces\tand\nnewlines")).toBe("Multiple spaces and newlines");
  });

  it("cuts to 80 characters", () => {
    expect(safeFilename("x".repeat(300))).toHaveLength(80);
  });

  it("normalises to NFKC", () => {
    expect(safeFilename("\uFB01ne\u2460")).toBe("fine1");
  });

  it("renames the Windows reserved device names, in any case, and leaves lookalikes alone", () => {
    expect(safeFilename("CON")).toBe("CON conversation");
    expect(safeFilename("lpt1")).toBe("lpt1 conversation");
    expect(safeFilename("constant")).toBe("constant");
  });

  it("keeps control characters out and falls back when nothing is left", () => {
    expect(safeFilename("a\u0000b\u001Fc")).toBe("abc");
    expect(safeFilename("???")).toBe("conversation");
  });
});
