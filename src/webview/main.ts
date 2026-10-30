import type { FeedbackReason, Message, Part } from "../api/types";
import { appendDelta, setPart } from "../chat/assemble";
import type { FeedbackSummary, HostMessage, NotificationView, TranscriptEntry, UsageView, ViewState, WebviewMessage } from "../chat/protocol";
import { trustedImageDataUri } from "../chat/images";
import { renderMarkdown } from "./markdown";

/**
 * The chat view's script. It only renders and reports intents: there is no
 * fetch here and no credential to make one with. All model text goes through
 * `renderMarkdown` (escaped, then sanitised); everything else is set with
 * `textContent`.
 */

declare function acquireVsCodeApi(): { postMessage(message: WebviewMessage): void };

const vscode = acquireVsCodeApi();
const send = (message: WebviewMessage) => vscode.postMessage(message);

const TEMPORARY_NOTICE =
  "Temporary chat. It won't appear in your history or search, can't be shared, and is deleted 24 hours after the last message.";

const FEEDBACK_REASONS: readonly { value: FeedbackReason; label: string }[] = [
  { value: "wrong", label: "It is wrong" },
  { value: "unhelpful", label: "It did not help" },
  { value: "incomplete", label: "It is incomplete" },
  { value: "too_long", label: "It is too long" },
  { value: "off_topic", label: "It missed the question" },
  { value: "unsafe", label: "It is unsafe" },
];

let state: ViewState | null = null;
let editingId: string | null = null;
/** The conversation whose rename box is open, and the one a delete is confirmed for. */
let renamingConversationId: string | null = null;
let confirmingDeleteId: string | null = null;
/** The message whose thumbs-down reasons/comment picker is open. */
let feedbackPickerId: string | null = null;
let instructionsOpen = false;
/** Whether the bell's panel is open under the banners. */
let notificationsOpen = false;
/**
 * This session's feedback, over the server's copy so a click shows at once.
 * A null marks a withdrawal. Cleared whenever a full state arrives, which is
 * the host's record taking over again.
 */
const feedbackSession = new Map<string, FeedbackSummary | null>();
const expandedSummaries = new Set<string>();
/**
 * Image attachments this session has been handed, by attachment id. The
 * webview cannot fetch (no network in its CSP), so the host posts the bytes
 * as `data:` URIs here; each survives in the page until the view reloads,
 * which is when the host re-posts them.
 */
const imagePreviews = new Map<string, string>();

const app = document.getElementById("app") as HTMLElement;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; text?: string; title?: string } = {},
  children: (Node | null)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.title) node.title = props.title;
  for (const child of children) if (child) node.appendChild(child);
  return node;
}

function button(label: string, onClick: () => void, opts: { className?: string; title?: string; disabled?: boolean } = {}): HTMLButtonElement {
  const b = el("button", { className: opts.className, text: label, title: opts.title });
  b.type = "button";
  b.disabled = opts.disabled ?? false;
  b.addEventListener("click", onClick);
  return b;
}

// --- the static frame: built once so the composer keeps its draft ---------------

const header = el("div", { className: "bar" });
const convos = el("div", { className: "convos" });
const convoSearch = document.createElement("input");
convoSearch.type = "text";
convoSearch.placeholder = "Search conversations…";
convoSearch.setAttribute("aria-label", "Search conversations");
let searchTimer: ReturnType<typeof setTimeout> | undefined;
convoSearch.addEventListener("input", () => {
  // One request per pause in typing, not per keystroke.
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => send({ type: "searchConversations", query: convoSearch.value }), 250);
});
const convoList = el("div", { className: "convos-list" });
const archivedList = el("div", { className: "convos-list" });
const archivedBlock = el("details", { className: "archived" }, [el("summary", { text: "Archived" }), archivedList]);
convos.append(convoSearch, convoList, archivedBlock);
const meta = el("div", { className: "meta" });
const banners = el("div");
const transcript = el("div", { className: "transcript" });
transcript.setAttribute("aria-live", "polite");
const input = el("textarea");
const PLACEHOLDER = "Ask MatterWave…  (Enter to send, Shift+Enter for a new line)";
const OFFLINE_PLACEHOLDER = "MatterWave cannot be reached. Your draft is kept.";
input.placeholder = PLACEHOLDER;
const temporaryBox = document.createElement("input");
temporaryBox.type = "checkbox";
temporaryBox.id = "temporary-chat";
const temporaryLabel = el("label", { text: "Temporary chat" });
temporaryLabel.htmlFor = "temporary-chat";
const temporaryRow = el("div", { className: "temporary" }, [temporaryBox, temporaryLabel]);
temporaryRow.hidden = true;
const sendButton = button("Send", submit);
const stopButton = button("Stop", () => send({ type: "stop" }));
const composer = el("div", { className: "composer" }, [temporaryRow, input, el("div", { className: "row" }, [stopButton, sendButton])]);
const signIn = el("div", { className: "signin" }, [
  el("p", { text: "Sign in to chat with your organisation's models." }),
  button("Sign in", () => send({ type: "signIn" })),
]);

