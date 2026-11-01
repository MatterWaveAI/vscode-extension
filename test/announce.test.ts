import { describe, expect, it } from "vitest";
import type { Message } from "../src/api/types";
import type { ViewState } from "../src/chat/protocol";
import { announcement, spokenText } from "../src/webview/announce";

function answer(text: string): Message {
  return {
    id: "a1",
    conversation_id: "c_1",
    role: "assistant",
    parts: [{ type: "text", text }],
    content: text,
    created_at: "2026-10-31T10:00:00Z",
    parent_id: "u1",
    model: null,
    truncated: false,
  };
}

function view(over: Partial<ViewState>): ViewState {
  return { streaming: false, error: null, transcript: [], ...over } as ViewState;
}

describe("spokenText", () => {
  it("reads the words without the Markdown marks, a code block as just that", () => {
    expect(spokenText(answer("**Yes**: see [the docs](https://x.test).\n\n```ts\nconst a = 1;\n```\nDone."))).toBe(
      "Yes: see the docs. (code) Done.",
    );
  });

  it("cuts a long answer at a readable length", () => {
    const spoken = spokenText(answer("word ".repeat(200)));
    expect(spoken.length).toBeLessThanOrEqual(301);
    expect(spoken.endsWith("…")).toBe(true);
  });
});

describe("announcement", () => {
  const finished = view({ transcript: [{ message: answer("It is 10:00 UTC."), siblingIndex: 1, siblingCount: 1 }] });

  it("says once that an answer finished, with its opening words", () => {
    expect(announcement(view({ streaming: true }), finished)).toBe("MatterWave answered: It is 10:00 UTC.");
    // The next state with nothing new says nothing.
    expect(announcement(finished, finished)).toBeNull();
  });

  it("says nothing while an answer streams", () => {
    expect(announcement(view({ streaming: true }), view({ streaming: true }))).toBeNull();
    expect(announcement(null, view({ streaming: true }))).toBeNull();
  });

  it("says an error once, title and guidance", () => {
    const error = { title: "MatterWave could not be reached", guidance: "Check the connection.", retryable: true, requestId: null };
    expect(announcement(view({ streaming: true }), view({ error }))).toBe("MatterWave could not be reached. Check the connection.");
    expect(announcement(view({ error }), view({ error }))).toBeNull();
  });
});
