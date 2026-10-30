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
    temporary: false,
    instructions: null,
    feedback: {},
    notifications: [],
    unreadNotifications: 0,
    usage: null,
    ...over,
  };
}

function assistantEntry(id = "a1"): { message: Message; siblingIndex: number; siblingCount: number } {
  return {
    message: message({ id, role: "assistant", parent_id: "u1", parts: [{ type: "text", text: "Answer" }] }),
    siblingIndex: 1,
    siblingCount: 1,
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
    // The composer's own textarea: the instructions editor holds one too.
    const input = document.querySelector(".composer textarea") as HTMLTextAreaElement;
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

  it("opens a reasons and comment picker on thumbs-down, sends them, and withdraws on a re-click", () => {
    post({ type: "state", state: state({ transcript: [assistantEntry("a2")] }) });
    const thumbs = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".msg .actions button"));
    // Opening the picker sends nothing; the last intent on record is the
    // previous test's, so the count is what tells this click stayed quiet.
    const before = sent.length;
    thumbs()
      .find((b) => b.textContent === "Dislike")
      ?.click();
    // The picker opens instead of the rating going out at once.
    expect(sent.length).toBe(before);
    expect(document.querySelector(".fb-picker")).toBeTruthy();

    const boxes = Array.from(document.querySelectorAll<HTMLInputElement>(".fb-picker input[type=checkbox]"));
    expect(boxes.map((b) => b.value)).toEqual(["wrong", "unhelpful", "incomplete", "too_long", "off_topic", "unsafe"]);
    boxes.find((b) => b.value === "wrong")!.checked = true;
    boxes.find((b) => b.value === "unsafe")!.checked = true;
    const comment = document.querySelector(".fb-picker textarea") as HTMLTextAreaElement;
    comment.value = "  made it up  ";
    Array.from(document.querySelectorAll<HTMLButtonElement>(".fb-picker button"))
      .find((b) => b.textContent === "Send")
      ?.click();
    expect(sent.at(-1)).toEqual({
      type: "rateMessage",
      messageId: "a2",
      rating: -1,
      reasons: ["wrong", "unsafe"],
      comment: "made it up",
    });
    expect(thumbs().map((b) => b.textContent)).toContain("Disliked");
    expect(document.querySelector(".fb-picker")).toBeNull();

    // A re-click on the raised thumb withdraws.
    thumbs()
      .find((b) => b.textContent === "Disliked")
      ?.click();
    expect(sent.at(-1)).toEqual({ type: "rateMessage", messageId: "a2", rating: 0 });
  });

  it("skips the picker with a plain thumbs-down when Skip is pressed", () => {
    post({ type: "state", state: state({ transcript: [assistantEntry("a3")] }) });
    Array.from(document.querySelectorAll<HTMLButtonElement>(".msg .actions button"))
      .find((b) => b.textContent === "Dislike")
      ?.click();
    Array.from(document.querySelectorAll<HTMLButtonElement>(".fb-picker button"))
      .find((b) => b.textContent === "Skip")
      ?.click();
    expect(sent.at(-1)).toEqual({ type: "rateMessage", messageId: "a3", rating: -1 });
  });

  it("shows the feedback the server rehydrated on open", () => {
    post({
      type: "state",
      state: state({ transcript: [assistantEntry("a4")], feedback: { a4: { rating: 1, reasons: [], comment: null } } }),
    });
    const thumbs = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".msg .actions button"));
    expect(thumbs().map((b) => b.textContent)).toContain("Liked");
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

  it("offers the temporary toggle before the first send only, and sends the flag with it", () => {
    post({ type: "state", state: state({ activeId: null, conversations: [] }) });
    const row = () => document.querySelector(".temporary") as HTMLElement;
    expect(row().hasAttribute("hidden")).toBe(false);
    const toggle = document.getElementById("temporary-chat") as HTMLInputElement;
    toggle.checked = true;
    const input = document.querySelector(".composer textarea") as HTMLTextAreaElement;
    input.value = "Off the record";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(sent.at(-1)).toEqual({ type: "send", content: "Off the record", temporary: true });

    // Once the conversation exists the toggle is gone, and a plain send sends no flag.
    post({ type: "state", state: state({}) });
    expect(row().hasAttribute("hidden")).toBe(true);
    input.value = "On the record";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(sent.at(-1)).toEqual({ type: "send", content: "On the record" });
  });

  it("hides Share and shows the temporary notice while the chat is temporary", () => {
    post({ type: "state", state: state({ temporary: true }) });
    const headerButtons = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".bar button")).map((b) => b.textContent);
    expect(headerButtons()).not.toContain("Share");
    expect(document.querySelector(".notice")?.textContent).toBe(
      "Temporary chat. It won't appear in your history or search, can't be shared, and is deleted 24 hours after the last message.",
    );
    post({ type: "state", state: state({ temporary: false }) });
    expect(headerButtons()).toContain("Share");
    expect(document.querySelector(".notice")?.textContent ?? "").not.toContain("Temporary chat");
  });

  it("shows the instructions badge while instructions are in force, and opens the editor from it", () => {
    post({
      type: "state",
      state: state({ instructions: { conversation: null, effective: "Be brief.", overridden: false } }),
    });
    const badge = Array.from(document.querySelectorAll<HTMLButtonElement>(".meta button")).find(
      (b) => b.textContent === "Instructions on",
    );
    expect(badge).toBeTruthy();
    badge?.click();
    const panel = document.querySelector(".instructions") as HTMLElement;
    expect(panel.hasAttribute("hidden")).toBe(false);
    expect(panel.textContent).toContain("using your instructions");
    expect((document.querySelector(".instructions details") as HTMLElement).textContent).toContain("Be brief.");
    // Close, so the editor starts shut for whatever looks at it next.
    Array.from(panel.querySelectorAll<HTMLButtonElement>("button"))
      .find((b) => b.textContent === "Close")
      ?.click();
    expect((document.querySelector(".instructions") as HTMLElement).hasAttribute("hidden")).toBe(true);
  });

  it("saves the conversation's instructions, and Use my instructions sends null", () => {
    post({
      type: "state",
      state: state({ instructions: { conversation: "Cite sources", effective: "Be brief. Cite sources", overridden: true } }),
    });
    const chip = Array.from(document.querySelectorAll<HTMLButtonElement>(".meta button")).find(
      (b) => b.textContent === "Instructions on",
    );
    chip?.click();
    const panel = document.querySelector(".instructions") as HTMLElement;
    expect(panel.hasAttribute("hidden")).toBe(false);
    expect((document.querySelector(".instructions textarea") as HTMLTextAreaElement).value).toBe("Cite sources");
    expect(panel.textContent).toContain("using its own instructions");

    const area = document.querySelector(".instructions textarea") as HTMLTextAreaElement;
    area.value = "  Answer in French  ";
    Array.from(document.querySelectorAll<HTMLButtonElement>(".instructions button"))
      .find((b) => b.textContent === "Save")
      ?.click();
    expect(sent.at(-1)).toEqual({ type: "setInstructions", text: "Answer in French" });

    Array.from(document.querySelectorAll<HTMLButtonElement>(".instructions button"))
      .find((b) => b.textContent === "Use my instructions")
      ?.click();
    expect(sent.at(-1)).toEqual({ type: "setInstructions", text: null });
    Array.from(panel.querySelectorAll<HTMLButtonElement>("button"))
      .find((b) => b.textContent === "Close")
      ?.click();
  });

  it("opens the instructions editor from the plain chip when none are in force yet", () => {
    post({ type: "state", state: state({}) });
    const chip = Array.from(document.querySelectorAll<HTMLButtonElement>(".meta button")).find(
      (b) => b.textContent === "Instructions",
    );
    expect(chip).toBeTruthy();
    chip?.click();
    expect((document.querySelector(".instructions") as HTMLElement).hasAttribute("hidden")).toBe(false);
    Array.from(document.querySelectorAll<HTMLButtonElement>(".instructions button"))
      .find((b) => b.textContent === "Close")
      ?.click();
    expect((document.querySelector(".instructions") as HTMLElement).hasAttribute("hidden")).toBe(true);
  });

  it("shows the usage line with used, included, percent and the overage state", () => {
    post({
      type: "state",
      state: state({
        usage: { used: 1_200_000, included: 5_000_000, percent: 24, state: "overage", resetsAt: "2026-11-01T00:00:00+00:00", planName: "Team" },
      }),
    });
    const line = document.querySelector(".meta .usage") as HTMLElement;
    expect(line.textContent).toBe("1.2M / 5M tokens · 24% · overage");
    // The exact numbers and the reset ride in the tooltip.
    expect(line.title).toContain("1,200,000 of 5,000,000");
    expect(line.title).toContain("Team plan");
    // Plain sailing is unmarked; the other states say what they are.
    post({ type: "state", state: state({ usage: { used: 10, included: 5_000, percent: 0.2, state: "ok", resetsAt: "2026-11-01T00:00:00+00:00", planName: "Team" } }) });
    const plain = document.querySelector(".meta .usage") as HTMLElement;
    expect(plain.textContent).toBe("10 / 5k tokens · 0%");
    expect(plain.className).not.toContain("warn");
  });

  it("keeps the usage line off while the API has not said", () => {
    post({ type: "state", state: state({ usage: null }) });
    expect(document.querySelector(".meta .usage")).toBeNull();
  });

  it("opens the notifications panel from the bell, and marks one and all read", () => {
    post({
      type: "state",
      state: state({
        unreadNotifications: 1,
        notifications: [
          { id: "n_1", kind: "budget", title: "Budget low", body: "80% of the allowance is used.", createdAt: "2026-10-29T10:00:00+00:00", read: false },
          { id: "n_2", kind: "plan", title: "Plan changed", body: "", createdAt: "2026-10-28T09:00:00+00:00", read: true },
        ],
      }),
    });
    // The bell carries the count and opens with a fresh read.
    const bell = Array.from(document.querySelectorAll<HTMLButtonElement>(".meta button")).find((b) => b.textContent === "Notifications (1)");
    expect(bell?.className).toContain("badge");
    bell?.click();
    expect(sent.at(-1)).toEqual({ type: "refreshNotifications" });

    const rows = () => Array.from(document.querySelectorAll(".notifications .notif"));
    expect(rows()).toHaveLength(2);
    expect(document.querySelector(".notifications")?.textContent).toContain("80% of the allowance is used.");
    // Unread is bold and carries the action; read is not and does not.
    expect(document.querySelector(".notifications .notif-title.unread")?.textContent).toBe("Budget low");
    const actions = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".notifications .notif .row-actions button"));
    expect(actions()).toHaveLength(1);
    actions()[0]?.click();
    expect(sent.at(-1)).toEqual({ type: "readNotification", id: "n_1" });

    // The host's next state confirms it; the remaining action is mark-all.
    post({
      type: "state",
      state: state({
        unreadNotifications: 0,
        notifications: [
          { id: "n_1", kind: "budget", title: "Budget low", body: "80% of the allowance is used.", createdAt: "2026-10-29T10:00:00+00:00", read: true },
          { id: "n_2", kind: "plan", title: "Plan changed", body: "", createdAt: "2026-10-28T09:00:00+00:00", read: true },
        ],
      }),
    });
    expect(document.querySelector(".notifications .notif-title.unread")).toBeNull();
    expect(actions()).toHaveLength(0);
    Array.from(document.querySelectorAll<HTMLButtonElement>(".notifications button"))
      .find((b) => b.textContent === "Mark all read")
      ?.click();
    expect(sent.at(-1)).toEqual({ type: "readAllNotifications" });

    // Empty reads as its own sentence, and Close shuts the panel.
    post({ type: "state", state: state({ notifications: [] }) });
    expect(document.querySelector(".notifications")?.textContent).toContain("Nothing here yet.");
    Array.from(document.querySelectorAll<HTMLButtonElement>(".notifications button"))
      .find((b) => b.textContent === "Close")
      ?.click();
    expect((document.querySelector(".notifications") as HTMLElement).hasAttribute("hidden")).toBe(true);
  });

  it("hides the notifications panel while the rows never loaded, but still asks for them", () => {
    post({ type: "state", state: state({ notifications: null, unreadNotifications: 0 }) });
    const bell = Array.from(document.querySelectorAll<HTMLButtonElement>(".meta button")).find((b) => b.textContent === "Notifications");
    expect(bell?.className).not.toContain("badge");
    bell?.click();
    // The ask goes out either way; the panel opens only when rows arrive.
    expect(sent.at(-1)).toEqual({ type: "refreshNotifications" });
    expect((document.querySelector(".notifications") as HTMLElement).hasAttribute("hidden")).toBe(true);
  });
});