// The per-chat instructions editor, between the banners and the transcript.
const instructionsPanel = el("div", { className: "instructions" });
instructionsPanel.hidden = true;
const instructionsArea = document.createElement("textarea");
instructionsArea.placeholder = "Instructions for this conversation only. Left empty, it uses yours.";
const instructionsHint = el("div", { className: "hint" });
const instructionsEffective = el("details", {}, [el("summary", { text: "What the model sees" })]);
instructionsPanel.append(
  el("div", { className: "who", text: "Conversation instructions" }),
  instructionsArea,
  instructionsHint,
  el("div", { className: "row" }, [
    button("Close", () => {
      instructionsOpen = false;
      render();
    }, { className: "link" }),
    button("Use my instructions", () => {
      instructionsArea.value = "";
      send({ type: "setInstructions", text: null });
    }, { className: "link", title: "Clear this conversation's own text and use yours" }),
    button("Save", () => {
      const text = instructionsArea.value.trim();
      send({ type: "setInstructions", text: text || null });
    }, { title: "Set this conversation's instructions" }),
  ]),
  instructionsEffective,
);

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submit();
  }
});

// The bell's panel, between the banners and the transcript, like the instructions editor.
const notificationsPanel = el("div", { className: "notifications" });
notificationsPanel.hidden = true;
const notificationsList = el("div", { className: "notif-list" });
notificationsPanel.append(
  el("div", { className: "who", text: "Notifications" }),
  notificationsList,
  el("div", { className: "row" }, [
    button("Close", () => {
      notificationsOpen = false;
      render();
    }, { className: "link" }),
    button("Mark all read", () => send({ type: "readAllNotifications" }), { title: "Mark every notification read" }),
  ]),
);

function submit(): void {
  const content = input.value.trim();
  if (!content || state?.streaming || state?.offline) return;
  // The toggle is offered before the first send only; once a conversation
  // exists, whether it is temporary is already fixed.
  const temporary = temporaryBox.checked && !state?.activeId;
  send({ type: "send", content, ...(temporary ? { temporary: true } : {}) });
  input.value = "";
}

// --- rendering ------------------------------------------------------------------

function render(): void {
  if (!state) return;
  if (!state.signedIn) {
    app.replaceChildren(signIn);
    return;
  }
  if (!app.contains(composer)) app.replaceChildren(header, convos, meta, banners, instructionsPanel, notificationsPanel, transcript, composer);
  renderHeader(state);
  renderConversations(state);
  renderMeta(state);
  renderBanners(state);
  renderInstructions(state);
  renderNotifications(state);
  renderTranscript(state);
  sendButton.disabled = state.streaming || state.offline;
  stopButton.hidden = !state.streaming;
  // Offline, the composer closes but the textarea is never replaced, so the
  // draft is there when the connection is.
  input.disabled = state.offline;
  input.placeholder = state.offline ? OFFLINE_PLACEHOLDER : PLACEHOLDER;
  // The temporary toggle belongs to the not-yet-created chat: it is gone
  // once the first send has made a conversation, whatever kind it is.
  temporaryRow.hidden = Boolean(state.activeId) || state.temporary;
}

