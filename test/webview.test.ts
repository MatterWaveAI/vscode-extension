// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Message } from "../src/api/types";
import type { HostMessage, ViewState, WebviewMessage } from "../src/chat/protocol";

const sent: WebviewMessage[] = [];

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

function state(over: Partial<ViewState>): ViewState {
  return {
    signedIn: true,
    offline: false,
    identity: "Ada",
    conversations: [{ id: "c_1", title: "Clock", pinned: false, archived: false }],
    archivedConversations: [],
    searchResults: null,
    activeId: "c_1",
    transcript: [],
    live: null,
    model: { id: "grt-small", label: "GRT Small" },
    meter: { usedTokens: 16384, contextWindow: 32768, compactable: true },
    streaming: false,
    error: null,
    notice: null,
    ...over,
  };
}

function post(msg: HostMessage): void {
  window.dispatchEvent(new MessageEvent("message", { data: msg }));
}

beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div>';
  (globalThis as unknown as { acquireVsCodeApi: unknown }).acquireVsCodeApi = () => ({
    postMessage: (m: WebviewMessage) => sent.push(m),
  });
  await import("../src/webview/main");
});

describe("the chat webview", () => {
  it("says ready on load", () => {
    expect(sent[0]).toEqual({ type: "ready" });
  });

  it("renders parts: markdown text, collapsed tool and reasoning blocks, and no model script", () => {
    post({
      type: "state",
      state: state({
        transcript: [
          { message: message({ id: "u1", role: "user", parts: [{ type: "text", text: "hi <b>there</b>" }], content: "hi <b>there</b>" }), siblingIndex: 1, siblingCount: 1 },
          {
            message: message({
              id: "a1",
              role: "assistant",
              parent_id: "u1",
              truncated: true,
              parts: [
                { type: "reasoning", text: "thinking" },
                { type: "tool_call", id: "t", name: "get_current_time", arguments: "{}" },
                { type: "tool_result", id: "t", output: "10:00", is_error: false },
                { type: "text", text: "**Bold** <img src=x onerror=alert(1)><script>alert(2)</script>" },
              ],
            }),
            siblingIndex: 2,
            siblingCount: 3,
          },
        ],
      }),
    });
    const app = document.getElementById("app") as HTMLElement;
    expect(app.querySelector("strong")?.textContent).toBe("Bold");
    expect(app.querySelector("img, script:not([nonce])")).toBeNull();
    expect(app.querySelectorAll(".transcript details")).toHaveLength(3);
    expect(app.querySelector(".transcript details")?.hasAttribute("open")).toBe(false);
    expect(app.textContent).toContain("2 / 3");
    expect(app.textContent).toContain("50% of context");
    // The user's own text is shown as text, not markup.
    expect(app.querySelector(".msg.user .body")?.textContent).toBe("hi <b>there</b>");

    const cont = Array.from(app.querySelectorAll("button")).find((b) => b.textContent === "Continue");
    cont?.click();
    expect(sent.at(-1)).toEqual({ type: "continue" });
  });

  it("applies streamed parts and deltas to the live message", () => {
    post({ type: "state", state: state({ streaming: true, live: message({ id: "", role: "assistant", parts: [] }) }) });
    post({ type: "part", index: 0, part: { type: "text", text: "" } });
    post({ type: "delta", index: 0, field: "text", text: "Hel" });
    post({ type: "delta", index: 0, field: "text", text: "lo" });
    expect(document.querySelector("[data-live]")?.textContent).toContain("Hello");
  });

  it("shows the compaction divider and its originals on request", () => {
    const original = message({ id: "o1", role: "user", parts: [{ type: "text", text: "the old question" }] });
    post({
      type: "state",
      state: state({
        transcript: [
          {
            message: message({ id: "s1", role: "system", parts: [{ type: "summary", text: "Earlier: a question.", covers_from: "o1", covers_to: "o1" }] }),
            siblingIndex: 1,
            siblingCount: 1,
            originals: [original],
          },
        ],
      }),
    });
    const show = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Show originals");
    expect(document.body.textContent).not.toContain("the old question");
    show?.click();
    expect(document.body.textContent).toContain("the old question");
  });

  it("closes the composer while offline and keeps the draft", () => {
    post({ type: "state", state: state({}) });
    const input = document.querySelector("textarea") as HTMLTextAreaElement;
    input.value = "half-typed question";
    post({ type: "state", state: state({ offline: true }) });
    expect(input.disabled).toBe(true);
    expect(input.value).toBe("half-typed question");
    const before = sent.length;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(sent.length).toBe(before);
    const reconnect = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Reconnect");
    reconnect?.click();
    expect(sent.at(-1)).toEqual({ type: "reconnect" });
    post({ type: "state", state: state({ offline: false }) });
    expect(input.disabled).toBe(false);
    expect(input.value).toBe("half-typed question");
  });

  it("shows the error copy with its reference", () => {
    post({
      type: "state",
      state: state({ error: { title: "The model gateway did not answer", guidance: "Try again.", retryable: true, requestId: "req-1" } }),
    });
    expect(document.querySelector(".error")?.textContent).toContain("Reference: req-1");
  });

  it("renders the sidebar rows with their actions, and sends their intents", () => {
    post({
      type: "state",
      state: state({
        conversations: [
          { id: "c_1", title: "Clock", pinned: true, archived: false },
          { id: "c_2", title: "Weather", pinned: false, archived: false },
        ],
        archivedConversations: [{ id: "c_3", title: "Old", pinned: false, archived: true }],
      }),
    });
    const titles = Array.from(document.querySelectorAll<HTMLButtonElement>(".convos > .convos-list .row .title"));
    expect(titles.map((r) => r.textContent)).toEqual(["Clock", "Weather"]);
    // The pinned conversation leads, exactly as the server ordered it.
    expect(document.querySelector(".convos-list .row")?.className).toContain("active");

    const buttonsIn = (row: number) => Array.from(document.querySelectorAll<HTMLButtonElement>(".convos-list > .row")[row]?.querySelectorAll("button") ?? []);
    // Pin toggles, archive archives, delete confirms before sending.
    buttonsIn(1)
      .find((b) => b.textContent === "Pin")
      ?.click();
    expect(sent.at(-1)).toEqual({ type: "pinConversation", id: "c_2", pinned: true });
    buttonsIn(1)
      .find((b) => b.textContent === "Archive")
      ?.click();
    expect(sent.at(-1)).toEqual({ type: "archiveConversation", id: "c_2", archived: true });
    buttonsIn(1)
      .find((b) => b.textContent === "Delete")
      ?.click();
    expect(sent.at(-1)?.type).not.toBe("deleteConversation");
    // Re-rendered: the delete now asks for confirmation first.
    expect(buttonsIn(1).find((b) => b.textContent === "Delete?")).toBeTruthy();
    buttonsIn(1)
      .find((b) => b.textContent === "Delete?")
      ?.click();
    expect(sent.at(-1)).toEqual({ type: "deleteConversation", id: "c_2" });

    // The archive folds away under its own heading, with unarchive and delete.
    expect(document.querySelector(".convos details.archived")?.getAttribute("hidden")).toBeNull();
    const unarchive = Array.from(document.querySelectorAll<HTMLButtonElement>(".convos details.archived button")).find(
      (b) => b.textContent === "Unarchive",
    );
    unarchive?.click();
    expect(sent.at(-1)).toEqual({ type: "archiveConversation", id: "c_3", archived: false });
  });

  it("searches from the sidebar box, debounced, and shows the results", async () => {
    vi.useFakeTimers();
    try {
      post({
        type: "state",
        state: state({
          searchResults: [{ id: "c_9", title: "Clock tower", pinned: false, archived: false, snippet: "…the clock…" }],
        }),
      });
      expect(document.querySelector(".convos-list")?.textContent).toContain("Clock tower");
      expect(document.querySelector(".convos-list")?.textContent).toContain("…the clock…");
      // Searching hides the archive section until the query clears.
      expect(document.querySelector(".convos details.archived")?.getAttribute("hidden")).not.toBeNull();

      const box = document.querySelector(".convos input") as HTMLInputElement;
      box.value = "clock";
      box.dispatchEvent(new Event("input", { bubbles: true }));
      expect(sent.at(-1)?.type).not.toBe("searchConversations");
      vi.advanceTimersByTime(300);
      expect(sent.at(-1)).toEqual({ type: "searchConversations", query: "clock" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends feedback from the thumbs under a reply, and withdraws it", () => {
    post({
      type: "state",
      state: state({
        transcript: [
          {
            message: message({ id: "a1", role: "assistant", parent_id: "u1", parts: [{ type: "text", text: "Answer" }] }),
            siblingIndex: 1,
            siblingCount: 1,
          },
        ],
      }),
    });
    const thumbs = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".msg .actions button"));
    expect(thumbs().map((b) => b.textContent)).toEqual(["Like", "Dislike", "Regenerate"]);
    thumbs()
      .find((b) => b.textContent === "Like")
      ?.click();
    expect(sent.at(-1)).toEqual({ type: "rateMessage", messageId: "a1", rating: 1 });
    // The webview's own copy of the rating shows immediately, without a round-trip.
    expect(thumbs().map((b) => b.textContent)).toEqual(["Liked", "Dislike", "Regenerate"]);
    thumbs()
      .find((b) => b.textContent === "Liked")
      ?.click();
    expect(sent.at(-1)).toEqual({ type: "rateMessage", messageId: "a1", rating: 0 });
  });

  it("offers export and share only while a conversation is open", () => {
    post({ type: "state", state: state({}) });
    const headerButtons = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".bar button"));
    expect(headerButtons().find((b) => b.textContent === "Export")?.disabled).toBe(false);
    expect(headerButtons().find((b) => b.textContent === "Share")?.disabled).toBe(false);
    headerButtons()
      .find((b) => b.textContent === "Export")
      ?.click();
    expect(sent.at(-1)).toEqual({ type: "exportConversation" });
    headerButtons()
      .find((b) => b.textContent === "Share")
      ?.click();
    expect(sent.at(-1)).toEqual({ type: "shareConversation" });

    post({ type: "state", state: state({ activeId: null }) });
    expect(headerButtons().find((b) => b.textContent === "Export")?.disabled).toBe(true);
    expect(headerButtons().find((b) => b.textContent === "Share")?.disabled).toBe(true);
  });
});
