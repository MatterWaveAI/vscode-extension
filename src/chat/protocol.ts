import type { Message, Part } from "../api/types";

/**
 * The message channel between the extension host and the chat webview.
 *
 * The webview is a renderer: it receives conversation data and sends user
 * intents. It never makes a request, so nothing on this channel is ever a
 * credential -- the host holds the token, and a test asserts that no message
 * crossing this boundary contains it.
 */

export interface ErrorView {
  title: string;
  guidance: string;
  retryable: boolean;
  requestId: string | null;
}

export interface Meter {
  usedTokens: number | null;
  contextWindow: number | null;
  compactable: boolean;
}

export interface TranscriptEntry {
  message: Message;
  /** 1-based position among its siblings, and how many there are. */
  siblingIndex: number;
  siblingCount: number;
  /** For a summary message: the turns it folded, when the tree still has them. */
  originals?: Message[];
}

export interface ViewState {
  signedIn: boolean;
  offline: boolean;
  identity: string | null;
  conversations: { id: string; title: string }[];
  activeId: string | null;
  transcript: TranscriptEntry[];
  /** The assistant message being streamed, assembled from frames. */
  live: Message | null;
  model: { id: string; label: string } | null;
  meter: Meter | null;
  streaming: boolean;
  error: ErrorView | null;
  notice: string | null;
}

export type HostMessage =
  | { type: "state"; state: ViewState }
  /** A streaming frame the webview applies to `live` without a full state post. */
  | { type: "part"; index: number; part: Part }
  | { type: "delta"; index: number; field: "text"; text: string };

export type WebviewMessage =
  | { type: "ready" }
  /** Offline: try the API again, which is what brings the composer back. */
  | { type: "reconnect" }
  | { type: "newChat" }
  | { type: "openConversation"; id: string }
  | { type: "send"; content: string }
  | { type: "stop" }
  | { type: "retry" }
  | { type: "edit"; messageId: string; content: string }
  | { type: "regenerate"; messageId: string }
  | { type: "switchBranch"; messageId: string; step: -1 | 1 }
  | { type: "continue" }
  | { type: "compact" }
  | { type: "pickModel" }
  | { type: "signIn" }
  | { type: "copyRequestId" };

const WEBVIEW_TYPES = new Set<WebviewMessage["type"]>([
  "ready", "reconnect", "newChat", "openConversation", "send", "stop", "retry", "edit",
  "regenerate", "switchBranch", "continue", "compact", "pickModel", "signIn", "copyRequestId",
]);

/** The webview is a lower trust level than the host: its messages are checked, not cast. */
export function parseWebviewMessage(raw: unknown): WebviewMessage | null {
  if (!raw || typeof raw !== "object" || !("type" in raw)) return null;
  const msg = raw as Record<string, unknown>;
  if (typeof msg.type !== "string" || !WEBVIEW_TYPES.has(msg.type as WebviewMessage["type"])) return null;
  const str = (key: string) => typeof msg[key] === "string" && (msg[key] as string).length > 0;
  switch (msg.type) {
    case "openConversation":
      return str("id") ? (msg as WebviewMessage) : null;
    case "send":
      return str("content") ? (msg as WebviewMessage) : null;
    case "edit":
      return str("messageId") && str("content") ? (msg as WebviewMessage) : null;
    case "regenerate":
      return str("messageId") ? (msg as WebviewMessage) : null;
    case "switchBranch":
      return str("messageId") && (msg.step === 1 || msg.step === -1) ? (msg as WebviewMessage) : null;
    default:
      return { type: msg.type } as WebviewMessage;
  }
}