function renderHeader(s: ViewState): void {
  const buttons = [
    button(s.model?.label ?? "Pick model", () => send({ type: "pickModel" }), { className: "link", title: "Pick model" }),
    button("+", () => send({ type: "newChat" }), { className: "link", title: "New chat" }),
    button("Export", () => send({ type: "exportConversation" }), { className: "link", disabled: !s.activeId, title: "Save this conversation as Markdown" }),
  ];
  // A temporary conversation cannot be shared: the button has nothing to do.
  if (!s.temporary) {
    buttons.push(button("Share", () => send({ type: "shareConversation" }), { className: "link", disabled: !s.activeId, title: "Copy a read-only link to this conversation" }));
  }
  header.replaceChildren(...buttons);
}

// --- the conversation sidebar ---------------------------------------------------

function renderConversations(s: ViewState): void {
  const rows = s.searchResults ?? s.conversations;
  if (rows.length === 0) {
    convoList.replaceChildren(
      el("p", { className: "empty", text: s.searchResults ? "No conversations match." : "No conversations yet." }),
    );
  } else {
    convoList.replaceChildren(...rows.map((row) => conversationRow(row, s)));
  }
  // The archive folds away, and never during a search: the results are what is asked about.
  archivedBlock.open = archivedBlock.open && !s.searchResults;
  archivedBlock.hidden = s.searchResults !== null || s.archivedConversations.length === 0;
  archivedList.replaceChildren(...s.archivedConversations.map((row) => archivedRow(row)));
}

function conversationRow(row: ViewState["conversations"][number], s: ViewState): HTMLElement {
  const actions = el("div", { className: "row-actions" });
  if (renamingConversationId === row.id) {
    const box = document.createElement("input");
    box.type = "text";
    box.value = row.title;
    box.setAttribute("aria-label", "Conversation name");
    const done = (save: boolean) => {
      const title = box.value.trim();
      renamingConversationId = null;
      confirmingDeleteId = null;
      if (save && title && title !== row.title) send({ type: "renameConversation", id: row.id, title });
      else render();
    };
    box.addEventListener("keydown", (event) => {
      if (event.key === "Enter") done(true);
      else if (event.key === "Escape") done(false);
    });
    box.addEventListener("blur", () => done(true));
    const wrap = el("div", { className: "row" }, [box, button("Save", () => done(true), { className: "link", title: "Save the name" })]);
    setTimeout(() => box.focus(), 0);
    return wrap;
  }
  const title = button(row.title || "Untitled", () => send({ type: "openConversation", id: row.id }), {
    className: "link title",
    title: row.title || "Untitled",
  });
  // The library badge rides the row's label: the folder it is filed in and
  // its tags, dimmed after the title.
  if (row.badge) title.append(el("span", { className: "lib-badge", text: row.badge }));
  actions.append(
    button(row.pinned ? "Unpin" : "Pin", () => send({ type: "pinConversation", id: row.id, pinned: !row.pinned }), { className: "link", title: row.pinned ? "Unpin" : "Pin to the top" }),
    button("Rename", () => {
      confirmingDeleteId = null;
      renamingConversationId = row.id;
      render();
    }, { className: "link", title: "Rename" }),
    button("Archive", () => send({ type: "archiveConversation", id: row.id, archived: true }), { className: "link", title: "Archive" }),
    button(confirmingDeleteId === row.id ? "Delete?" : "Delete", () => {
      if (confirmingDeleteId === row.id) {
        confirmingDeleteId = null;
        send({ type: "deleteConversation", id: row.id });
      } else {
        confirmingDeleteId = row.id;
        render();
      }
    }, { className: "link", title: "Delete the conversation and its messages" }),
  );
  const main = el("div", { className: "row-main" }, [title]);
  // A search hit shows the headline around the match, the reason it was found.
  if (isSearchHit(row)) main.append(el("div", { className: "snippet", text: row.snippet }));
  const node = el("div", { className: `row${row.id === s.activeId ? " active" : ""}` }, [main, actions]);
  return node;
}

function archivedRow(row: ViewState["archivedConversations"][number]): HTMLElement {
  const actions = el("div", { className: "row-actions" });
  actions.append(
    button("Unarchive", () => send({ type: "archiveConversation", id: row.id, archived: false }), { className: "link", title: "Move back into the list" }),
    button("Delete", () => send({ type: "deleteConversation", id: row.id }), { className: "link", title: "Delete the conversation and its messages" }),
  );
  return el("div", { className: "row archived-row" }, [
    button(row.title || "Untitled", () => send({ type: "openConversation", id: row.id }), { className: "link title", title: row.title || "Untitled" }),
    actions,
  ]);
}

