// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Message } from "../src/api/types";
import type { HostMessage, ViewState, WebviewMessage } from "../src/chat/protocol";
import { chatHtml } from "../src/chat/viewProvider";

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
    conversations: [{ id: "c_1", title: "Clock", pinned: false, archived: false, badge: null }],
    archivedConversations: [],
    moreConversations: false,
    moreArchived: false,
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
    notificationsUnreadOnly: false,
    notificationsComplete: true,
    usage: null,
    agent: null,
    budget: null,
    answerUsage: {},
    promptNames: [],
    announcements: [],
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
  // The page the view provider serves, less its script: the same landmarks and live region.
  const page = chatHtml({ cspSource: "vscode-resource:", scriptUri: "vscode-resource:/webview.js", nonce: "n" });
  document.documentElement.lang = /<html lang="([^"]+)"/.exec(page)?.[1] ?? "";
  document.title = /<title>([^<]*)<\/title>/.exec(page)?.[1] ?? "";
  document.body.innerHTML = /<body>([\s\S]*?)<script/.exec(page)?.[1] ?? "";
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

  it("offers Apply under each code block of a finished answer and sends its intent", () => {
    post({
      type: "state",
      state: state({
        transcript: [
          {
            message: message({
              id: "a_code",
              role: "assistant",
              parts: [{ type: "text", text: "Use this:\n\n```python api/jobs.py\nprint(1)\n```\n" }],
            }),
            siblingIndex: 1,
            siblingCount: 1,
          },
        ],
      }),
    });
    const apply = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Apply → api/jobs.py");
    expect(apply).toBeDefined();
    apply?.click();
    expect(sent.at(-1)).toEqual({ type: "applyCodeBlock", messageId: "a_code", blockIndex: 0 });
  });

  it("offers no Apply while the answer is still streaming", () => {
    post({
      type: "state",
      state: state({
        streaming: true,
        live: message({ id: "", role: "assistant", parts: [{ type: "text", text: "```py x.py\n1\n```" }] }),
      }),
    });
    expect(Array.from(document.querySelectorAll("button")).some((b) => b.textContent?.startsWith("Apply"))).toBe(false);
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
          { id: "c_1", title: "Clock", pinned: true, archived: false, badge: null },
          { id: "c_2", title: "Weather", pinned: false, archived: false, badge: null },
        ],
        archivedConversations: [{ id: "c_3", title: "Old", pinned: false, archived: true, badge: null }],
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

  it("offers Load more at the end of a list with more rows, and asks once per state", () => {
    post({ type: "state", state: state({ moreConversations: true }) });
    const lists = document.querySelectorAll<HTMLElement>(".convos-list");
    const more = Array.from(lists[0]?.querySelectorAll("button") ?? []).find((b) => b.textContent === "Load more");
    expect(more).toBeDefined();
    sent.length = 0;
    more?.click();
    more?.click();
    expect(sent).toEqual([{ type: "loadMoreConversations", archived: false }]);

    // Scrolling to the end asks too, once the next state has landed.
    post({ type: "state", state: state({ moreConversations: true }) });
    sent.length = 0;
    lists[0]?.dispatchEvent(new Event("scroll"));
    expect(sent).toEqual([{ type: "loadMoreConversations", archived: false }]);

    // No more rows, no button; a search with more hits pages the same way.
    post({ type: "state", state: state({ moreConversations: false }) });
    expect(Array.from(lists[0]?.querySelectorAll("button") ?? []).some((b) => b.textContent === "Load more")).toBe(false);
    post({ type: "state", state: state({ moreConversations: true, searchResults: [] }) });
    expect(Array.from(lists[0]?.querySelectorAll("button") ?? []).some((b) => b.textContent === "Load more")).toBe(true);
  });

  it("offers Load more under the archive on its own", () => {
    post({
      type: "state",
      state: state({ moreArchived: true, archivedConversations: [{ id: "c_9", title: "Old", pinned: false, archived: true, badge: null }] }),
    });
    const archive = document.querySelectorAll<HTMLElement>(".convos-list")[1];
    sent.length = 0;
    Array.from(archive?.querySelectorAll("button") ?? []).find((b) => b.textContent === "Load more")?.click();
    expect(sent).toEqual([{ type: "loadMoreConversations", archived: true }]);
  });

  it("announces a finished answer once through the status region, and never makes the transcript live", () => {
    post({ type: "state", state: state({ streaming: true, transcript: [] }) });
    expect(document.querySelector(".transcript")?.getAttribute("aria-live")).toBeNull();
    post({ type: "state", state: state({ streaming: false, transcript: [assistantEntry("a9")] }) });
    const announcer = document.getElementById("announcer");
    expect(announcer?.getAttribute("role")).toBe("status");
    expect(announcer?.textContent).toBe("MatterWave answered: Answer");
  });

  it("passes axe's checks for a signed-in view with a conversation, a code block and an error", async () => {
    const axe = (await import("axe-core")).default;
    post({
      type: "state",
      state: state({
        transcript: [
          { message: message({ id: "u1", role: "user", parts: [{ type: "text", text: "Fix it" }], content: "Fix it" }), siblingIndex: 1, siblingCount: 1 },
          {
            message: message({ id: "a1", role: "assistant", parent_id: "u1", parts: [{ type: "text", text: "Here:\n\n```ts src/a.ts\nconst a = 1;\n```" }] }),
            siblingIndex: 1,
            siblingCount: 2,
          },
        ],
        error: { title: "Something failed", guidance: "Try again.", retryable: true, requestId: "req-1" },
      }),
    });
    // Colours come from the editor's theme variables, which a test page does not have.
    const results = await axe.run(document, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`)).toEqual([]);
  });

  it("offers Insert and Copy beside Apply, and colours the code from the theme without parsing it as HTML", () => {
    const text = 'Here:\n\n```ts src/a.ts\nconst a = "<b>x</b>"; // note\n```';
    post({
      type: "state",
      state: state({ transcript: [{ ...assistantEntry("a1"), message: { ...assistantEntry("a1").message, parts: [{ type: "text", text }] } }] }),
    });
    const bar = document.querySelector(".apply-bar");
    expect(Array.from(bar?.querySelectorAll("button") ?? []).map((b) => b.textContent)).toEqual(["Apply → src/a.ts", "Insert", "Copy"]);
    sent.length = 0;
    bar?.querySelectorAll("button").forEach((b, at) => at > 0 && b.click());
    expect(sent).toEqual([
      { type: "insertCodeBlock", messageId: "a1", blockIndex: 0 },
      { type: "copyCodeBlock", messageId: "a1", blockIndex: 0 },
    ]);
    const code = document.querySelector(".apply-wrap pre code") as HTMLElement;
    expect(code.querySelector(".tok-keyword")?.textContent).toBe("const");
    expect(code.querySelector(".tok-string")?.textContent).toBe('"<b>x</b>"');
    expect(code.querySelector(".tok-comment")?.textContent).toBe("// note");
    expect(code.querySelector("b")).toBeNull();
    expect(code.textContent).toBe('const a = "<b>x</b>"; // note');
  });

  it("completes @ and / in the composer, with the keyboard", () => {
    post({ type: "state", state: state({ promptNames: ["code-review"] }) });
    const input = document.querySelector(".composer textarea") as HTMLTextAreaElement;
    const list = document.getElementById("composer-suggestions") as HTMLElement;
    input.value = "/co";
    input.setSelectionRange(3, 3);
    input.dispatchEvent(new Event("input"));
    expect(list.hidden).toBe(false);
    expect(Array.from(list.querySelectorAll("[role=option]")).map((o) => o.firstChild?.textContent)).toEqual(["/compact", "/context", "/code-review"]);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect(input.getAttribute("aria-activedescendant")).toBe("composer-suggestion-2");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(input.value).toBe("/code-review ");
    expect(list.hidden).toBe(true);

    input.value = "look at @te";
    input.setSelectionRange(11, 11);
    input.dispatchEvent(new Event("input"));
    sent.length = 0;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(input.value).toBe("look at @terminal ");
    // Enter took the suggestion; it did not send.
    expect(sent).toEqual([]);
    input.value = "";
  });

  it("offers Fork on a message and Report on an answer, and sends their intents", () => {
    post({ type: "state", state: state({ transcript: [assistantEntry("a1")] }) });
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".msg .actions button"));
    sent.length = 0;
    buttons.find((b) => b.textContent === "Fork")?.click();
    buttons.find((b) => b.textContent === "Report")?.click();
    expect(sent).toEqual([
      { type: "forkConversation", messageId: "a1" },
      { type: "reportMessage", messageId: "a1" },
    ]);
    // A temporary conversation cannot be forked, so it is not offered.
    post({ type: "state", state: state({ temporary: true, transcript: [assistantEntry("a1")] }) });
    expect(Array.from(document.querySelectorAll(".msg .actions button")).some((b) => b.textContent === "Fork")).toBe(false);
  });

  it("shows an announcement with Open and Dismiss, and no Dismiss on one that may not be", () => {
    post({
      type: "state",
      state: state({
        announcements: [
          { id: "an_1", message: "Maintenance at 02:00 UTC.", severity: "warning", link: "https://mw.test/status", dismissible: true },
          { id: "an_2", message: "Read the new terms.", severity: "critical", link: null, dismissible: false },
        ],
      }),
    });
    const banners = Array.from(document.querySelectorAll<HTMLElement>(".announcement"));
    expect(banners.map((b) => b.className)).toEqual(["notice announcement warning", "notice announcement critical"]);
    sent.length = 0;
    banners[0]?.querySelectorAll("button").forEach((b) => b.click());
    expect(sent).toEqual([
      { type: "openNotification", id: "an_1", url: "https://mw.test/status" },
      { type: "dismissAnnouncement", id: "an_1" },
    ]);
    expect(banners[1]?.querySelectorAll("button")).toHaveLength(0);
  });

  it("shows an answer's tokens and cost under it, and nothing for one without a count", () => {
    post({
      type: "state",
      state: state({
        transcript: [assistantEntry("a1"), assistantEntry("a2")],
        answerUsage: { a1: { promptTokens: 1200, completionTokens: 34, costUsd: 0.000651 } },
      }),
    });
    const lines = Array.from(document.querySelectorAll(".answer-usage")).map((n) => n.textContent);
    expect(lines).toEqual(["1,200 in · 34 out · $0.0007"]);
  });

  it("shows a row's library badge as a suffix on its title, and nothing when there is none", () => {
    post({
      type: "state",
      state: state({
        conversations: [
          { id: "c_1", title: "Clock", pinned: false, archived: false, badge: "Work · bug" },
          { id: "c_2", title: "Weather", pinned: false, archived: false, badge: null },
        ],
      }),
    });
    const badges = Array.from(document.querySelectorAll<HTMLElement>(".convos-list .lib-badge"));
    expect(badges.map((b) => b.textContent)).toEqual(["Work · bug"]);
    // The badge rides the title it belongs to, inside the same button.
    const titles = Array.from(document.querySelectorAll<HTMLButtonElement>(".convos-list .row .title"));
    expect(titles[0]?.textContent).toBe("ClockWork · bug");
    expect(titles[1]?.querySelector(".lib-badge")).toBeNull();
  });

  it("searches from the sidebar box, debounced, and shows the results", async () => {
    vi.useFakeTimers();
    try {
      post({
        type: "state",
        state: state({
          searchResults: [{ id: "c_9", title: "Clock tower", pinned: false, archived: false, badge: null, snippet: "…the clock…" }],
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
    expect(thumbs().map((b) => b.textContent)).toEqual(["Like", "Dislike", "Regenerate", "Report", "Fork"]);
    thumbs()
      .find((b) => b.textContent === "Like")
      ?.click();
    expect(sent.at(-1)).toEqual({ type: "rateMessage", messageId: "a1", rating: 1 });
    // The webview's own copy of the rating shows immediately, without a round-trip.
    expect(thumbs().map((b) => b.textContent)).toEqual(["Liked", "Dislike", "Regenerate", "Report", "Fork"]);
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
        usage: { used: 1_200_000, included: 5_000_000, percent: 24, state: "overage", resetsAt: "2026-11-01T00:00:00+00:00", planName: "Team", memberCap: null },
      }),
    });
    const line = document.querySelector(".meta .usage") as HTMLElement;
    expect(line.textContent).toBe("1.2M / 5M tokens · 24% · overage");
    // The exact numbers and the reset ride in the tooltip.
    expect(line.title).toContain("1,200,000 of 5,000,000");
    expect(line.title).toContain("Team plan");
    // Plain sailing is unmarked; the other states say what they are.
    post({ type: "state", state: state({ usage: { used: 10, included: 5_000, percent: 0.2, state: "ok", resetsAt: "2026-11-01T00:00:00+00:00", planName: "Team", memberCap: null } }) });
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
          { id: "n_1", kind: "budget", title: "Budget low", body: "80% of the allowance is used.", link: null, createdAt: "2026-10-29T10:00:00+00:00", read: false },
          { id: "n_2", kind: "plan", title: "Plan changed", body: "", link: null, createdAt: "2026-10-28T09:00:00+00:00", read: true },
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
          { id: "n_1", kind: "budget", title: "Budget low", body: "80% of the allowance is used.", link: null, createdAt: "2026-10-29T10:00:00+00:00", read: true },
          { id: "n_2", kind: "plan", title: "Plan changed", body: "", link: null, createdAt: "2026-10-28T09:00:00+00:00", read: true },
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

  it("gives a row with a link an Open action that asks the host to follow it", () => {
    post({
      type: "state",
      state: state({
        notifications: [
          { id: "n_1", kind: "mention", title: "You were mentioned", body: "Take a look.", link: "/apps/chat?c=c_9", createdAt: "2026-10-30T09:00:00+00:00", read: false },
        ],
      }),
    });
    Array.from(document.querySelectorAll<HTMLButtonElement>(".meta button"))
      .find((b) => b.textContent === "Notifications")
      ?.click();
    const open = Array.from(document.querySelectorAll<HTMLButtonElement>(".notifications .notif .row-actions button"))
      .find((b) => b.textContent === "Open");
    expect(open).not.toBeNull();
    open?.click();
    expect(sent.at(-1)).toEqual({ type: "openNotification", id: "n_1", url: "/apps/chat?c=c_9" });
  });

  it("offers the unread-only filter and Load more, and sends their intents", () => {
    post({
      type: "state",
      state: state({
        notifications: [
          { id: "n_1", kind: "budget", title: "Budget low", body: "", link: null, createdAt: "2026-10-29T10:00:00+00:00", read: false },
        ],
        notificationsComplete: false,
      }),
    });
    Array.from(document.querySelectorAll<HTMLButtonElement>(".meta button"))
      .find((b) => b.textContent === "Notifications")
      ?.click();

    const box = document.getElementById("notifications-unread-only") as HTMLInputElement;
    expect(box.checked).toBe(false);
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    expect(sent.at(-1)).toEqual({ type: "setNotificationsUnreadOnly", on: true });

    const more = Array.from(document.querySelectorAll<HTMLButtonElement>(".notifications button")).find(
      (b) => b.textContent === "Load more",
    );
    expect(more?.hidden).toBe(false);
    more?.click();
    expect(sent.at(-1)).toEqual({ type: "loadMoreNotifications" });

    // With the whole selection on hand the button stands down, and the box
    // follows the host's filter state on the next render.
    post({ type: "state", state: state({ notifications: [], notificationsUnreadOnly: true, notificationsComplete: true }) });
    expect((document.getElementById("notifications-unread-only") as HTMLInputElement).checked).toBe(true);
    expect(more?.hidden).toBe(true);
    expect(document.querySelector(".notifications")?.textContent).toContain("No unread notifications.");
  });
});

describe("image previews", () => {
  it("shows the named chip until the bytes arrive, then the picture", () => {
    const imageMessage = message({
      id: "u9",
      role: "user",
      parts: [{ type: "image", attachment_id: "att_1", filename: "shot.png", content_type: "image/png" }],
      content: "What is in this picture?",
    });
    post({ type: "state", state: state({ transcript: [{ message: imageMessage, siblingIndex: 1, siblingCount: 1 }] }) });
    // No bytes yet: the chip names what was attached.
    expect(document.querySelector(".transcript img")).toBeNull();
    expect(document.querySelector(".transcript .cut")?.textContent).toContain("Attached image shot.png");

    post({ type: "imageData", attachmentId: "att_1", dataUri: "data:image/png;base64,aGVsbG8=" });
    const img = document.querySelector<HTMLImageElement>(".transcript img.image-preview");
    expect(img?.getAttribute("src")).toBe("data:image/png;base64,aGVsbG8=");
    expect(img?.getAttribute("alt")).toBe("shot.png");
  });

  it("never puts a non-data: or wrong-typed URI in an img src", () => {
    const imageMessage = message({
      id: "u9",
      role: "user",
      parts: [{ type: "image", attachment_id: "att_2", filename: "x.png", content_type: "image/png" }],
      content: "look",
    });
    post({ type: "state", state: state({ transcript: [{ message: imageMessage, siblingIndex: 1, siblingCount: 1 }] }) });
    post({ type: "imageData", attachmentId: "att_2", dataUri: "javascript:alert(1)" });
    post({ type: "imageData", attachmentId: "att_2", dataUri: "data:text/html;base64,PHNjcmlwdD4=" });
    expect(document.querySelector(".transcript img")).toBeNull();
  });

  it("shows who is acting in the meta line", () => {
    post({ type: "state", state: state({ identity: "Ada" }) });
    expect(document.querySelector(".meta .identity")?.textContent).toBe("Ada");
  });
});

describe("agent mode in the view", () => {
  function agent(over: Partial<NonNullable<ViewState["agent"]>> = {}): NonNullable<ViewState["agent"]> {
    return {
      enabled: true,
      available: true,
      reason: null,
      mode: "ask",
      modes: ["plan", "ask", "auto-edit"],
      modeSummary: "The user approves each file change and each command.",
      root: { name: "app", path: "/work/app" },
      multiRoot: false,
      running: false,
      status: null,
      output: null,
      pending: null,
      todos: [],
      contextFiles: [],
      contextNotice: null,
      mcp: [],
      steps: 0,
      maxSteps: 40,
      tokens: 0,
      maxTokens: 500000,
      runs: [],
      ...over,
    };
  }
  const buttonNamed = (label: string) => Array.from(document.querySelectorAll("button")).find((b) => b.textContent === label);

  it("greys the toggle out with the reason when the agent cannot run", () => {
    post({ type: "state", state: state({ agent: agent({ enabled: false, available: false, reason: "GRT Tiny cannot call tools." }) }) });
    const box = document.querySelector<HTMLInputElement>("#agent-mode")!;
    expect(box.disabled).toBe(true);
    expect(box.checked).toBe(false);
    expect(document.querySelector(".agent-reason")?.textContent).toBe("GRT Tiny cannot call tools.");
    expect(document.querySelector<HTMLElement>(".mode-chip")!.hidden).toBe(true);
  });

  it("shows the mode at all times while on, cycles it on click and on Shift+Tab, and names the root", () => {
    post({ type: "state", state: state({ agent: agent({ mode: "auto-edit" }) }) });
    const chip = document.querySelector<HTMLButtonElement>(".mode-chip")!;
    expect(chip.hidden).toBe(false);
    expect(chip.textContent).toBe("auto-edit");
    expect(document.querySelector(".agent-bar .root")?.textContent).toBe("in app");
    chip.click();
    expect(sent.at(-1)).toEqual({ type: "agentCycleMode" });
    const input = document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
    sent.length = 0;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    expect(sent).toEqual([{ type: "agentCycleMode" }]);
    expect(input.placeholder).toContain("Shift+Tab changes the mode");
    // The mode stays visible mid-run too.
    post({ type: "state", state: state({ streaming: true, agent: agent({ running: true, status: "run_shell npm test", output: "PASS", steps: 3, tokens: 12000 }) }) });
    expect(chip.hidden).toBe(false);
    expect(document.querySelector(".agent-status")?.textContent).toContain("run_shell npm test — step 3/40");
    expect(document.querySelector(".agent-status pre.output")?.textContent).toBe("PASS");
  });

  it("does not take Shift+Tab while the agent is off", () => {
    post({ type: "state", state: state({ agent: agent({ enabled: false }) }) });
    sent.length = 0;
    const input = document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    expect(sent).toEqual([]);
  });

  it("asks about a change with its diff, and about a command shown whole", () => {
    post({
      type: "state",
      state: state({
        agent: agent({
          pending: { id: "a1", kind: "edit", tool: "edit", title: "Change src/a.ts", detail: "src/a.ts", path: "src/a.ts", diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n" },
        }),
      }),
    });
    expect(document.querySelector(".approval .who")?.textContent).toBe("Change src/a.ts");
    expect(document.querySelector(".approval pre.diff .add")?.textContent).toBe("+new\n");
    buttonNamed("Accept")!.click();
    expect(sent.at(-1)).toEqual({ type: "agentDecide", id: "a1", accept: true });
    buttonNamed("Show diff")!.click();
    expect(sent.at(-1)).toEqual({ type: "agentShowDiff", id: "a1" });
    const command = "npm test -- --runInBand && rm -rf /tmp/really/long/path/that/is/not/shortened";
    post({ type: "state", state: state({ agent: agent({ pending: { id: "a2", kind: "shell", tool: "run_shell", title: "Run a command", detail: command, path: null, diff: null } }) }) });
    expect(document.querySelector(".approval pre.command")?.textContent).toBe(command);
    buttonNamed("Reject")!.click();
    expect(sent.at(-1)).toEqual({ type: "agentDecide", id: "a2", accept: false });
  });

  it("shows the plan's checklist", () => {
    post({
      type: "state",
      state: state({ agent: agent({ todos: [{ content: "Read the code", status: "completed" }, { content: "Write the test", status: "in_progress" }, { content: "Run it", status: "pending" }] }) }),
    });
    expect(document.querySelector(".todos .who")?.textContent).toBe("Plan · 1/3 done");
    expect(Array.from(document.querySelectorAll(".todos .todo")).map((n) => n.textContent)).toEqual(["☑ Read the code", "◐ Write the test", "☐ Run it"]);
  });

  it("opens the usage panel with this session's runs and the budget", () => {
    post({
      type: "state",
      state: state({
        agent: agent({ runs: [{ startedAt: "2026-10-31T10:00:00Z", prompt: "Fix the bug", status: "done", steps: 4, toolCalls: 3, promptTokens: 9000, completionTokens: 1000, tokens: 10000, durationMs: 12000 }] }),
        budget: { includedTokens: 5_000_000, tokensUsed: 1_000_000, overageDollars: 0, overageCapDollars: 50, memberSpentDollars: 1.25, memberCapDollars: null },
      }),
    });
    sent.length = 0;
    buttonNamed("Usage")!.click();
    expect(sent).toEqual([{ type: "refreshUsage" }]);
    const panel = document.querySelector(".usage-panel")!;
    expect(panel.textContent).toContain("Agent runs this session: 1, 10,000 tokens");
    expect(panel.textContent).toContain("4 steps · 3 tools");
    expect(panel.textContent).toContain("your spend $1.25");
  });
});
