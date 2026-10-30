import type { ConversationMessage, ConversationWithMessages, DeviceToken } from "../lib/matterwaveClient";

/**
 * The wire shapes of the `/api` routes this extension reads. What the
 * vendored SDK client (`src/lib/matterwaveClient.ts`) types is taken from
 * it; the rest is as the API writes it (`store.py` `to_dict`, `parts.py`,
 * `app.py`). Fields the extension never reads are left out rather than
 * guessed at.
 *
 * A message's parts are the one place this file is stricter than the SDK:
 * the renderer switches over the part types the API writes, and the SDK
 * types them as `{ type: string }`.
 */

export type {
  Conversation,
  ConversationInstructions,
  DeviceCode as DeviceAuthorization,
  DeviceToken,
  Me,
  UserInstructions,
} from "../lib/matterwaveClient";

export type Role = "user" | "assistant" | "system";

export interface TextPart {
  type: "text";
  text: string;
}

export interface ReasoningPart {
  type: "reasoning";
  text: string;
}

export interface ToolCallPart {
  type: "tool_call";
  id: string;
  name: string;
  arguments: string;
}

export interface ToolResultPart {
  type: "tool_result";
  id: string;
  output: string;
  is_error: boolean;
}

export interface ImagePart {
  type: "image";
  attachment_id: string;
  filename: string;
  content_type: string;
}

export interface DocumentPart {
  type: "document";
  attachment_id: string;
  filename: string;
  content_type: string;
  text: string | null;
  truncated: boolean;
}

/** What compaction folds earlier turns into. */
export interface SummaryPart {
  type: "summary";
  text: string;
  covers_from?: string | null;
  covers_to?: string | null;
  tokens_before?: number | null;
  tokens_after?: number | null;
}

export type Part =
  | TextPart
  | ReasoningPart
  | ToolCallPart
  | ToolResultPart
  | ImagePart
  | DocumentPart
  | SummaryPart;

export interface Message extends Omit<ConversationMessage, "role" | "parts" | "finish_reason"> {
  role: Role;
  parts: Part[];
  finish_reason?: string | null;
}

export interface ConversationDetail extends Omit<ConversationWithMessages, "messages" | "tree"> {
  messages: Message[];
}

export interface ModelInfo {
  id: string;
  label: string;
  included: boolean;
  upgrade_to: string | null;
  partner: boolean;
  research_preview: boolean;
  supports_vision?: boolean | null;
  context_window: number | null;
}

export interface ModelList {
  data: ModelInfo[];
  default_model: string | null;
}

export interface ContextUsage {
  model: string;
  context_window: number | null;
  used_tokens: number | null;
  compactable: boolean;
}

export interface Attachment {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  extract_truncated?: boolean;
}

/** One row of `GET /api/keys`: never the value, only what identifies it. */
export interface ApiKeyListing {
  id: string;
  prefix: string;
  previous_prefix: string | null;
  revoked_at: string | null;
}

export type DeviceTokenError =
  | "authorization_pending"
  | "slow_down"
  | "expired_token"
  | "access_denied";

/** One poll's answer: a token, or the RFC 8628 reason there is not one yet. */
export type DevicePoll =
  | { ok: true; token: DeviceToken }
  | { ok: false; error: DeviceTokenError | string };

export interface SendBody {
  content: string;
  model?: string;
  attachment_ids?: string[];
}

// --- message feedback --------------------------------------------------------

/** A reason a reply earned its thumbs-down, as the feedback contract spells them. */
export type FeedbackReason = "wrong" | "unhelpful" | "incomplete" | "too_long" | "off_topic" | "unsafe";

export const FEEDBACK_REASONS: readonly FeedbackReason[] = [
  "wrong",
  "unhelpful",
  "incomplete",
  "too_long",
  "off_topic",
  "unsafe",
];

/** One of the caller's feedback rows, as `GET /api/conversations/{id}/feedback` returns it. */
export interface FeedbackRow {
  message_id: string;
  rating: -1 | 1;
  reasons: FeedbackReason[];
  comment: string | null;
}

// --- notifications ------------------------------------------------------------

/** One row of `GET /api/me/notifications`, as `notifications.py` writes it. */
export interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  created_at: string;
  read_at: string | null;
}

/**
 * What the bell reads: the rows and the unread count, whichever way they
 * were asked for -- the count is the same under the unread-only filter.
 */
export interface NotificationListing {
  data: NotificationRow[];
  unread_count: number;
}

// --- usage and budget -----------------------------------------------------------

/** `GET /api/me/usage`: the org's balance this period, as `usage_payload` writes it. */
export interface UsageReport {
  unit: string;
  used: number;
  included: number;
  remaining: number;
  percent: number;
  warn: boolean;
  in_overage: boolean;
  exhausted: boolean;
  period_start: string;
  resets_at: string;
  plan: { code: string; name: string };
}

/** `GET /api/budget`: the period's allowance and the caller's own cap, in tokens and micro-dollars. */
export interface BudgetStatus {
  period_start: string;
  included_tokens: number;
  tokens_used: number;
  remaining_tokens: number;
  overage_enabled: boolean;
  overage_cap_micros: number;
  overage_micros: number;
  member_default_cap_micros: number | null;
  member_cap: number | null;
  member_spent: number;
  member_exhausted: boolean;
}

// --- share management -----------------------------------------------------------

/** One share link, as `ShareRecord.to_dict` writes it for the owner's list. */
export interface ShareRow {
  id: string;
  conversation_id: string;
  title: string;
  message_count: number;
  include_attachments: boolean;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  view_count: number;
  status: string;
}

// --- library ------------------------------------------------------------------

/** One folder of the caller's library, as `Folder.to_dict` writes it. */
export interface FolderRow {
  id: string;
  name: string;
  position: number;
  created_at: string;
  updated_at: string;
}

/** One tag of the caller's library, as `Tag.to_dict` writes it. */
export interface TagRow {
  id: string;
  name: string;
  created_at: string;
}

/**
 * `GET /api/library`: the folders, the tags and which tags each conversation
 * carries, in one read. `assignments` is conversation id -> tag ids rather
 * than a field on a conversation row, so a stale copy never rides a row.
 */
export interface Library {
  folders: FolderRow[];
  tags: TagRow[];
  assignments: Record<string, string[]>;
}