function isSearchHit(row: unknown): row is { snippet: string } {
  return typeof (row as { snippet?: unknown })?.snippet === "string";
}

function renderMeta(s: ViewState): void {
  const parts: Node[] = [];
  // Who is acting: the same line the status bar's tooltip carries, visible
  // without it, so a switched account is never a guess.
  if (s.identity) parts.push(el("span", { className: "identity", text: s.identity, title: "Signed in to MatterWave as" }));
  if (s.offline) {
    parts.push(el("span", { text: "Offline" }), button("Reconnect", () => send({ type: "reconnect" }), { className: "link", title: "Try to reach MatterWave again" }));
  }
  const meter = s.meter;
  if (meter && meter.usedTokens !== null && meter.contextWindow) {
    const pct = Math.min(100, Math.round((meter.usedTokens / meter.contextWindow) * 100));
    const bar = el("div", { className: "meter", title: `${meter.usedTokens.toLocaleString()} of ${meter.contextWindow.toLocaleString()} tokens` });
    const fill = el("i");
    fill.style.width = `${pct}%`;
    bar.appendChild(fill);
    parts.push(bar, el("span", { text: `${pct}% of context` }));
  }
  if (meter?.compactable && s.activeId) {
    parts.push(button("Compact", () => send({ type: "compact" }), { className: "link", disabled: s.streaming, title: "Summarise earlier turns to free context" }));
  }
  if (s.usage) parts.push(usageLine(s.usage));
  if (s.activeId) {
    // The badge: lit (bold) while custom instructions are in force, plain
    // when there are none yet, and the editor's door either way.
    const active = Boolean(s.instructions?.effective);
    parts.push(
      button(active ? "Instructions on" : "Instructions", () => {
        instructionsOpen = !instructionsOpen;
        render();
      }, { className: `link${active ? " badge" : ""}`, title: "Custom instructions for this conversation" }),
    );
  }
  const unread = s.unreadNotifications;
  parts.push(
    button(unread > 0 ? `Notifications (${unread})` : "Notifications", () => {
      notificationsOpen = !notificationsOpen;
      // Open is the moment to re-read: rows that aged in elsewhere catch up.
      if (notificationsOpen) send({ type: "refreshNotifications" });
      render();
    }, { className: `link${unread > 0 ? " badge" : ""}`, title: "Notifications from your organisation" }),
  );
  meta.replaceChildren(...parts);
  meta.hidden = parts.length === 0;
}

/** The org's allowance as one small line: used of included, the percent, the overage state. */
function usageLine(usage: UsageView): HTMLElement {
  const pct = Math.round(usage.percent);
  const suffix =
    usage.state === "exhausted"
      ? " · exhausted"
      : usage.state === "overage"
        ? " · overage"
        : usage.state === "warn"
          ? " · running low"
          : "";
  return el("span", {
    className: `usage${usage.state === "ok" ? "" : " warn"}`,
    text: `${compactTokens(usage.used)} / ${compactTokens(usage.included)} tokens · ${pct}%${suffix}`,
    title: `${usage.used.toLocaleString()} of ${usage.included.toLocaleString()} tokens used on the ${usage.planName} plan; resets ${new Date(usage.resetsAt).toLocaleDateString()}`,
  });
}

/** 1234567 as "1.2M", 12345 as "12.3k", the rest as itself: a line, not a column. */
function compactTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return n.toLocaleString();
}

function renderBanners(s: ViewState): void {
  const nodes: Node[] = [];
  if (s.temporary) nodes.push(el("div", { className: "notice", text: TEMPORARY_NOTICE }));
  if (s.notice) nodes.push(el("div", { className: "notice", text: s.notice }));
  if (s.error) {
    const e = s.error;
    const actions = el("div", { className: "actions" });
    if (e.retryable) actions.appendChild(button("Retry", () => send({ type: "retry" })));
    if (e.requestId) actions.appendChild(button("Copy reference", () => send({ type: "copyRequestId" }), { className: "link" }));
    nodes.push(
      el("div", { className: "error" }, [
        el("div", { className: "title", text: e.title }),
        el("div", { text: e.guidance }),
        el("div", { text: e.requestId ? `Reference: ${e.requestId}` : "No reference: the request never reached MatterWave." }),
        actions,
      ]),
    );
  }
    banners.replaceChildren(...nodes);
}

