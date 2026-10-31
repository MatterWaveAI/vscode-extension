import { FEEDBACK_REASONS, type FeedbackReason, type Message, type Part } from "../api/types";

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

/** One row of the sidebar. */
export interface ConversationSummary {
  id: string;
  title: string;
  pinned: boolean;
  archived: boolean;
  /** The row's library badge -- folder and tag names -- or null when it carries neither. */
  badge: string | null;
}

/** A conversation a search matched, with the headline around the match. */
export interface SearchHitView extends ConversationSummary {
  snippet: string;
}

export interface TranscriptEntry {
  message: Message;
  /** 1-based position among its siblings, and how many there are. */
  siblingIndex: number;
  siblingCount: number;
  /** For a summary message: the turns it folded, when the tree still has them. */
  originals?: Message[];
}

/** One of the caller's feedback rows, for the thumbs under a reply. */
export interface FeedbackSummary {
  rating: -1 | 1;
  reasons: FeedbackReason[];
  comment: string | null;
}

/** The instruction layers in force for the open conversation, as the API reports them. */
export interface InstructionsView {
  /** The conversation's own text; null when it uses the person's. */
  conversation: string | null;
  /** What the model is actually told, every layer combined. */
  effective: string | null;
  /** True when the conversation carries its own text instead of the person's. */
  overridden: boolean;
}

/** One row of the bell: the API's row with `read` spelled out. */
export interface NotificationView {
  id: string;
  kind: string;
  title: string;
  body: string;
  /** Where the row leads: a path of this deployment, or an http(s) URL. */
  link: string | null;
  createdAt: string;
  read: boolean;
}

/** The org's allowance this period, as the usage line renders it. */
export interface UsageView {
  used: number;
  included: number;
  percent: number;
  /** The API's three states, none overlapping, plus plain sailing. */
  state: "ok" | "warn" | "overage" | "exhausted";
  resetsAt: string;
  planName: string;
}

export interface ViewState {
  signedIn: boolean;
  offline: boolean;
  identity: string | null;
  /** The unarchived conversations, pinned first, as the server orders them. */
  conversations: ConversationSummary[];
  /** The archive, shown folded away under its own heading. */
  archivedConversations: ConversationSummary[];
  /** The matches for the search box's text; null when no search is active. */
  searchResults: SearchHitView[] | null;
  activeId: string | null;
  transcript: TranscriptEntry[];
  /** The assistant message being streamed, assembled from frames. */
  live: Message | null;
  model: { id: string; label: string } | null;
  meter: Meter | null;
  streaming: boolean;
  error: ErrorView | null;
  notice: string | null;
  /** True while the open conversation is temporary: in no list, unshareable, deleted a day after its last message. */
  temporary: boolean;
  /** The custom instructions in force, or null when the conversation carries none of the sort. */
  instructions: InstructionsView | null;
  /** The caller's own feedback, by message id, as the API rehydrated it on open. */
  feedback: Record<string, FeedbackSummary>;
  /** The bell's rows, newest first, or null when the API did not answer. */
  notifications: NotificationView[] | null;
  /** True when the panel lists only the unread rows. */
  notificationsUnreadOnly: boolean;
  /** True when every row the current filter selects is already on hand: nothing left to load. */
  notificationsComplete: boolean;
  /** The unread count the status bar badges; the same number the web app's bell shows. */
  unreadNotifications: number;
  /** The org's allowance this period, or null when the API did not say. */
  usage: UsageView | null;
}

export type HostMessage =
  | { type: "state"; state: ViewState }
  /** A streaming frame the webview applies to `live` without a full state post. */
  | { type: "part"; index: number; part: Part }
  | { type: "delta"; index: number; field: "text"; text: string }
  /** An image attachment's bytes as a `data:` URI, fetched by the host for one transcript part. */
  | { type: "imageData"; attachmentId: string; dataUri: string };

export type WebviewMessage =
  | { type: "ready" }
  /** Offline: try the API again, which is what brings the composer back. */
  | { type: "reconnect" }
  | { type: "newChat" }
  | { type: "openConversation"; id: string }
  /** Empty query leaves search mode. */
  | { type: "searchConversations"; query: string }
  | { type: "renameConversation"; id: string; title: string }
  | { type: "deleteConversation"; id: string }
  | { type: "pinConversation"; id: string; pinned: boolean }
  | { type: "archiveConversation"; id: string; archived: boolean }
  /** The web app's same conversation, as a Markdown file. */
  | { type: "exportConversation" }
  | { type: "shareConversation" }
  /** `temporary` rides only on a first send, before any conversation exists. */
  | { type: "send"; content: string; temporary?: boolean }
  | { type: "stop" }
  | { type: "retry" }
  | { type: "edit"; messageId: string; content: string }
  | { type: "regenerate"; messageId: string }
  /** 0 withdraws a rating; a thumbs-down carries the picker's reasons and comment. */
  | { type: "rateMessage"; messageId: string; rating: -1 | 0 | 1; reasons?: FeedbackReason[]; comment?: string | null }
  /** `null` clears the conversation's own text: "use my instructions". */
  | { type: "setInstructions"; text: string | null }
  /** The bell: re-read the rows, mark one read, or mark them all. */
  | { type: "refreshNotifications" }
  | { type: "readNotification"; id: string }
  | { type: "readAllNotifications" }
  /** Widen the bell's window by a page; a different filter reads from the top again. */
  | { type: "loadMoreNotifications" }
  | { type: "setNotificationsUnreadOnly"; on: boolean }
  /** Open where a notification row leads, in the chat or the browser. */
  | { type: "openNotification"; id: string; url: string }
  | { type: "switchBranch"; messageId: string; step: -1 | 1 }
  | { type: "continue" }
  | { type: "compact" }
  | { type: "pickModel" }
  | { type: "signIn" }
  | { type: "copyRequestId" };

