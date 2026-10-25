import type { ConversationMessage, ConversationWithMessages, DeviceToken } from "@matterwave/sdk";

/**
 * The wire shapes of the `/api` routes this extension reads. What the SDK
 * types is taken from it; the rest is as the API writes it (`store.py`
 * `to_dict`, `parts.py`, `app.py`). Fields the extension never reads are
 * left out rather than guessed at.
 *
 * A message's parts are the one place this file is stricter than the SDK:
 * the renderer switches over the part types the API writes, and the SDK
 * types them as `{ type: string }`.
 */

export type {
  Conversation,
  DeviceCode as DeviceAuthorization,
  DeviceToken,
  Me,
} from "@matterwave/sdk";

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