/** The per-chat instructions editor: the conversation's own text, or "use mine". */
function renderInstructions(s: ViewState): void {
  instructionsPanel.hidden = !instructionsOpen || !s.activeId;
  if (instructionsPanel.hidden) return;
  // The draft survives a re-render unless the conversation's text changed
  // under it or the box holds no focus.
  if (document.activeElement !== instructionsArea) {
    instructionsArea.value = s.instructions?.conversation ?? "";
  }
  instructionsHint.textContent = s.instructions?.overridden
    ? "This conversation is using its own instructions."
    : "This conversation is using your instructions.";
  instructionsEffective.replaceChildren(
    ...(s.instructions?.effective
      ? [markdown(s.instructions.effective)]
      : [el("p", { text: "Nothing is in force yet: the model works from this conversation alone." })]),
  );
}

/** The bell's panel: the rows newest first, unread ones bold, each with its mark-read action. */
function renderNotifications(s: ViewState): void {
  notificationsPanel.hidden = !notificationsOpen || s.notifications === null;
  if (notificationsPanel.hidden) return;
  const rows = s.notifications ?? [];
  notificationsList.replaceChildren(
    ...(rows.length === 0 ? [el("p", { className: "empty", text: "Nothing here yet." })] : rows.map(notificationRow)),
  );
}

function notificationRow(n: NotificationView): HTMLElement {
  const main = el("div", { className: "notif-main" }, [
    el("div", { className: `notif-title${n.read ? "" : " unread"}`, text: n.title }),
    ...(n.body ? [el("div", { className: "notif-body", text: n.body })] : []),
    el("div", { className: "notif-when", text: new Date(n.createdAt).toLocaleString() }),
  ]);
  const actions = el("div", { className: "row-actions" });
  if (!n.read) {
    actions.appendChild(button("Mark read", () => send({ type: "readNotification", id: n.id }), { className: "link", title: "Mark this read" }));
  }
  if (n.link) {
    // The host decides where it goes: a conversation of this deployment
    // opens in the chat, anything else in the browser.
    const link = n.link;
    actions.appendChild(button("Open", () => send({ type: "openNotification", id: n.id, url: link }), { className: "link", title: "Open where this leads" }));
  }
  return el("div", { className: "notif" }, [main, actions]);
}

function renderTranscript(s: ViewState): void {  const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
  const nodes: Node[] = [];
  s.transcript.forEach((entry, i) => nodes.push(renderEntry(entry, i === s.transcript.length - 1 && !s.live, s.streaming)));
  if (s.live) nodes.push(renderLive(s.live));
  if (nodes.length === 0) nodes.push(el("p", { text: "Ask about your code, a selection, or a file. Your conversations are the same ones the web app shows." }));
  transcript.replaceChildren(...nodes);
  if (nearBottom) transcript.scrollTop = transcript.scrollHeight;
}

function renderLive(message: Message): HTMLElement {
  const node = el("div", { className: "msg assistant live" }, [el("div", { className: "who", text: "MatterWave" }), renderParts(message.parts)]);
  node.dataset.live = "1";
  return node;
}