const WEBVIEW_TYPES = new Set<WebviewMessage["type"]>([
  "ready", "reconnect", "newChat", "openConversation", "searchConversations", "renameConversation",
  "deleteConversation", "pinConversation", "archiveConversation", "exportConversation", "shareConversation",
  "send", "stop", "retry", "edit", "regenerate", "rateMessage", "setInstructions", "switchBranch", "continue",
  "compact", "pickModel", "signIn", "copyRequestId", "refreshNotifications", "readNotification", "readAllNotifications",
  "openNotification", "loadMoreNotifications", "setNotificationsUnreadOnly",
]);

const FEEDBACK_REASON_SET = new Set<string>(FEEDBACK_REASONS);
const MAX_COMMENT_CHARS = 2000;
const MAX_INSTRUCTION_CHARS = 2000;
/** A notification link the channel will carry; longer is not a URL but an attack. */
const MAX_LINK_CHARS = 2048;

/** The feedback reasons of an intent, or null when the array is not one the contract allows. */
function reasonsOf(value: unknown): FeedbackReason[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > 6) return null;
  const reasons: FeedbackReason[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !FEEDBACK_REASON_SET.has(item)) return null;
    reasons.push(item as FeedbackReason);
  }
  return reasons;
}

/** The webview is a lower trust level than the host: its messages are checked, not cast. */
export function parseWebviewMessage(raw: unknown): WebviewMessage | null {
  if (!raw || typeof raw !== "object" || !("type" in raw)) return null;
  const msg = raw as Record<string, unknown>;
  if (typeof msg.type !== "string" || !WEBVIEW_TYPES.has(msg.type as WebviewMessage["type"])) return null;
  const str = (key: string) => typeof msg[key] === "string" && (msg[key] as string).length > 0;
  const id = () => str("id");
  switch (msg.type) {
    case "openConversation":
      return id() ? (msg as WebviewMessage) : null;
    case "searchConversations":
      // The empty query is the one that leaves search mode; anything string is a search.
      return typeof msg.query === "string" && msg.query.length <= 200 ? (msg as WebviewMessage) : null;
    case "renameConversation": {
      if (!id() || typeof msg.title !== "string") return null;
      const title = msg.title.trim();
      return title.length > 0 && title.length <= 200 ? (msg as WebviewMessage) : null;
    }
    case "deleteConversation":
      return id() ? (msg as WebviewMessage) : null;
    case "pinConversation":
      return id() && typeof msg.pinned === "boolean" ? (msg as WebviewMessage) : null;
    case "archiveConversation":
      return id() && typeof msg.archived === "boolean" ? (msg as WebviewMessage) : null;
    case "send":
      return str("content") && (msg.temporary === undefined || typeof msg.temporary === "boolean")
        ? (msg as WebviewMessage)
        : null;
    case "edit":
      return str("messageId") && str("content") ? (msg as WebviewMessage) : null;
    case "regenerate":
      return str("messageId") ? (msg as WebviewMessage) : null;
    case "rateMessage": {
      if (!str("messageId")) return null;
      if (msg.rating !== 1 && msg.rating !== 0 && msg.rating !== -1) return null;
      if (msg.reasons !== undefined && reasonsOf(msg.reasons) === null) return null;
      const comment = msg.comment;
      if (comment !== undefined && comment !== null && (typeof comment !== "string" || comment.length > MAX_COMMENT_CHARS)) {
        return null;
      }
      return msg as WebviewMessage;
    }
    case "setInstructions": {
      if (msg.text === null) return { type: "setInstructions", text: null };
      return typeof msg.text === "string" && msg.text.length <= MAX_INSTRUCTION_CHARS
        ? { type: "setInstructions", text: msg.text }
        : null;
    }
    case "switchBranch":
      return str("messageId") && (msg.step === 1 || msg.step === -1) ? (msg as WebviewMessage) : null;
    case "readNotification":
      return id() ? (msg as WebviewMessage) : null;
    case "setNotificationsUnreadOnly":
      return typeof msg.on === "boolean" ? (msg as WebviewMessage) : null;
    case "openNotification":
      return id() && typeof msg.url === "string" && msg.url.length > 0 && msg.url.length <= MAX_LINK_CHARS
        ? (msg as WebviewMessage)
        : null;
    default:
      return { type: msg.type } as WebviewMessage;
  }
}
