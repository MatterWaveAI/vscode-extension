import type { Message, Part } from "../api/types";
import { appendDelta, setPart } from "../chat/assemble";
import type { HostMessage, TranscriptEntry, ViewState, WebviewMessage } from "../chat/protocol";
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

let state: ViewState | null = null;
let editingId: string | null = null;
const expandedSummaries = new Set<string>();

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
const meta = el("div", { className: "meta" });
const banners = el("div");
const transcript = el("div", { className: "transcript" });
transcript.setAttribute("aria-live", "polite");
const input = el("textarea");
const PLACEHOLDER = "Ask MatterWave…  (Enter to send, Shift+Enter for a new line)";
const OFFLINE_PLACEHOLDER = "MatterWave cannot be reached. Your draft is kept.";
input.placeholder = PLACEHOLDER;
const sendButton = button("Send", submit);
const stopButton = button("Stop", () => send({ type: "stop" }));
const composer = el("div", { className: "composer" }, [input, el("div", { className: "row" }, [stopButton, sendButton])]);
const signIn = el("div", { className: "signin" }, [
  el("p", { text: "Sign in to chat with your organisation's models." }),
  button("Sign in", () => send({ type: "signIn" })),
]);

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submit();
  }
});

function submit(): void {
  const content = input.value.trim();
  if (!content || state?.streaming || state?.offline) return;
  send({ type: "send", content });
  input.value = "";
}

// --- rendering ------------------------------------------------------------------

function render(): void {
  if (!state) return;
  if (!state.signedIn) {
    app.replaceChildren(signIn);
    return;
  }
  if (!app.contains(composer)) app.replaceChildren(header, meta, banners, transcript, composer);
  renderHeader(state);
  renderMeta(state);
  renderBanners(state);
  renderTranscript(state);
  sendButton.disabled = state.streaming || state.offline;
  stopButton.hidden = !state.streaming;
  // Offline, the composer closes but the textarea is never replaced, so the
  // draft is there when the connection is.
  input.disabled = state.offline;
  input.placeholder = state.offline ? OFFLINE_PLACEHOLDER : PLACEHOLDER;
}

function renderHeader(s: ViewState): void {
  const select = el("select", { title: "Conversations" });
  const option = (label: string, value: string, selected: boolean) => {
    const node = el("option", { text: label });
    node.value = value;
    node.selected = selected;
    return node;
  };
  select.appendChild(option("New chat", "", !s.activeId));
  for (const c of s.conversations) select.appendChild(option(c.title || "Untitled", c.id, c.id === s.activeId));
  select.addEventListener("change", () => {
    if (select.value) send({ type: "openConversation", id: select.value });
    else send({ type: "newChat" });
  });
  header.replaceChildren(
    select,
    button("+", () => send({ type: "newChat" }), { title: "New chat" }),
    button(s.model?.label ?? "Pick model", () => send({ type: "pickModel" }), { className: "link", title: "Pick model" }),
  );
}

function renderMeta(s: ViewState): void {
  const parts: Node[] = [];
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
  meta.replaceChildren(...parts);
  meta.hidden = parts.length === 0;
}

function renderBanners(s: ViewState): void {
  const nodes: Node[] = [];
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

function renderTranscript(s: ViewState): void {
  const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
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
      actions.appendChild(button("Regenerate", () => send({ type: "regenerate", messageId: m.id }), { className: "link" }));
    }
    node.appendChild(actions);
  }
  return node;
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
    case "image":
      return el("div", { className: "cut", text: `Attached image ${part.filename}` });
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
    render();
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