function renderEntry(entry: TranscriptEntry, isLast: boolean, streaming: boolean): HTMLElement {
  const m = entry.message;
  const summary = m.parts.find((p) => p.type === "summary");
  if (m.role === "system" && summary) return renderSummary(m, summary.text, entry.originals ?? []);

  const who = el("div", { className: "who", text: m.role === "user" ? "You" : "MatterWave" });
  if (entry.siblingCount > 1 && m.id) {
    who.append(
      button("‹", () => send({ type: "switchBranch", messageId: m.id, step: -1 }), { className: "link", disabled: streaming || entry.siblingIndex <= 1, title: "Previous version" }),
      el("span", { text: `${entry.siblingIndex} / ${entry.siblingCount}` }),
      button("›", () => send({ type: "switchBranch", messageId: m.id, step: 1 }), { className: "link", disabled: streaming || entry.siblingIndex >= entry.siblingCount, title: "Next version" }),
    );
  }
  const node = el("div", { className: `msg ${m.role}` }, [who]);

  if (m.role === "user" && editingId === m.id) {
    const area = el("textarea");
    area.value = m.content;
    node.append(
      el("div", { className: "composer" }, [
        area,
        el("div", { className: "row" }, [
          button("Cancel", () => {
            editingId = null;
            render();
          }),
          button("Save & ask", () => {
            const content = area.value.trim();
            if (!content) return;
            editingId = null;
            send({ type: "edit", messageId: m.id, content });
          }),
        ]),
      ]),
    );
    return node;
  }

  node.appendChild(m.role === "user" ? renderUserBody(m) : renderParts(m.parts));
  if (m.truncated) {
    const cut = el("div", { className: "cut", text: "This answer was cut off before it finished." });
    if (isLast && !streaming) cut.appendChild(button("Continue", () => send({ type: "continue" })));
    node.appendChild(cut);
  }
  if (m.id && !streaming) {
    const actions = el("div", { className: "actions" });
    if (m.role === "user") {
      actions.appendChild(
        button("Edit", () => {
          editingId = m.id;
          render();
        }, { className: "link" }),
      );
    } else if (m.role === "assistant") {
      const fb = feedbackFor(m.id);
      actions.appendChild(
        button(fb?.rating === 1 ? "Liked" : "Like", () => {
          // A second click on the raised thumb withdraws; anything else rates.
          applyFeedback(m.id, fb?.rating === 1 ? 0 : 1);
        }, { className: `link${fb?.rating === 1 ? " rated" : ""}`, title: "Good reply — send feedback" }),
      );
      actions.appendChild(
        button(fb?.rating === -1 ? "Disliked" : "Dislike", () => {
          if (fb?.rating === -1) {
            applyFeedback(m.id, 0);
          } else {
            // A thumbs-down asks why first; the rating goes with the picker's answer.
            feedbackPickerId = m.id;
            render();
          }
        }, { className: `link${fb?.rating === -1 ? " rated" : ""}`, title: feedbackTitle(fb) }),
      );
      actions.appendChild(button("Regenerate", () => send({ type: "regenerate", messageId: m.id }), { className: "link" }));
    }
    node.appendChild(actions);
  }
  if (m.id && feedbackPickerId === m.id && m.role === "assistant") node.appendChild(feedbackPicker(m));
  return node;
}

/** The thumbs' state: this session's click, else what the server rehydrated. */
function feedbackFor(messageId: string): FeedbackSummary | null {
  if (feedbackSession.has(messageId)) return feedbackSession.get(messageId) ?? null;
  return state?.feedback[messageId] ?? null;
}

function feedbackTitle(fb: FeedbackSummary | null): string {
  return fb?.reasons.length ? `Disliked (${fb.reasons.join(", ")})` : "Bad reply — send feedback";
}

/** Record the intent, show it at once, and let the host's next state confirm it. */
function applyFeedback(messageId: string, rating: -1 | 0 | 1, reasons?: FeedbackReason[], comment?: string): void {
  feedbackSession.set(messageId, rating === 0 ? null : { rating, reasons: reasons ?? [], comment: comment ?? null });
  feedbackPickerId = null;
  send({
    type: "rateMessage",
    messageId,
    rating,
    ...(reasons?.length ? { reasons } : {}),
    ...(comment ? { comment } : {}),
  });
  render();
}

/** The reasons/comment form a thumbs-down opens. */
function feedbackPicker(m: Message): HTMLElement {
  const comment = document.createElement("textarea");
  comment.placeholder = "Anything else to add? (optional)";
  comment.setAttribute("aria-label", "Feedback comment");
  const rows = FEEDBACK_REASONS.map(({ value, label }) => {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = value;
    box.id = `fb-${m.id}-${value}`;
    const labelNode = el("label", { text: label });
    labelNode.htmlFor = box.id;
    return { value, box, node: el("div", { className: "fb-reason" }, [box, labelNode]) };
  });
  return el("div", { className: "fb-picker" }, [
    el("div", { className: "who", text: "What was wrong with this reply?" }),
    ...rows.map((row) => row.node),
    comment,
    el("div", { className: "row" }, [
      button("Cancel", () => {
        feedbackPickerId = null;
        render();
      }, { className: "link" }),
      button("Skip", () => applyFeedback(m.id, -1), { className: "link", title: "Dislike without saying why" }),
      button("Send", () => {
        const reasons = rows.filter((row) => row.box.checked).map((row) => row.value);
        const text = comment.value.trim();
        applyFeedback(m.id, -1, reasons, text || undefined);
      }, { title: "Send the feedback" }),
    ]),
  ]);
}

function renderUserBody(m: Message): HTMLElement {
  const body = el("div", { className: "body" });
  for (const part of m.parts) {
    if (part.type === "text") body.appendChild(document.createTextNode(part.text));
    else body.appendChild(renderPart(part));
  }
  return body;
}

function renderSummary(m: Message, text: string, originals: Message[]): HTMLElement {
  const open = expandedSummaries.has(m.id);
  const toggle = button(open ? "Hide originals" : "Show originals", () => {
    if (open) expandedSummaries.delete(m.id);
    else expandedSummaries.add(m.id);
    render();
  }, { className: "link", disabled: originals.length === 0, title: originals.length ? "" : "The original turns are not in this conversation's tree" });
  const wrap = el("div", { className: "msg system" }, [
    el("div", { className: "divider" }, [el("span", { text: "Earlier turns summarised" }), toggle]),
    el("details", {}, [el("summary", { text: "Summary" }), markdown(text)]),
  ]);
  if (open) {
    wrap.appendChild(
      el("div", { className: "originals" }, originals.map((o) => el("div", { className: `msg ${o.role}` }, [
        el("div", { className: "who", text: o.role === "user" ? "You" : "MatterWave" }),
        o.role === "user" ? renderUserBody(o) : renderParts(o.parts),
      ]))),
    );
  }
  return wrap;
}

function renderParts(parts: Part[]): HTMLElement {
  const body = el("div", { className: "body" });
  for (const part of parts) body.appendChild(renderPart(part));
  return body;
}

function markdown(text: string): HTMLElement {
  const node = el("div");
  // Safe by construction: renderMarkdown escapes the source and its output
  // passes the allowlist sanitiser before it gets here.
  node.innerHTML = renderMarkdown(text);
  return node;
}

function collapsed(title: string, body: string): HTMLElement {
  return el("details", {}, [el("summary", { text: title }), el("pre", { text: body })]);
}

function renderPart(part: Part): Node {
  switch (part.type) {
    case "text":
      return markdown(part.text);
    case "reasoning":
      return collapsed("Reasoning", part.text);
    case "tool_call":
      return collapsed(`Tool call: ${part.name}`, prettyJson(part.arguments));
    case "tool_result":
      return collapsed(part.is_error ? "Tool result (error)" : "Tool result", part.output);
    case "document":
      return el("div", {
        className: "cut",
        text: part.truncated ? `Attached ${part.filename} — cut: the model saw only its start.` : `Attached ${part.filename}`,
      });
    case "image": {
      const data = imagePreviews.get(part.attachment_id);
      // The preview when the host has handed the bytes over; the named chip
      // until then (and always for a type or size no preview is made for).
      if (data === undefined) {
        return el("div", { className: "cut", text: `Attached image ${part.filename}` });
      }
      const img = document.createElement("img");
      img.className = "image-preview";
      img.src = data;
      img.alt = part.filename;
      img.title = part.filename;
      return img;
    }
    case "summary":
      return markdown(part.text);
  }
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

// --- the channel ------------------------------------------------------------------

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  if (message.type === "state") {
    state = message.state;
    // The host's feedback map is the record; this session's optimistic copy
    // has done its job the moment a full state arrives.
    feedbackSession.clear();
    render();
    return;
  }
  if (message.type === "imageData") {
    // Checked, not cast: this message crossed from the host, but an `img
    // src` is the one place a bad value becomes an element attribute, so the
    // shape must hold before anything is kept.
    if (trustedImageDataUri(message.dataUri)) {
      imagePreviews.set(message.attachmentId, message.dataUri);
      render();
    }
    return;
  }
  const live = state?.live;
  if (!state || !live) return;
  if (message.type === "part") setPart(live, message.index, message.part);
  else appendDelta(live, message.index, message.text);
  const node = transcript.querySelector<HTMLElement>("[data-live]");
  if (node) {
    const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
    node.replaceWith(renderLive(live));
    if (nearBottom) transcript.scrollTop = transcript.scrollHeight;
  } else {
    render();
  }
});

send({ type: "ready" });
