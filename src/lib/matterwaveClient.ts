/**
 * Vendored from the MatterWave TypeScript SDK (MatterWaveAI/typescript-sdk,
 * MIT, version 0.5.0) and trimmed to the surface this extension uses: the
 * request/retry core, `me()`, device login, the conversation API with its
 * streaming frames, `/v1/completions` FIM (`fimComplete`), Pi 1.0 RPC types,
 * and the reading half of `presets` (a composer offers the org's presets; it
 * never writes them). The native org/keys/webhooks/library/shares/connections
 * clients, the preset writes and the environment-variable fallbacks are left
 * out.
 *
 * It is vendored, not depended on, because `@matterwave/sdk` is not
 * published to npm and this repository no longer sits beside the SDK's
 * source in the monorepo. If the package is published, this file and its
 * importers can move back to the dependency. Change both together:
 * upstream `src/{client,conversations,conversation-types,connectors,connector-types,errors,frames,sse,pi}.ts`.
 *
 * The extension's own client (`src/api/client.ts`) wraps this one; the
 * routes the SDK does not model (pin, archive, delete, share, feedback,
 * context, compaction, attachments) ride the wrapper's own `json()` plumbing.
 */

export const VERSION = "0.5.0";
export const IDEMPOTENCY_HEADER = "Idempotency-Key";
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** A fresh key for one write: a random (version 4) UUID, as Stripe and OpenAI send. */
export function newIdempotencyKey(): string {
  const crypto = (globalThis as { crypto?: Crypto }).crypto;
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  if (typeof crypto?.getRandomValues !== "function") {
    throw new MatterWaveError("No Web Crypto in this runtime to make an idempotency key with.");
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// --- errors (upstream errors.ts, trimmed) ------------------------------------

export class MatterWaveError extends Error {
  /** The underlying failure, when there is one: the fetch rejection behind a connection error. */
  readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    // `super(message, { cause })` is ES2022; the ES2020 target Node 18 and
    // older browsers share does not type it, so the field is set by hand.
    super(message);
    this.name = new.target.name;
    if (options && "cause" in options) this.cause = options.cause;
  }
}

/** A keyed operation was called with no key. */
export class MissingAPIKeyError extends MatterWaveError {}

/** The request never produced a response: DNS, refused, reset, TLS. */
export class APIConnectionError extends MatterWaveError {}

/** The request produced no response within the timeout. */
export class APITimeoutError extends APIConnectionError {}

/** `X-RateLimit-*`, when the server sent all three as integers. */
export interface RateLimit {
  limit: number;
  remaining: number;
  reset: number;
}

export interface APIErrorInit {
  /** Null for an error that arrived inside a stream, after the 200. */
  status: number | null;
  type?: string | null;
  code?: string | null;
  param?: string | null;
  requestId?: string | null;
  /** Seconds, from `Retry-After`, when the server sent it. */
  retryAfter?: number | null;
  rateLimit?: RateLimit | null;
  body?: unknown;
}

/** A response the API sent to say no, parsed from its error envelope. */
export class APIError extends MatterWaveError {
  readonly status: number | null;
  readonly type: string | null;
  readonly code: string | null;
  readonly param: string | null;
  readonly requestId: string | null;
  readonly retryAfter: number | null;
  readonly rateLimit: RateLimit | null;
  readonly body: unknown;

  constructor(message: string, init: APIErrorInit) {
    super(message);
    this.status = init.status;
    this.type = init.type ?? null;
    this.code = init.code ?? null;
    this.param = init.param ?? null;
    this.requestId = init.requestId ?? null;
    this.retryAfter = init.retryAfter ?? null;
    this.rateLimit = init.rateLimit ?? null;
    this.body = init.body;
  }

  /** The message with the status, code and request id, for a log line. */
  describe(): string {
    const parts = [this.message];
    if (this.status !== null) parts.push(`(status ${this.status})`);
    if (this.code) parts.push(`[${this.code}]`);
    if (this.requestId) parts.push(`request_id=${this.requestId}`);
    return parts.join(" ");
  }
}

/** 400: a malformed body, an unsupported parameter, a non-text part. */
export class BadRequestError extends APIError {}
/** 401: no key, or an invalid, expired or revoked one. */
export class AuthenticationError extends APIError {}
/** 403: the key lacks the scope, or the account is suspended. */
export class PermissionDeniedError extends APIError {}
/** 404: an unknown model, or a conversation that is not the key owner's. */
export class NotFoundError extends APIError {}
/** 409: valid, but the state does not allow it. */
export class ConflictError extends APIError {}
/** The `code` the app puts beside `detail` on the 409 for a turn in a conversation a connector opened. */
export const CONNECTOR_CONVERSATION_CODE = "connector_conversation";
/**
 * 409 with `code` `connector_conversation`: a send, edit or regenerate in a
 * conversation a connector opened (one started from Slack, say), which is
 * answered in its own thread alone. `source` says which connector and
 * channel, with a link to the thread when the connector has one. A fork of
 * the conversation is ordinary and takes messages.
 */
export class ConnectorConversationError extends ConflictError {
  readonly source: ConversationSource;

  constructor(message: string, init: APIErrorInit & { source: ConversationSource }) {
    super(message, { ...init, code: CONNECTOR_CONVERSATION_CODE });
    this.source = init.source;
  }
}
/** 422: the body failed validation, FastAPI's own refusal shape. */
export class UnprocessableEntityError extends APIError {}
/** 429: the per-key window, or the organisation's monthly budget. */
export class RateLimitError extends APIError {}
/** 5xx: the API or the model gateway behind it failed. */
export class ServerError extends APIError {}

/**
 * A device login the server has not approved. `code` is RFC 8628's:
 * `authorization_pending` and `slow_down` mean poll again (later, for the
 * second); `expired_token` and `access_denied` mean start over.
 */
export class DeviceAuthError extends APIError {}

/**
 * A client option that cannot be used: no origin, a bad origin, a negative
 * retry count.
 */
export class MatterWaveConfigError extends MatterWaveError {
  constructor(message: string) {
    super(message);
    this.name = "MatterWaveConfigError";
  }
}

export function errorClassFor(status: number): new (message: string, init: APIErrorInit) => APIError {
  if (status === 400) return BadRequestError;
  if (status === 401) return AuthenticationError;
  if (status === 403) return PermissionDeniedError;
  if (status === 404) return NotFoundError;
  if (status === 409) return ConflictError;
  if (status === 422) return UnprocessableEntityError;
  if (status === 429) return RateLimitError;
  if (status >= 500) return ServerError;
  return APIError;
}

// --- conversation wire types (upstream conversation-types.ts, trimmed) --------

/** One part of a message: `text`, `reasoning`, `tool_call`, `tool_result`, `image`, `document` or `summary`. */
export interface MessagePart {
  type: string;
  text?: string;
  [field: string]: unknown;
}

/** The part a compaction's summary message carries. */
export interface SummaryPart extends MessagePart {
  type: "summary";
  text: string;
  covers_from: string;
  covers_to: string;
  tokens_before: number;
  tokens_after: number;
}

/**
 * One message of a conversation's tree. `parts` is the ordered list the
 * renderer maps to components; `content` is the same message flattened to
 * text. `parent_id` links the tree; siblings are branches.
 */
export interface ConversationMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system" | (string & {});
  parts: MessagePart[];
  content: string;
  created_at: string;
  parent_id: string | null;
  model: string | null;
  truncated: boolean;
  /** Why the model stopped, on an assistant message: `length` when the token limit cut it. */
  finish_reason: string | null;
}

/**
 * The org preset a conversation answers with, as the conversation carries
 * it beside `preset_id`: the id again, and the name a composer can label
 * the choice with.
 */
export interface ConversationPreset {
  id: string;
  name: string;
}

/**
 * Where a connector opened a conversation: which connector (`slack`), the
 * connection it came through, the channel as a person would name it
 * (`#support`), and a link to the thread when the connector has one. Such a
 * conversation is answered in that thread alone -- `send`, `edit` and
 * `regenerate` in it throw `ConnectorConversationError` -- and a fork of it
 * is an ordinary conversation with no source.
 */
export interface ConversationSource {
  connector: string;
  connection_id: string | null;
  channel_label: string | null;
  url: string | null;
}

export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  org_id: string | null;
  last_message_at: string | null;
  preview: string | null;
  message_count: number | null;
  default_model: string | null;
  current_leaf_message_id: string | null;
  pinned_at: string | null;
  archived_at: string | null;
  folder_id: string | null;
  /** Fixed at creation; a temporary chat is in no list and is deleted 24h after its last message. */
  temporary?: boolean | null;
  /**
   * The org preset the conversation answers with, when it is on one: the
   * id, and the same with its name as `preset`. Null for a conversation
   * answering with its own picks; absent from an API that predates presets.
   */
  preset_id?: string | null;
  preset?: ConversationPreset | null;
  /**
   * Where a connector opened the conversation; null for one a person
   * started, absent from an API that predates connectors.
   */
  source?: ConversationSource | null;
}

/** `GET /api/me/instructions`: the person's own custom instructions. */
export interface UserInstructions {
  about: string | null;
  style: string | null;
}

/**
 * The instruction layers for one conversation: what `GET
 * /api/conversations/{id}` carries as `instructions`, and what `PUT
 * /api/conversations/{id}/instructions` answers. `effective` is the text the
 * model is actually told.
 */
export interface ConversationInstructions {
  org: string | null;
  user: { about: string | null; style: string | null } | null;
  conversation: string | null;
  /** True when the conversation carries its own text instead of the person's. */
  user_overridden: boolean;
  effective: string | null;
}

/**
 * A conversation with messages: the active path from `get` and
 * `setActiveLeaf`, every message from `tree`.
 */
export interface ConversationWithMessages extends Conversation {
  messages: ConversationMessage[];
  tree?: ConversationMessage[];
  instructions?: ConversationInstructions | null;
}

export type ConversationFilter = "default" | "all" | "pinned" | "archived";

export interface ConversationList {
  data: Conversation[];
  filter: ConversationFilter;
  /** Resumes the list after this page; null on the last one. */
  next_cursor: string | null;
}

export interface ListConversationsParams {
  /** `default` (unarchived, pinned first), `all`, `pinned` or `archived`. */
  filter?: ConversationFilter;
  /** Rows per page: 1 to 200, 50 when omitted. */
  limit?: number;
  /** A previous page's `next_cursor`. */
  cursor?: string;
}

/** A conversation a search matched, the headline around the match, and the message (null for a title match). */
export interface SearchHit extends Conversation {
  snippet: string;
  message_id: string | null;
}

/** `GET /api/conversations/search`: the conversation search does not page. */
export interface SearchResults {
  data: SearchHit[];
  query: string;
}

export interface CreateConversationParams {
  title?: string | null;
  model?: string | null;
  /**
   * Fixed at creation: a temporary conversation appears in no list filter or
   * search, refuses share/pin/fork with a 409, and is deleted 24 hours after
   * its last message. Off, the key is omitted entirely.
   */
  temporary?: boolean;
  /**
   * One of the org's live presets (`presets.list()`), whose model,
   * instructions and tools the conversation's turns answer with; null or
   * left out is no preset.
   */
  preset_id?: string | null;
}

// --- presets (upstream connector-types.ts, trimmed) ---------------------------

/**
 * One of the org's agent presets: the model, instructions, tools and welcome
 * message a conversation on it answers with. `tools` null is the platform's
 * default set and an empty list none. `deleted_at` is set on a deleted one,
 * which `presets.get` still answers for and the list never offers.
 */
export interface Preset {
  id: string;
  name: string;
  description: string;
  model: string;
  instructions: string;
  tools: string[] | null;
  welcome_message: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** A tool a preset may name, with what it does. */
export interface PresetTool {
  name: string;
  description: string;
}

/** The rules a preset is held to: how many the org may keep, and the longest name, description, instructions and welcome message. */
export interface PresetLimits {
  max_presets: number;
  name_max_len: number;
  description_max_len: number;
  instructions_max_len: number;
  welcome_max_len: number;
}

/**
 * `GET /api/org/presets`: the org's live presets, the tools a preset may
 * name, the limits, and `can_manage`, whether the caller may change them (an
 * owner or admin).
 */
export interface PresetListing {
  data: Preset[];
  tools: PresetTool[];
  limits: PresetLimits;
  can_manage: boolean;
}

/**
 * What `conversations.update` changes. At least one field; a key left out
 * is left alone on the server.
 */
export interface UpdateConversationParams {
  /** The conversation's default model; `null` clears it back to the deployment's. */
  default_model?: string | null;
  /** The person's name for the conversation, 1-200 characters once trimmed. */
  title?: string;
  /** The org preset the conversation answers with; `null` clears it back to no preset. */
  preset_id?: string | null;
}

export interface SendMessageParams {
  content: string;
  model?: string | null;
  temperature?: number | null;
  /** Attachments uploaded before the send, bound to this message. */
  attachment_ids?: string[];
  /** Send onto this branch instead of the current leaf. */
  parent_id?: string | null;
}

export interface EditMessageParams {
  content: string;
  model?: string | null;
  temperature?: number | null;
}

export interface RegenerateMessageParams {
  model?: string | null;
  temperature?: number | null;
}

/** `GET /api/me`: who the bearer acts as. A key acts as its owner. */
export interface Me {
  subject: string;
  kind: string;
  email: string | null;
  name: string | null;
  roles: string[];
  org_id: string | null;
  org_name: string | null;
  org_role: string | null;
  state?: string | null;
  /**
   * The org switch for local agent tools (the coding agent's file and shell
   * tools, run on the person's machine). Absent on a deployment that
   * predates it, which reads as allowed.
   */
  local_agent_tools?: boolean | null;
}

// --- agent mode verdicts (upstream conversation-types.ts) --------------------
//
// The two flags a client reads before offering its agent mode, whose tools run
// on the user's machine: whether the model can call tools, and whether the org
// lets clients run local agent tools. Each is tri-state, like `supports_vision`.

export type ToolsVerdict = "yes" | "no" | "unknown";

/**
 * What the model list says about `modelId`'s tool calling: `visionOf`'s rules
 * for `supports_tools`. `"no"` is the only refusing verdict, the one that
 * greys out agent mode: no model chosen, a model the list does not have, and
 * `supports_tools` missing or null are all `"unknown"`, since a bare llama.cpp
 * or vLLM build says nothing and its model may well call tools.
 */
export function toolsOf(
  models: readonly { id: string; supports_tools?: boolean | null }[] | null,
  modelId: string | null,
): ToolsVerdict {
  if (modelId === null || models === null) return "unknown";
  const entry = models.find((model) => model.id === modelId);
  if (entry === undefined) return "unknown";
  if (entry.supports_tools === true) return "yes";
  if (entry.supports_tools === false) return "no";
  return "unknown";
}

/**
 * Whether the org lets clients run local agent tools, from `client.me()`:
 * `"no"` only when the server says `local_agent_tools: false`, `"yes"` when it
 * says true, and `"unknown"` when it says nothing (an older server), which a
 * client treats as allowed.
 */
export function localAgentToolsOf(me: Pick<Me, "local_agent_tools"> | null | undefined): ToolsVerdict {
  if (me === null || me === undefined) return "unknown";
  if (me.local_agent_tools === true) return "yes";
  if (me.local_agent_tools === false) return "no";
  return "unknown";
}

/**
 * What to show the person: open `verification_uri` and type `user_code`, or
 * open `verification_uri_complete`, which carries the code. `device_code` is
 * the client's half and is never shown.
 */
export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/** An approved device login. `access_token` is an ordinary API key. */
export interface DeviceToken {
  token_type: "Bearer" | (string & {});
  access_token: string;
  scopes: string[];
}

/** The payload with the `X-Request-Id` the server stamped on it attached, invisibly. */
export type WithRequestId<T> = T & { requestId: string | null };

// --- server-sent events (upstream sse.ts, trimmed) -----------------------------

/** One dispatched event: its name (`message` when the frame named none), its joined data, and its `id:` if it had one. */
export interface SSEEvent {
  event: string;
  data: string;
  id: string | null;
}

/**
 * Named events, for the conversation stream: `event:`, `data:` and `id:`
 * read per the spec, comments (the `: mw-heartbeat` every few seconds)
 * skipped. Bytes arrive in chunks that split lines anywhere, so a partial
 * line is carried across reads.
 */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let event = "";
  let data: string[] = [];
  let id: string | null = null;

  function dispatch(): SSEEvent | null {
    const out = data.length > 0 ? { event: event || "message", data: data.join("\n"), id } : null;
    event = "";
    data = [];
    id = null;
    return out;
  }

  function take(line: string): SSEEvent | null {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id" && !value.includes("\0")) id = value;
    return null;
  }

  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffered += decoder.decode(value, { stream: !done });
      let newline: number;
      while ((newline = buffered.search(/\r\n|\n|\r/)) !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + (buffered.startsWith("\r\n", newline) ? 2 : 1));
        const out = take(line);
        if (out) yield out;
      }
      if (done) break;
    }
    if (buffered !== "") {
      const out = take(buffered);
      if (out) yield out;
    }
    const last = dispatch();
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}

// --- stream frames (upstream frames.ts, trimmed) --------------------------------

interface FrameBase {
  id: string | null;
}

/** The user message this turn appended (or the edited one), as saved. */
export interface MessageFrame extends FrameBase {
  event: "message";
  message: ConversationMessage;
}

/**
 * A part of the assistant message opens at `index`. `type` is `text`,
 * `reasoning`, `tool_call` or `tool_result`; a tool call carries `call_id`,
 * `name` and `arguments`, a result its `output` and `is_error`.
 */
export interface PartStartFrame extends FrameBase {
  event: "part_start";
  index: number;
  type: string;
  call_id: string | null;
  name: string | null;
  arguments: string | null;
  output: string | null;
  is_error: boolean;
}

/** Text for the open part at `index`: `content` for an answer, `reasoning` for a reasoning part. */
export interface DeltaFrame extends FrameBase {
  event: "delta";
  index: number;
  content: string | null;
  reasoning: string | null;
}

export interface PartEndFrame extends FrameBase {
  event: "part_end";
  index: number;
}

/** The conversation was named from this turn's first line. */
export interface TitleFrame extends FrameBase {
  event: "title";
  title: string;
}

/** The turn ended; `message` is the saved assistant message. */
export interface DoneFrame extends FrameBase {
  event: "done";
  message: ConversationMessage;
}

/** The turn failed after the 200: the upstream died, the budget is spent, or a resume found nothing. */
export interface ErrorFrame extends FrameBase {
  event: "error";
  detail: string;
  code: string | null;
}

/** MatterWave would not send this message to a model; a different fact from the model declining. */
export interface ModerationBlockFrame extends FrameBase {
  event: "moderation_block";
  detail: string;
  code: string | null;
  request_id: string | null;
}

/**
 * The server is folding earlier turns before the model is asked, which can
 * take a while: the turn opens with this so the client has something to show
 * for the first token's wait. `detail` is the sentence to show; `compaction`
 * or `notice` follows.
 */
export interface CompactingFrame extends FrameBase {
  event: "compacting";
  detail: string;
}

/** Earlier messages were folded into `message`, a `system` message with one `summary` part. */
export interface CompactionFrame extends FrameBase {
  event: "compaction";
  message: ConversationMessage;
  covers_from: string | null;
  covers_to: string | null;
  tokens_before: number;
  tokens_after: number;
}

/**
 * The turn's real token counts, for a context meter. Each is null when the
 * server does not know it.
 */
export interface ContextFrame extends FrameBase {
  event: "context";
  prompt_tokens: number | null;
  completion_tokens: number | null;
  context_window: number | null;
}

/**
 * Something the person should be told that is not part of the answer:
 * `detail` is the sentence to show, `code` the machine reason.
 */
export interface NoticeFrame extends FrameBase {
  event: "notice";
  detail: string;
  code: string | null;
}

/** An event this client predates, kept as sent under its own `name`. */
export interface UnknownFrame extends FrameBase {
  event: "unknown";
  name: string;
  data: unknown;
}

export type ConversationFrame =
  | MessageFrame
  | PartStartFrame
  | DeltaFrame
  | PartEndFrame
  | TitleFrame
  | DoneFrame
  | ErrorFrame
  | ModerationBlockFrame
  | CompactingFrame
  | CompactionFrame
  | ContextFrame
  | NoticeFrame
  | UnknownFrame;

/** The frames after which the server sends nothing more for this turn. */
export function isTerminal(frame: ConversationFrame): boolean {
  return frame.event === "done" || frame.event === "error" || frame.event === "moderation_block";
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}

function optInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function optStr(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function message(value: unknown): ConversationMessage {
  return (typeof value === "object" && value !== null ? value : {}) as ConversationMessage;
}

/**
 * The typed frame for one event. `data` is the decoded JSON; a known event
 * whose data is not an object reads as an empty one.
 */
export function frameFromEvent(event: string, data: unknown, id: string | null = null): ConversationFrame {
  const d = (typeof data === "object" && data !== null && !Array.isArray(data) ? data : {}) as Record<
    string,
    unknown
  >;
  switch (event) {
    case "message":
      return { event, id, message: message(d) };
    case "part_start":
      return {
        event,
        id,
        index: int(d.index),
        type: String(d.type ?? ""),
        call_id: optStr(d.id),
        name: optStr(d.name),
        arguments: optStr(d.arguments),
        output: optStr(d.output),
        is_error: d.is_error === true,
      };
    case "delta":
      return { event, id, index: int(d.index), content: optStr(d.content), reasoning: optStr(d.reasoning) };
    case "part_end":
      return { event, id, index: int(d.index) };
    case "title":
      return { event, id, title: String(d.title ?? "") };
    case "done":
      return { event, id, message: message(d) };
    case "error":
      return { event, id, detail: String(d.detail ?? "The stream ended with an error."), code: optStr(d.code) };
    case "moderation_block":
      return {
        event,
        id,
        detail: String(d.detail ?? ""),
        code: optStr(d.code),
        request_id: optStr(d.request_id),
      };
    case "compacting":
      return { event, id, detail: String(d.detail ?? "") };
    case "compaction":
      return {
        event,
        id,
        message: message(d.message),
        covers_from: optStr(d.covers_from),
        covers_to: optStr(d.covers_to),
        tokens_before: int(d.tokens_before),
        tokens_after: int(d.tokens_after),
      };
    case "context":
      return {
        event,
        id,
        prompt_tokens: optInt(d.prompt_tokens),
        completion_tokens: optInt(d.completion_tokens),
        context_window: optInt(d.context_window),
      };
    case "notice":
      return { event, id, detail: String(d.detail ?? ""), code: optStr(d.code) };
    default:
      return { event: "unknown", id, name: event, data };
  }
}

// --- the client core (upstream client.ts, trimmed) -------------------------------

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface ClientOptions {
  /** No default: this editor must never be signed in by the host's environment. */
  apiKey?: string | null;
  /** The origin the API is served from; the OpenAI-style form ending in `/v1` is accepted too. */
  baseUrl?: string | null;
  /** Per attempt. The default is 60 seconds. */
  timeoutMs?: number;
  /** Retries after the first attempt, for 429 and 5xx. The default is 2. */
  maxRetries?: number;
  /** A replacement `fetch`: a mock in tests, a wrapped one in an app. */
  fetch?: Fetch;
}

export interface RequestOptions {
  /** Aborts the request, and a stream being read. */
  signal?: AbortSignal;
  /** Headers for this one call. */
  headers?: Record<string, string>;
  /** Explicit `Idempotency-Key` header for this write; ignored on GET/HEAD/OPTIONS. */
  idempotencyKey?: string;
}

export interface FimCompletionRequest {
  model?: string | null;
  prompt: string;
  suffix?: string;
  max_tokens?: number;
  temperature?: number;
  stop?: string | string[];
}

export interface FimCompletionChoice {
  text: string;
  index: number;
  finish_reason: string | null;
}

export interface FimCompletionResponse {
  id?: string;
  object?: string;
  model?: string;
  choices: FimCompletionChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// --- OIDC, connectors, decision trail, replay, checkpoints & reliability ------

/** `GET /api/v1/oidc/config`: the deployment's OIDC identity provider configuration. */
export interface OidcConfig {
  adapter: string;
  issuer_url: string;
  token_endpoint: string;
  jwks_uri: string;
  admin_url: string;
  project_id: string;
  connected: boolean;
  status: string;
}

/** Execution bounds carried in an agent's A2A permission envelope. */
export interface A2ALimits {
  max_tokens: number;
  max_duration_seconds: number;
  max_cost_usd: number;
}

/** Agent-to-agent permission claims provisioned for an agent key. */
export interface A2APermissionEnvelope {
  allowed_tools: string[];
  denied_tools: string[];
  allowed_models: string[];
  cwd_scope: string;
  limits: A2ALimits;
}

/** `POST /api/v1/agent-keys/{key_id}/oidc-sync`: synchronized OIDC client binding and A2A claims. */
export interface OidcSyncResult {
  key_id: string;
  idp_client_id: string;
  oidc_issuer: string;
  adapter: string;
  synced_at: string;
  scopes: string[];
  resource_pattern: string;
  a2a: A2APermissionEnvelope;
}

export interface EnforceOidcClaimsParams {
  key_id?: string;
  claims?: Record<string, unknown>;
  requested_tools?: string[];
  requested_model?: string;
  requested_cwd?: string;
  estimated_tokens?: number;
  estimated_duration_seconds?: number;
  estimated_cost_usd?: number;
  [key: string]: unknown;
}

/** `POST /api/v1/oidc/enforce-claims`: decision and effective bounds after evaluating A2A claims. */
export interface EnforceClaimsResult {
  allowed: boolean;
  violation_claim: string | null;
  detail: string;
  effective_tools: string[];
  resolved_cwd: string;
  limits: A2ALimits;
}

/** One provider in the universal connector catalog. */
export interface ConnectorCatalogEntry {
  provider_id: string;
  name: string;
  category: string;
  auth_types: string[];
  authorize_url: string;
  token_url: string;
  api_base_url: string;
  default_scopes: string[];
  pkce_supported: boolean;
  refresh_supported: boolean;
  revoke_url: string;
  docs_url: string;
  icon: string;
}

/** `GET /api/v1/connectors/catalog`: matching connector catalog entries and total count. */
export interface ConnectorCatalogList {
  data: ConnectorCatalogEntry[];
  total: number;
}

export interface ListConnectorCatalogParams extends RequestOptions {
  category?: string;
  q?: string;
}

export interface RegisterOAuthAuthenticatorParams {
  name: string;
  provider_id: string;
  client_id: string;
  client_secret?: string;
  authorize_url?: string;
  token_url?: string;
  redirect_uri?: string;
  scopes?: string[];
  api_base_url?: string;
  tenant_id?: string | null;
  extra_authorize_params?: Record<string, string>;
  [key: string]: unknown;
}

/** `POST /api/v1/oauth/register`: a registered OAuth authenticator with its client secret masked. */
export interface OAuthAuthenticator {
  authenticator_id: string;
  name: string;
  provider_id: string;
  org_id: string;
  client_id: string;
  client_secret_masked: string;
  authorize_url: string;
  token_url: string;
  redirect_uri: string;
  scopes: string[];
  api_base_url: string;
  tenant_id: string | null;
  extra_authorize_params: Record<string, string>;
  created_at: string;
}

export interface ProxyOAuthRequestOptions extends RequestOptions {
  method?: string;
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
  dryRun?: boolean;
  dry_run?: boolean;
}

export interface ProxyOAuthRequestInput extends ProxyOAuthRequestOptions {
  endpoint: string;
}

/** `POST /api/v1/oauth/proxy/{credential_id}`: proxied outbound request response. */
export interface CredentialProxyResponse {
  credential_id: string;
  provider_id: string;
  method: string;
  target_url: string;
  status_code: number;
  auto_refreshed: boolean;
  broker: string;
  headers_injected: string[];
  data: Record<string, unknown>;
}

/** One node in a run's execution decision graph. */
export interface DecisionNode {
  id: string;
  type: string;
  label: string;
  step_id: string;
  timestamp: string;
  duration_ms: number;
  confidence: number;
  tokens_used: number;
  cost_usd: number;
  outcome: string;
  rationale: string;
  evidence: Record<string, unknown>[];
  metadata: Record<string, unknown>;
}

/** A directed edge between two nodes in a run's decision graph. */
export interface DecisionEdge {
  from_node: string;
  to_node: string;
  edge_type: string;
  label: string;
}

/** Aggregate statistics across a run's decision trail. */
export interface DecisionTrailStatistics {
  total_nodes: number;
  total_edges: number;
  tool_calls_count: number;
  total_tokens: number;
  total_cost_usd: number;
  duration_ms: number;
  success: boolean;
}

/** `GET /api/v1/runs/{run_id}/decision-trail`: complete decision trail graph and statistics. */
export interface DecisionTrail {
  run_id: string;
  org: string;
  nodes: DecisionNode[];
  edges: DecisionEdge[];
  statistics: DecisionTrailStatistics;
}

export type ReplayMode = "strict" | "simulated" | "counterfactual" | (string & {});

export interface ReplayRunOptions extends RequestOptions {
  mode?: ReplayMode;
  overrides?: Record<string, unknown>;
  fromStepId?: string;
  from_step_id?: string;
}

/** One field-level difference between the original run and a replay. */
export interface ReplayDifference {
  step_id: string;
  field: string;
  original: unknown;
  replayed: unknown;
  significance: string;
}

/** `POST /api/v1/runs/{run_id}/replay`: outcome and diff report from replaying a run. */
export interface ReplayRunResult {
  replay_id: string;
  run_id: string;
  mode: string;
  success: boolean;
  original_outcome: Record<string, unknown>;
  replayed_outcome: Record<string, unknown>;
  differences: ReplayDifference[];
  duration_ms: number;
  created_at: string;
}

/** One persisted execution checkpoint for a run. */
export interface CheckpointRecord {
  checkpoint_id: string;
  thread_id: string;
  run_id: string;
  step_id: string;
  step_index: number;
  timestamp: string;
  state: Record<string, unknown>;
  metadata: Record<string, unknown>;
  parent_checkpoint_id: string | null;
}

/** `GET /api/v1/runs/{run_id}/checkpoints`: checkpoints recorded for a run. */
export interface CheckpointList {
  run_id: string;
  data: CheckpointRecord[];
}

export interface ResumeRunOptions extends RequestOptions {
  stateOverrides?: Record<string, unknown>;
  state_overrides?: Record<string, unknown>;
}

/** `POST /api/v1/runs/{run_id}/resume`: new run spawned from a checkpoint. */
export interface ResumeRunResult {
  run_id: string;
  source_run_id: string;
  resumed_from_checkpoint_id: string;
  resumed_from_step: string;
  state: string;
  restored_state: Record<string, unknown>;
  created_at: string;
}

export interface GetReliabilityMetricsOptions extends RequestOptions {
  agentId?: string;
  agent_id?: string;
}

/** `GET /api/v1/reliability/metrics`: aggregate reliability indicators. */
export interface ReliabilityMetrics {
  org: string;
  agent_id: string | null;
  sr: number;
  cr: number;
  pc: number;
  hir: number;
  ma: number;
  tcl: number;
  wct: number;
  total_runs: number;
  window: string;
}

/** `GET /api/v1/reliability/slo`: service-level objective compliance report. */
export interface ReliabilitySloReport {
  org: string;
  mtte_p95_ms: number;
  mtte_target_ms: number;
  mtte_compliant: boolean;
  rsr: number;
  rsr_target: number;
  rsr_compliant: boolean;
  overall_compliant: boolean;
  total_measurements: number;
  total_replays: number;
}

/** An anomaly detected across reliability metric trends. */
export interface AnomalyAlert {
  metric: string;
  severity: string;
  current_value: number;
  baseline_value: number;
  threshold: number;
  message: string;
  detected_at: string;
}

/** One time-bucketed slice of reliability metrics. */
export interface ReliabilityTrendBucket {
  bucket: string;
  sr: number;
  cr: number;
  pc: number;
  hir: number;
  ma: number;
  tcl: number;
  wct: number;
  runs: number;
}

/** `GET /api/v1/reliability/trends`: historical reliability buckets and detected anomalies. */
export interface ReliabilityTrends {
  org: string;
  buckets: ReliabilityTrendBucket[];
  anomalies: AnomalyAlert[];
}

/** One endpoint in the platform's observability stack. */
export interface TelemetryServiceEndpoint {
  service: string;
  url: string;
  healthy: boolean;
  protocol: string;
}

/** `GET /api/v1/telemetry/status`: status of the OpenTelemetry, Prometheus, Grafana, Tempo, and Loki stack. */
export interface TelemetryStackStatus {
  org: string;
  otel_enabled: boolean;
  prometheus_scraped: boolean;
  grafana_dashboards: string[];
  tempo_tracing_enabled: boolean;
  loki_logging_enabled: boolean;
  endpoints: TelemetryServiceEndpoint[];
}

/** Telemetry metrics for a single step within an execution. */
export interface StepTelemetryMetrics {
  step_id: string;
  step_name: string;
  status: string;
  duration_ms: number;
  tokens_used: number;
  cost_usd: number;
  retries: number;
}

/** `GET /api/v1/telemetry/executions/{execution_id}/metrics`: per-step and total telemetry metrics. */
export interface TelemetryExecutionMetrics {
  execution_id: string;
  pipeline_name: string;
  status: string;
  total_duration_ms: number;
  total_tokens: number;
  total_cost_usd: number;
  trace_id: string;
  steps: StepTelemetryMetrics[];
}

/** One human-in-the-loop interaction request and its resolution state. */
export interface HitlInteraction {
  interaction_id: string;
  execution_id: string;
  run_id: string;
  step_id: string;
  org: string;
  title: string;
  prompt: string;
  channels: string[];
  status: string;
  ui_schema: Record<string, unknown>;
  context: Record<string, unknown>;
  decision: string | null;
  response_data: Record<string, unknown> | null;
  responded_by: string | null;
  created_at: string;
  responded_at: string | null;
}

/** `GET /api/v1/hitl/interactions`: human-in-the-loop interactions for the organisation. */
export interface HitlInteractionList {
  data: HitlInteraction[];
  total: number;
}

export interface ListHitlInteractionsOptions extends RequestOptions {
  status?: string;
}

export interface RespondHitlInteractionOptions extends RequestOptions {
  responseData?: Record<string, unknown>;
  response_data?: Record<string, unknown>;
  respondedBy?: string;
  responded_by?: string;
}

export type GuardrailType = "input" | "dialog" | "retrieval" | "execution" | "output" | (string & {});

export interface EvaluateGuardrailsOptions extends RequestOptions {
  toolName?: string;
  tool_name?: string;
  toolArgs?: Record<string, unknown>;
  tool_args?: Record<string, unknown>;
  policies?: string[];
}

/** One guardrail violation triggered during content evaluation. */
export interface GuardrailViolation {
  rail_id: string;
  rail_type: string;
  category: string;
  severity: string;
  message: string;
  matched_text: string | null;
}

/** `POST /api/v1/guardrails/evaluate`: verdict, modified content, and triggered violations. */
export interface GuardrailEvaluation {
  rail_type: string;
  action: string;
  allowed: boolean;
  modified_content: string;
  refusal_message: string | null;
  triggered_rails: string[];
  violations: GuardrailViolation[];
}

export interface PlanToolsOptions extends RequestOptions {
  constraints?: Record<string, unknown>;
}

/** One planned tool invocation step with dependencies and cost/time estimates. */
export interface ToolPlanStep {
  step_id: string;
  tool_name: string;
  description: string;
  arguments: Record<string, unknown>;
  depends_on: string[];
  estimated_cost_usd: number;
  estimated_time_ms: number;
  fallback_tool: string | null;
}

/** `POST /api/v1/tools/plan`: execution plan of tool calls ordered into parallelizable stages. */
export interface ToolPlan {
  plan_id: string;
  task: string;
  steps: ToolPlanStep[];
  execution_order: string[][];
  total_estimated_cost_usd: number;
  total_estimated_time_ms: number;
  confidence: number;
}

/** Metadata for one Hugging Face model in the 9-model MatterWaveAI GRT-30M suite. */
export interface GrtModelEntry {
  repo_id: string;
  alias: string;
  model_type: string;
  auto_class: string;
  pipeline_tag: string;
  hf_url: string;
  weight_sha256: string | null;
  config_sha256: string;
}

/** `GET /api/v1/models/grt-suite`: catalog of the 9-model MatterWaveAI GRT-30M suite. */
export interface GrtSuiteCatalog {
  organization: string;
  hf_url: string;
  total: number;
  models: GrtModelEntry[];
  data?: GrtModelEntry[];
}

export interface RerankOptions extends RequestOptions {
  model?: string;
  topN?: number;
  top_n?: number;
}

/** One scored candidate document from `POST /v1/rerank`. */
export interface RerankItem {
  index: number;
  relevance_score: number;
  score?: number;
  document?: { text: string; [key: string]: unknown } | string;
}

/** `POST /v1/rerank`: ranked candidate documents scored against a query. */
export interface RerankResult {
  model: string;
  query?: string;
  results: RerankItem[];
  data?: RerankItem[];
}

export interface SynthesizeSpeechOptions extends RequestOptions {
  model?: string;
  voice?: string;
  format?: string;
}

/** `POST /v1/audio/speech`: synthesized audio metadata and base64 payload. */
export interface SpeechSynthesisResult {
  model: string;
  voice: string;
  format: string;
  sample_rate_hz: number;
  duration_ms?: number;
  audio_base64: string;
}

export const GRT_HF_ORG = "MatterWaveAI";
export const GRT_HF_ORG_URL = "https://huggingface.co/MatterWaveAI";

export const GRT_HF_MODELS: readonly GrtModelEntry[] = [
  {
    repo_id: "MatterWaveAI/grt-30m",
    alias: "grt-30m",
    model_type: "grt",
    auto_class: "GRTForCausalLM",
    pipeline_tag: "text-generation",
    hf_url: "https://huggingface.co/MatterWaveAI/grt-30m",
    weight_sha256: "205f76f3ed59fee0ed54bb8133ea1b1a64527994c68776066057b4707f1b2456",
    config_sha256: "5ffa4facb3cfba2b39512bbc54c7b7ecda637c70f40fd18ede13396cd8e5a86b",
  },
  {
    repo_id: "MatterWaveAI/grt-30m-chat",
    alias: "grt-30m-chat",
    model_type: "grt",
    auto_class: "GRTForCausalLM",
    pipeline_tag: "text-generation",
    hf_url: "https://huggingface.co/MatterWaveAI/grt-30m-chat",
    weight_sha256: "ee613803cb7b2c618def7e6c79476e1aab4e887cc08e234204b6bad12ad772bc",
    config_sha256: "c2b264a05e11914a8e41c1610f3c81e15d38151c459a1c66caaaa0381d804685",
  },
  {
    repo_id: "MatterWaveAI/grt-30m-mor",
    alias: "grt-30m-mor",
    model_type: "grt_mor",
    auto_class: "GRTForCausalLM",
    pipeline_tag: "text-generation",
    hf_url: "https://huggingface.co/MatterWaveAI/grt-30m-mor",
    weight_sha256: "5633a578073e808d18fe3e52fb0fbf0005dc015b6bb10a1bff339f5d83225a07",
    config_sha256: "bf652df2d4107c7e7ef3c23d0854436aedb0030f0821f97939ed6ed858254013",
  },
  {
    repo_id: "MatterWaveAI/grt-30m-embedding",
    alias: "grt-30m-embedding",
    model_type: "grt",
    auto_class: "GRTModel",
    pipeline_tag: "feature-extraction",
    hf_url: "https://huggingface.co/MatterWaveAI/grt-30m-embedding",
    weight_sha256: "5cdab387c5e2ee9bb3907acaccfccfaa7cc10060c21e3f265ce981a4a7d38226",
    config_sha256: "c987cec1b71deba4a1749a939032309921872ae2a6c21378f8160edb29b210df",
  },
  {
    repo_id: "MatterWaveAI/grt-30m-reranker",
    alias: "grt-30m-reranker",
    model_type: "grt",
    auto_class: "GRTForSequenceClassification",
    pipeline_tag: "text-classification",
    hf_url: "https://huggingface.co/MatterWaveAI/grt-30m-reranker",
    weight_sha256: "6d090decc4426a1c21a372c1bd718a6b80626e2c7b460c9ab79b713d84320ef9",
    config_sha256: "6f401b7ed6af93ed7fc93eedc6de44ad67f2f19ecdc5b3c96dcc92ee564750fc",
  },
  {
    repo_id: "MatterWaveAI/grt-30m-vl",
    alias: "grt-30m-vl",
    model_type: "grt_vl",
    auto_class: "GRTVLForConditionalGeneration",
    pipeline_tag: "image-text-to-text",
    hf_url: "https://huggingface.co/MatterWaveAI/grt-30m-vl",
    weight_sha256: "b21667c9d39c67513671af4fe4480551f26ac738b23821902fd78ae55a4f1dfe",
    config_sha256: "0fd2f34d415723412d54055ecb174bcbb60cccaf43235af52b6c13826e6bb859",
  },
  {
    repo_id: "MatterWaveAI/grt-30m-tts",
    alias: "grt-30m-tts",
    model_type: "grt_tts",
    auto_class: "GRTTTSForConditionalGeneration",
    pipeline_tag: "text-to-speech",
    hf_url: "https://huggingface.co/MatterWaveAI/grt-30m-tts",
    weight_sha256: "9df117cf2d9fdd14a972495293628bfea4ab503ee4fbcb270ffb667763e314f4",
    config_sha256: "74dca6d26f2726ae96033446d5d418a152aef8368a8e49aa49bb15f6364ca75a",
  },
  {
    repo_id: "MatterWaveAI/grt-30m-omni",
    alias: "grt-30m-omni",
    model_type: "grt_omni",
    auto_class: "GRTOmniForConditionalGeneration",
    pipeline_tag: "any-to-any",
    hf_url: "https://huggingface.co/MatterWaveAI/grt-30m-omni",
    weight_sha256: "b314996ce883a0c875de18da67f5d23103c507c79b7421b8b8c52cef95d2fbf7",
    config_sha256: "5bc88f708534280522872f046e89deade537f286a78bc261c1e039d03fa6d0cf",
  },
  {
    repo_id: "MatterWaveAI/grt-30m-tokenizer",
    alias: "grt-30m-tokenizer",
    model_type: "grt",
    auto_class: "AutoTokenizer",
    pipeline_tag: "feature-extraction",
    hf_url: "https://huggingface.co/MatterWaveAI/grt-30m-tokenizer",
    weight_sha256: null,
    config_sha256: "4c7ed24fcbaf5b1c62ec160296e682eb7b700ea19d88f0a8e01e363b125d505f",
  },
];

/** @internal One operation, ready for `send`. */
export interface Prepared {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  /** JSON, sent as the body. */
  body: unknown;
  keyed: boolean;
  stream: boolean;
  /** Headers the operation itself needs, such as `Last-Event-ID` on a resume. */
  headers?: Record<string, string>;
}

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RETRIES = 2;
// Backoff for a retry the server gave no `Retry-After` for: 0.5s, 1s, 2s ...
// capped, with jitter so a fleet of clients does not retry in lockstep.
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 8_000;
// A 429 the server says is the organisation's budget, not the window.
const NON_RETRYABLE_429_CODES = new Set(["insufficient_quota"]);
const API_PREFIX = "/v1";
const REQUEST_ID_HEADER = "x-request-id";
const USER_AGENT = `matterwave-typescript/${VERSION} (vscode-extension vendored)`;

export function resolveBaseUrl(baseUrl: string | null | undefined): string {
  const value = (baseUrl ?? "").trim();
  if (value === "") {
    throw new MatterWaveConfigError("No base URL: pass baseUrl to the MatterWave client.");
  }
  const trimmed = value.replace(/\/+$/, "");
  const withoutPrefix = trimmed.endsWith(API_PREFIX) ? trimmed.slice(0, -API_PREFIX.length) : trimmed;
  if (!/^https?:\/\//.test(withoutPrefix)) {
    throw new MatterWaveConfigError(`baseUrl must start with http:// or https://, got ${value}`);
  }
  return withoutPrefix;
}

/** `Retry-After` in seconds, whether the server sent a delay or a date. */
export function retryAfterSeconds(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (raw === null) return null;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const when = Date.parse(raw);
  if (Number.isNaN(when)) return null;
  return Math.max(0, (when - Date.now()) / 1000);
}

/**
 * The `X-RateLimit-*` trio, when the server sent all three as integers; a
 * partial or malformed set is treated as none rather than guessed at.
 */
export function rateLimitOf(response: Response): RateLimit | null {
  const limit = rateLimitHeader(response, "x-ratelimit-limit");
  const remaining = rateLimitHeader(response, "x-ratelimit-remaining");
  const reset = rateLimitHeader(response, "x-ratelimit-reset");
  if (limit === null || remaining === null || reset === null) return null;
  return { limit, remaining, reset };
}

function rateLimitHeader(response: Response, name: string): number | null {
  const raw = response.headers.get(name)?.trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isInteger(value) ? value : null;
}

/** How long to wait before retry number `attempt` (0-based), in milliseconds. */
export function backoffMs(attempt: number, retryAfterSeconds: number | null): number {
  if (retryAfterSeconds !== null) return retryAfterSeconds * 1000;
  const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return base * (0.5 + Math.random() * 0.5);
}

function withRequestId<T extends object>(value: T, requestId: string | null): WithRequestId<T> {
  Object.defineProperty(value, "requestId", { value: requestId, enumerable: false, configurable: true });
  return value as WithRequestId<T>;
}

function parseErrorBody(raw: string): { envelope: boolean; payload: unknown } {
  try {
    const payload: unknown = raw ? JSON.parse(raw) : null;
    const error = (payload as { error?: unknown } | null)?.error;
    return { envelope: typeof error === "object" && error !== null, payload };
  } catch {
    return { envelope: false, payload: raw };
  }
}

/** A FastAPI `detail` as one line: the string, or a 422's per-field messages joined. */
function detailText(detail: unknown): string | null {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const messages = detail
      .map((d) => (typeof d === "object" && d !== null ? (d as { msg?: unknown }).msg : null))
      .filter((m): m is string => typeof m === "string" && m !== "");
    return messages.length > 0 ? messages.join("; ") : null;
  }
  return null;
}

export function errorFromResponse(response: Response, raw: string): APIError {
  const { envelope, payload } = parseErrorBody(raw);
  const Cls = errorClassFor(response.status);
  const retryAfter = retryAfterSeconds(response);
  const rateLimit = rateLimitOf(response);
  const object =
    typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : null;
  const requestId =
    response.headers.get(REQUEST_ID_HEADER) ??
    (typeof object?.request_id === "string" ? object.request_id : null);
  if (envelope) {
    const error = (payload as { error: Record<string, unknown> }).error;
    return new Cls(String(error.message ?? `HTTP ${response.status}`), {
      status: response.status,
      type: typeof error.type === "string" ? error.type : null,
      code: typeof error.code === "string" ? error.code : null,
      param: typeof error.param === "string" ? error.param : null,
      requestId,
      retryAfter,
      rateLimit,
      body: payload,
    });
  }
  const detail = detailText(object?.detail);
  if (detail) {
    // The app's own routes answer `{"detail": ..., "request_id": ...}`,
    // FastAPI's shape with the ids beside it, rather than OpenAI's. A few
    // put a `code` beside the detail, and one of those names the thread
    // the conversation is answered in.
    const code = typeof object?.code === "string" ? object.code : null;
    if (response.status === 409 && code === CONNECTOR_CONVERSATION_CODE) {
      return new ConnectorConversationError(detail, {
        status: response.status,
        requestId,
        retryAfter,
        rateLimit,
        body: payload,
        source: sourceOf(object?.source),
      });
    }
    return new Cls(detail, { status: response.status, code, requestId, retryAfter, rateLimit, body: payload });
  }
  const text = raw.trim();
  const messageText = text ? `HTTP ${response.status}: ${text.slice(0, 200)}` : `HTTP ${response.status}`;
  return new Cls(messageText, { status: response.status, requestId, retryAfter, rateLimit, body: payload });
}

/** The thread a `connector_conversation` refusal names, in the shape a conversation carries it. */
function sourceOf(value: unknown): ConversationSource {
  const object = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const text = (field: unknown): string | null => (typeof field === "string" ? field : null);
  return {
    connector: text(object.connector) ?? "",
    connection_id: text(object.connection_id),
    channel_label: text(object.channel_label),
    url: text(object.url),
  };
}

/** 429 and 5xx, except the 429 that means the budget is spent. */
export function shouldRetry(response: Response, raw: string): boolean {
  if (response.status >= 500) return true;
  if (response.status !== 429) return false;
  const { envelope, payload } = parseErrorBody(raw);
  if (!envelope) return true;
  const code = (payload as { error: { code?: unknown } }).error.code;
  return !(typeof code === "string" && NON_RETRYABLE_429_CODES.has(code));
}

let sleeper: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Replace how the retry loop waits. Tests use it to measure the delays the
 * client asked for instead of waiting through them; it returns the previous
 * sleeper so they can put it back.
 */
export function setSleep(fn: (ms: number) => Promise<void>): (ms: number) => Promise<void> {
  const previous = sleeper;
  sleeper = fn;
  return previous;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * One controller for the fetch, aborted by the caller's signal or by the
 * timeout, whichever first. `timedOut` says which, so a timeout is reported
 * as one rather than as a generic connection failure.
 */
function linkSignals(
  controller: AbortController,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { clear: () => void; timedOut: boolean } {
  const state = { timedOut: false, clear: () => {} };
  const timer = setTimeout(() => {
    state.timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  state.clear = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  };
  return state;
}

export class MatterWave {
  readonly baseUrl: string;
  /** The app's conversations, as the key's owner sees them in the web app. */
  readonly conversations: Conversations;
  /** Device login: a key for a person, approved in their browser. */
  readonly auth: Auth;
  /** The org's agent presets, as any member reads them. */
  readonly presets: Presets;
  private readonly apiKey: string | null;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: Fetch;

  constructor(options: ClientOptions = {}) {
    this.apiKey = options.apiKey ?? null;
    this.baseUrl = resolveBaseUrl(options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (this.maxRetries < 0) throw new MatterWaveConfigError("maxRetries must be 0 or more");
    // Bound at construction: a bare `fetch` reference loses its `this` in
    // some runtimes, and an injected one is whatever the caller gave.
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.conversations = new Conversations(this);
    this.auth = new Auth(this);
    this.presets = new Presets(this);
  }

  /** `GET /api/me`: who the key (or device-login token) acts as. */
  me(options: RequestOptions = {}): Promise<WithRequestId<Me>> {
    return this.json<Me>(
      { method: "GET", path: "/api/me", body: undefined, keyed: true, stream: false },
      options,
    );
  }

  /** `GET /api/me/instructions`: the signed-in person's own instructions. */
  meInstructions(options: RequestOptions = {}): Promise<WithRequestId<UserInstructions>> {
    return this.json<UserInstructions>(
      { method: "GET", path: "/api/me/instructions", body: undefined, keyed: true, stream: false },
      options,
    );
  }

  /**
   * `PUT /api/me/instructions`: replace both fields. More than 3000
   * characters across the two is refused with 422; a plan without the
   * feature, with 402.
   */
  updateMeInstructions(
    params: { about?: string | null; style?: string | null },
    options: RequestOptions = {},
  ): Promise<WithRequestId<UserInstructions>> {
    return this.json<UserInstructions>(
      { method: "PUT", path: "/api/me/instructions", body: { about: params.about ?? null, style: params.style ?? null }, keyed: true, stream: false },
      options,
    );
  }

  /** `GET /api/org/instructions`; the organisation's owner and admins only. */
  orgInstructions(options: RequestOptions = {}): Promise<WithRequestId<UserInstructions>> {
    return this.json<UserInstructions>(
      { method: "GET", path: "/api/org/instructions", body: undefined, keyed: true, stream: false },
      options,
    );
  }

  /** `POST /v1/completions`: Fill-in-the-Middle (FIM) completion for prefix and suffix. */
  fimComplete(
    params: FimCompletionRequest,
    options: RequestOptions = {},
  ): Promise<WithRequestId<FimCompletionResponse>> {
    return this.json<FimCompletionResponse>(
      { method: "POST", path: "/v1/completions", body: defined({ ...params }), keyed: true, stream: false },
      options,
    );
  }

  /** `GET /api/v1/oidc/config`: the deployment's OIDC identity provider configuration. */
  getOidcConfig(options: RequestOptions = {}): Promise<WithRequestId<OidcConfig>> {
    return this.json<OidcConfig>(
      { method: "GET", path: "/api/v1/oidc/config", body: undefined, keyed: true, stream: false },
      options,
    );
  }

  /** `POST /api/v1/agent-keys/{key_id}/oidc-sync`: synchronize OIDC client credentials and A2A claims for `keyId`. */
  syncAgentKeyOidc(keyId: string, options: RequestOptions = {}): Promise<WithRequestId<OidcSyncResult>> {
    const seg = segment("keyId", keyId);
    return this.json<OidcSyncResult>(
      { method: "POST", path: `/api/v1/agent-keys/${seg}/oidc-sync`, body: undefined, keyed: true, stream: false },
      options,
    );
  }

  /** `POST /api/v1/oidc/enforce-claims`: evaluate an agent key's A2A permission envelope against a run request. */
  enforceOidcClaims(
    payload: EnforceOidcClaimsParams,
    options: RequestOptions = {},
  ): Promise<WithRequestId<EnforceClaimsResult>> {
    if (!payload || typeof payload !== "object" || Object.keys(payload).length === 0) {
      throw new MatterWaveConfigError("payload must not be empty");
    }
    return this.json<EnforceClaimsResult>(
      { method: "POST", path: "/api/v1/oidc/enforce-claims", body: payload, keyed: true, stream: false },
      options,
    );
  }

  /** `GET /api/v1/connectors/catalog`: list providers in the universal connector catalog. */
  listConnectorCatalog(
    paramsOrCategory?: ListConnectorCatalogParams | string | null,
    q?: string | null,
    options: RequestOptions = {},
  ): Promise<WithRequestId<ConnectorCatalogList>> {
    let category: string | undefined;
    let searchQ: string | undefined;
    let reqOptions: RequestOptions = options;
    if (typeof paramsOrCategory === "string") {
      category = paramsOrCategory;
      searchQ = q ?? undefined;
    } else if (paramsOrCategory && typeof paramsOrCategory === "object") {
      const { category: cat, q: queryStr, ...rest } = paramsOrCategory;
      category = cat;
      searchQ = queryStr ?? (q ?? undefined);
      reqOptions = { ...rest, ...options };
    } else if (q != null) {
      searchQ = q;
    }
    const qs = query({ category, q: searchQ });
    return this.json<ConnectorCatalogList>(
      { method: "GET", path: `/api/v1/connectors/catalog${qs}`, body: undefined, keyed: true, stream: false },
      reqOptions,
    );
  }

  /** `POST /api/v1/oauth/register`: register an OAuth authenticator for a connector catalog provider. */
  registerOAuthAuthenticator(
    payload: RegisterOAuthAuthenticatorParams,
    options: RequestOptions = {},
  ): Promise<WithRequestId<OAuthAuthenticator>> {
    if (!payload || typeof payload !== "object" || Object.keys(payload).length === 0) {
      throw new MatterWaveConfigError("payload must not be empty");
    }
    return this.json<OAuthAuthenticator>(
      { method: "POST", path: "/api/v1/oauth/register", body: payload, keyed: true, stream: false },
      options,
    );
  }

  /** `POST /api/v1/oauth/proxy/{credential_id}`: proxy an outbound API request through the credential broker. */
  proxyOAuthRequest(
    credentialId: string,
    endpointOrRequest: string | ProxyOAuthRequestInput,
    methodOrOptions: string | ProxyOAuthRequestOptions = "GET",
    options: ProxyOAuthRequestOptions = {},
  ): Promise<WithRequestId<CredentialProxyResponse>> {
    const seg = segment("credentialId", credentialId);
    let rawEndpoint: string;
    let merged: ProxyOAuthRequestOptions;
    if (typeof endpointOrRequest === "object" && endpointOrRequest !== null) {
      const { endpoint, ...fromInput } = endpointOrRequest;
      rawEndpoint = endpoint;
      merged =
        typeof methodOrOptions === "object" && methodOrOptions !== null
          ? { ...fromInput, ...methodOrOptions, ...options }
          : { ...fromInput, ...options };
    } else {
      rawEndpoint = endpointOrRequest;
      merged =
        typeof methodOrOptions === "string"
          ? { ...options, method: methodOrOptions }
          : { ...methodOrOptions, ...options };
    }
    const cleanedEndpoint = typeof rawEndpoint === "string" ? rawEndpoint.trim() : "";
    if (!cleanedEndpoint) throw new MatterWaveConfigError("endpoint must not be empty");
    const { method = "GET", params, headers, body, dryRun, dry_run, ...reqOptions } = merged;
    const cleanedMethod = typeof method === "string" ? method.trim().toUpperCase() : "";
    if (!cleanedMethod) throw new MatterWaveConfigError("method must not be empty");
    const payload: Record<string, unknown> = {
      endpoint: cleanedEndpoint,
      method: cleanedMethod,
    };
    if (params !== undefined) payload.params = params;
    if (headers !== undefined) payload.headers = headers;
    if (body !== undefined) payload.body = body;
    const resolvedDryRun = dryRun ?? dry_run;
    if (resolvedDryRun !== undefined) payload.dry_run = resolvedDryRun;
    return this.json<CredentialProxyResponse>(
      { method: "POST", path: `/api/v1/oauth/proxy/${seg}`, body: payload, keyed: true, stream: false },
      reqOptions,
    );
  }

  /** `GET /api/v1/runs/{run_id}/decision-trail`: retrieve the execution decision graph and statistics for `runId`. */
  getRunDecisionTrail(runId: string, options: RequestOptions = {}): Promise<WithRequestId<DecisionTrail>> {
    const seg = segment("runId", runId);
    return this.json<DecisionTrail>(
      { method: "GET", path: `/api/v1/runs/${seg}/decision-trail`, body: undefined, keyed: true, stream: false },
      options,
    );
  }

  /** `POST /api/v1/runs/{run_id}/replay`: replay a run in `simulated`, `strict`, or `counterfactual` mode. */
  replayRun(
    runId: string,
    modeOrOptions: ReplayMode | ReplayRunOptions = "simulated",
    overrides?: Record<string, unknown> | null,
    options: ReplayRunOptions = {},
  ): Promise<WithRequestId<ReplayRunResult>> {
    const seg = segment("runId", runId);
    const merged: ReplayRunOptions =
      typeof modeOrOptions === "string"
        ? { ...options, mode: modeOrOptions, ...(overrides != null ? { overrides } : {}) }
        : { ...modeOrOptions, ...options };
    const { mode = "simulated", overrides: ov, fromStepId, from_step_id, ...reqOptions } = merged;
    const cleanedMode = typeof mode === "string" ? mode.trim() : "";
    if (!cleanedMode) throw new MatterWaveConfigError("mode must not be empty");
    const payload: Record<string, unknown> = {
      mode: cleanedMode,
      overrides: ov ?? {},
    };
    const resolvedFromStep = fromStepId ?? from_step_id;
    if (resolvedFromStep !== undefined) payload.from_step_id = resolvedFromStep;
    return this.json<ReplayRunResult>(
      { method: "POST", path: `/api/v1/runs/${seg}/replay`, body: payload, keyed: true, stream: false },
      reqOptions,
    );
  }

  /** `GET /api/v1/runs/{run_id}/checkpoints`: list persisted checkpoints for `runId`. */
  listRunCheckpoints(runId: string, options: RequestOptions = {}): Promise<WithRequestId<CheckpointList>> {
    const seg = segment("runId", runId);
    return this.json<CheckpointList>(
      { method: "GET", path: `/api/v1/runs/${seg}/checkpoints`, body: undefined, keyed: true, stream: false },
      options,
    );
  }

  /** `POST /api/v1/runs/{run_id}/resume`: resume a run from `checkpointId`. */
  resumeRun(
    runId: string,
    checkpointId?: string | null,
    options: ResumeRunOptions = {},
  ): Promise<WithRequestId<ResumeRunResult>> {
    const seg = segment("runId", runId);
    const { stateOverrides, state_overrides, ...reqOptions } = options;
    const payload: Record<string, unknown> = {};
    if (checkpointId !== undefined && checkpointId !== null) {
      const cleanedCheckpoint = checkpointId.trim();
      if (!cleanedCheckpoint) throw new MatterWaveConfigError("checkpointId must not be empty");
      payload.checkpoint_id = cleanedCheckpoint;
    }
    const resolvedOverrides = stateOverrides ?? state_overrides;
    if (resolvedOverrides !== undefined) payload.state_overrides = resolvedOverrides;
    return this.json<ResumeRunResult>(
      { method: "POST", path: `/api/v1/runs/${seg}/resume`, body: payload, keyed: true, stream: false },
      reqOptions,
    );
  }

  /** `GET /api/v1/reliability/metrics`: retrieve aggregate reliability metrics. */
  getReliabilityMetrics(
    agentIdOrOptions?: string | GetReliabilityMetricsOptions | null,
    options: RequestOptions = {},
  ): Promise<WithRequestId<ReliabilityMetrics>> {
    let agentId: string | undefined;
    let reqOptions: RequestOptions = options;
    if (typeof agentIdOrOptions === "string") {
      agentId = agentIdOrOptions;
    } else if (agentIdOrOptions && typeof agentIdOrOptions === "object") {
      const { agentId: a1, agent_id: a2, ...rest } = agentIdOrOptions;
      agentId = a1 ?? a2;
      reqOptions = { ...rest, ...options };
    }
    const qs = query({ agent_id: agentId });
    return this.json<ReliabilityMetrics>(
      { method: "GET", path: `/api/v1/reliability/metrics${qs}`, body: undefined, keyed: true, stream: false },
      reqOptions,
    );
  }

  /** `GET /api/v1/reliability/slo`: retrieve the service-level objective compliance report. */
  getReliabilitySlo(options: RequestOptions = {}): Promise<WithRequestId<ReliabilitySloReport>> {
    return this.json<ReliabilitySloReport>(
      { method: "GET", path: "/api/v1/reliability/slo", body: undefined, keyed: true, stream: false },
      options,
    );
  }

  /** `GET /api/v1/reliability/trends`: retrieve historical reliability trend buckets and anomalies. */
  getReliabilityTrends(options: RequestOptions = {}): Promise<WithRequestId<ReliabilityTrends>> {
    return this.json<ReliabilityTrends>(
      { method: "GET", path: "/api/v1/reliability/trends", body: undefined, keyed: true, stream: false },
      options,
    );
  }

  /** `GET /api/v1/telemetry/status`: retrieve the status of the platform telemetry stack. */
  getTelemetryStatus(options: RequestOptions = {}): Promise<WithRequestId<TelemetryStackStatus>> {
    return this.json<TelemetryStackStatus>(
      { method: "GET", path: "/api/v1/telemetry/status", body: undefined, keyed: true, stream: false },
      options,
    );
  }

  /** `GET /api/v1/telemetry/executions/{execution_id}/metrics`: retrieve per-step telemetry metrics for `executionId`. */
  getExecutionTelemetry(
    executionId: string,
    options: RequestOptions = {},
  ): Promise<WithRequestId<TelemetryExecutionMetrics>> {
    const seg = segment("executionId", executionId);
    return this.json<TelemetryExecutionMetrics>(
      { method: "GET", path: `/api/v1/telemetry/executions/${seg}/metrics`, body: undefined, keyed: true, stream: false },
      options,
    );
  }

  /** `GET /api/v1/hitl/interactions`: list human-in-the-loop interaction requests. */
  listHitlInteractions(options: ListHitlInteractionsOptions = {}): Promise<WithRequestId<HitlInteractionList>> {
    const { status, ...reqOptions } = options;
    const qs = query({ status });
    return this.json<HitlInteractionList>(
      { method: "GET", path: `/api/v1/hitl/interactions${qs}`, body: undefined, keyed: true, stream: false },
      reqOptions,
    );
  }

  /** `POST /api/v1/hitl/interactions/{interaction_id}/respond`: submit a decision for a HITL interaction. */
  respondHitlInteraction(
    interactionId: string,
    decision: string,
    options: RespondHitlInteractionOptions = {},
  ): Promise<WithRequestId<HitlInteraction>> {
    const seg = segment("interactionId", interactionId);
    const cleanedDecision = typeof decision === "string" ? decision.trim() : "";
    if (!cleanedDecision) throw new MatterWaveConfigError("decision must not be empty");
    const { responseData, response_data, respondedBy, responded_by, ...reqOptions } = options;
    const payload: Record<string, unknown> = {
      decision: cleanedDecision,
    };
    const resolvedData = responseData ?? response_data;
    if (resolvedData !== undefined) payload.response_data = resolvedData;
    const resolvedBy = respondedBy ?? responded_by;
    if (resolvedBy !== undefined) payload.responded_by = resolvedBy;
    return this.json<HitlInteraction>(
      { method: "POST", path: `/api/v1/hitl/interactions/${seg}/respond`, body: payload, keyed: true, stream: false },
      reqOptions,
    );
  }

  /** `POST /api/v1/guardrails/evaluate`: evaluate content or tool calls against guardrails. */
  evaluateGuardrails(
    railType: GuardrailType,
    content: string,
    options: EvaluateGuardrailsOptions = {},
  ): Promise<WithRequestId<GuardrailEvaluation>> {
    const cleanedRailType = typeof railType === "string" ? railType.trim() : "";
    if (!cleanedRailType) throw new MatterWaveConfigError("railType must not be empty");
    const { toolName, tool_name, toolArgs, tool_args, policies, ...reqOptions } = options;
    const payload: Record<string, unknown> = {
      rail_type: cleanedRailType,
      content,
    };
    const resolvedToolName = toolName ?? tool_name;
    if (resolvedToolName !== undefined) payload.tool_name = resolvedToolName;
    const resolvedToolArgs = toolArgs ?? tool_args;
    if (resolvedToolArgs !== undefined) payload.tool_args = resolvedToolArgs;
    if (policies !== undefined) payload.policies = policies;
    return this.json<GuardrailEvaluation>(
      { method: "POST", path: "/api/v1/guardrails/evaluate", body: payload, keyed: true, stream: false },
      reqOptions,
    );
  }

  /** `POST /api/v1/tools/plan`: generate a dependency-ordered tool execution plan for `goal`. */
  planTools(
    goal: string,
    availableTools?: string[] | null,
    options: PlanToolsOptions = {},
  ): Promise<WithRequestId<ToolPlan>> {
    const cleanedGoal = typeof goal === "string" ? goal.trim() : "";
    if (!cleanedGoal) throw new MatterWaveConfigError("goal must not be empty");
    const { constraints, ...reqOptions } = options;
    const payload: Record<string, unknown> = {
      task: cleanedGoal,
      goal: cleanedGoal,
    };
    if (availableTools !== undefined && availableTools !== null) {
      payload.available_tools = availableTools;
    }
    if (constraints !== undefined) payload.constraints = constraints;
    return this.json<ToolPlan>(
      { method: "POST", path: "/api/v1/tools/plan", body: payload, keyed: true, stream: false },
      reqOptions,
    );
  }

  /** `POST /v1/rerank`: score and rank candidate documents against `queryStr` using `MatterWaveAI/grt-30m-reranker`. */
  rerank(
    queryStr: string,
    documents: string[],
    modelOrOptions: string | RerankOptions = "MatterWaveAI/grt-30m-reranker",
    options: RerankOptions = {},
  ): Promise<WithRequestId<RerankResult>> {
    const cleanedQuery = typeof queryStr === "string" ? queryStr.trim() : "";
    if (!cleanedQuery) throw new MatterWaveConfigError("query must not be empty");
    if (!Array.isArray(documents) || documents.length === 0) {
      throw new MatterWaveConfigError("documents must be a non-empty array");
    }
    const merged: RerankOptions =
      typeof modelOrOptions === "string"
        ? { ...options, model: modelOrOptions }
        : { ...modelOrOptions, ...options };
    const { model = "MatterWaveAI/grt-30m-reranker", topN, top_n, ...reqOptions } = merged;
    const payload: Record<string, unknown> = {
      query: cleanedQuery,
      documents: [...documents],
      model,
    };
    const resolvedTopN = topN ?? top_n;
    if (resolvedTopN !== undefined) payload.top_n = resolvedTopN;
    return this.json<RerankResult>(
      { method: "POST", path: "/v1/rerank", body: payload, keyed: true, stream: false },
      reqOptions,
    );
  }

  /** `POST /v1/audio/speech`: synthesize speech audio from `text` using `MatterWaveAI/grt-30m-tts`. */
  synthesizeSpeech(
    text: string,
    modelOrOptions: string | SynthesizeSpeechOptions = "MatterWaveAI/grt-30m-tts",
    voice = "aurora",
    options: SynthesizeSpeechOptions = {},
  ): Promise<WithRequestId<SpeechSynthesisResult>> {
    const cleanedText = typeof text === "string" ? text.trim() : "";
    if (!cleanedText) throw new MatterWaveConfigError("text must not be empty");
    const merged: SynthesizeSpeechOptions =
      typeof modelOrOptions === "string"
        ? { ...options, model: modelOrOptions, voice: options.voice ?? voice }
        : { voice, ...modelOrOptions, ...options };
    const { model = "MatterWaveAI/grt-30m-tts", voice: resolvedVoice = "aurora", format, ...reqOptions } = merged;
    const payload: Record<string, unknown> = {
      input: cleanedText,
      text: cleanedText,
      model,
      voice: resolvedVoice,
    };
    if (format !== undefined) payload.format = format;
    return this.json<SpeechSynthesisResult>(
      { method: "POST", path: "/v1/audio/speech", body: payload, keyed: true, stream: false },
      reqOptions,
    );
  }

  /** `GET /api/v1/models/grt-suite`: retrieve the 9-model MatterWaveAI GRT-30M Hugging Face suite catalog. */
  getGrtSuite(options: RequestOptions = {}): Promise<WithRequestId<GrtSuiteCatalog>> {
    return this.json<GrtSuiteCatalog>(
      { method: "GET", path: "/api/v1/models/grt-suite", body: undefined, keyed: true, stream: false },
      options,
    );
  }

  /** @internal One JSON operation, with the retry loop. */
  async json<T extends object>(prepared: Prepared, options: RequestOptions): Promise<WithRequestId<T>> {
    const { response } = await this.send(prepared, options);
    const requestId = response.headers.get(REQUEST_ID_HEADER);
    const raw = await response.text();
    let payload: unknown;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      throw new APIError("The API answered with a body that is not JSON.", {
        status: response.status,
        requestId,
        body: raw,
      });
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new APIError("The API answered with JSON that is not an object.", {
        status: response.status,
        requestId,
        body: payload,
      });
    }
    return withRequestId(payload as T, requestId);
  }

  /**
   * One operation, with the retry loop. A streamed response is handed back
   * unread with the controller that can cut it; a buffered one's body is
   * read here so the retry decision and the error can see it.
   * @internal
   */
  async send(
    prepared: Prepared,
    options: RequestOptions,
  ): Promise<{ response: Response; controller: AbortController }> {
    const idempotencyKey = READ_METHODS.has(prepared.method)
      ? null
      : (options.idempotencyKey ?? newIdempotencyKey());
    const headers = this.headersFor(prepared, options.headers, idempotencyKey);
    const url = this.baseUrl + prepared.path;
    const body =
      prepared.body === undefined ? undefined : JSON.stringify(prepared.body);
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const stop = linkSignals(controller, options.signal, this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: prepared.method,
          headers,
          body,
          signal: controller.signal,
        });
      } catch (cause) {
        stop.clear();
        if (options.signal?.aborted) throw cause;
        if (attempt >= this.maxRetries) {
          throw stop.timedOut
            ? new APITimeoutError(`${prepared.method} ${prepared.path} timed out.`, { cause })
            : new APIConnectionError(
                `${prepared.method} ${prepared.path} could not reach the API: ${describe(cause)}`,
                { cause },
              );
        }
        await sleeper(backoffMs(attempt, null));
        continue;
      }
      if (response.ok) {
        // The timeout covers the connection phase only: a streamed body
        // outlives this call, and a long answer must not be cut by it.
        stop.clear();
        return { response, controller };
      }
      const raw = await response.text();
      stop.clear();
      if (attempt < this.maxRetries && shouldRetry(response, raw)) {
        await sleeper(backoffMs(attempt, retryAfterSeconds(response)));
        continue;
      }
      throw errorFromResponse(response, raw);
    }
  }

  /**
   * The client's own `Accept` and `User-Agent`, then what the operation
   * needs (`Last-Event-ID` on a resume) and the call's own, then a write's
   * idempotency key, then the bearer.
   */
  private headersFor(
    prepared: Prepared,
    extra?: Record<string, string>,
    idempotencyKey: string | null = null,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: prepared.stream ? "text/event-stream" : "application/json",
      "User-Agent": USER_AGENT,
      ...(prepared.headers ?? {}),
      ...(extra ?? {}),
    };
    const named = Object.keys(headers).some((name) => name.toLowerCase() === IDEMPOTENCY_HEADER.toLowerCase());
    if (idempotencyKey !== null && !named) headers[IDEMPOTENCY_HEADER] = idempotencyKey;
    if (prepared.body !== undefined) headers["Content-Type"] = "application/json";
    if (prepared.keyed) {
      if (this.apiKey === null) {
        throw new MissingAPIKeyError(
          `${prepared.method} ${prepared.path} needs an API key: pass apiKey to the client.`,
        );
      }
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }
}

export { MatterWave as MatterWaveClient };

// --- the conversation API and device login (upstream conversations.ts, trimmed) --

// The resume path only reads `Last-Event-ID`, but the request body is
// validated before the route runs, so it has to be a valid send. A turn that
// was not a send (an edit, a regenerate) resumes through the same route with
// this in place of the text it never had.
export const RESUME_PLACEHOLDER = "(resume)";

const DEVICE_ERRORS = new Set(["authorization_pending", "slow_down", "expired_token", "access_denied"]);
const LIST_FILTERS: readonly ConversationFilter[] = ["default", "all", "pinned", "archived"];

/** @internal An id for a path segment; one that would change the path it is spliced into is a bug at the call site. */
export function segment(name: string, value: string): string {
  if (!value || value.includes("/") || value === "." || value === "..") {
    throw new MatterWaveConfigError(`${name} must be a non-empty id without '/', got ${value}`);
  }
  return encodeURIComponent(value);
}

function conversationPath(conversationId: string, suffix = ""): string {
  return `/api/conversations/${segment("conversationId", conversationId)}${suffix}`;
}

/** @internal */
export function query(params: Record<string, string | number | undefined>): string {
  const pairs = Object.entries(params).filter((p): p is [string, string | number] => p[1] !== undefined);
  return pairs.length === 0 ? "" : `?${new URLSearchParams(pairs.map(([k, v]) => [k, String(v)]))}`;
}

/** The fields that were given, so the server's defaults apply to the rest. */
function defined(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined && v !== null));
}

function turnBody(params: { content?: string } & Record<string, unknown>): Record<string, unknown> {
  if ("content" in params && !params.content) throw new MatterWaveConfigError("content must be non-empty");
  return defined(params);
}

/**
 * The request that picks a dropped turn up after `lastEventId`. It goes to
 * the send route whatever started the turn: that is where the server keeps
 * the resume path, and the header makes it replay rather than generate, so
 * the prompt is never billed twice.
 */
export function resumeRequest(original: Prepared, conversationId: string, lastEventId: string): Prepared {
  const body = { ...((original.body as Record<string, unknown> | undefined) ?? {}) };
  if (!body.content) body.content = RESUME_PLACEHOLDER;
  return {
    method: "POST",
    path: conversationPath(conversationId, "/messages"),
    body,
    keyed: true,
    stream: true,
    headers: { "Last-Event-ID": lastEventId },
  };
}

function dropped(cause: unknown): APIConnectionError {
  return new APIConnectionError(
    "The conversation stream ended before the turn did, and could not be resumed.",
    { cause },
  );
}

/**
 * One conversation turn as it streams: `for await` it for typed frames, or
 * `text()` for the answer's words.
 *
 * The stream ends after `done`, `error` or `moderation_block`. If the body
 * drops before then, the turn is picked up once from the last frame seen by
 * re-presenting `Last-Event-ID`; the server replays the rest of the same
 * generation rather than starting another.
 */
export class ConversationStream implements AsyncIterable<ConversationFrame> {
  readonly requestId: string | null;
  lastEventId: string | null = null;
  result: ConversationMessage | null = null;
  private consumed = false;

  constructor(
    private readonly client: MatterWave,
    private readonly prepared: Prepared,
    private readonly conversationId: string,
    private response: Response,
    private controller: AbortController,
    private readonly options: RequestOptions,
  ) {
    this.requestId = response.headers.get(REQUEST_ID_HEADER);
  }

  private frame(event: SSEEvent): ConversationFrame {
    if (event.id !== null) this.lastEventId = event.id;
    let data: unknown;
    try {
      data = JSON.parse(event.data);
    } catch {
      throw new APIError(`The stream carried a '${event.event}' frame that is not JSON.`, {
        status: null,
        requestId: this.requestId,
        body: event.data,
      });
    }
    const frame = frameFromEvent(event.event, data, event.id);
    if (frame.event === "done") this.result = frame.message;
    return frame;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ConversationFrame> {
    if (this.consumed) throw new MatterWaveError("A stream can be iterated once.");
    this.consumed = true;
    let resumed = false;
    try {
      for (;;) {
        let cause: unknown = undefined;
        const body = this.response.body;
        if (body === null) {
          throw new APIError("The stream has no body.", { status: null, requestId: this.requestId });
        }
        try {
          for await (const event of sseEvents(body)) {
            const frame = this.frame(event);
            yield frame;
            if (isTerminal(frame)) return;
          }
        } catch (err) {
          // A broken frame or the caller's abort is not a dropped body.
          if (err instanceof MatterWaveError || this.options.signal?.aborted) throw err;
          cause = err;
        }
        // One resume per stream; a turn that dropped before any frame carried
        // an id cannot resume without re-sending, which would bill twice.
        if (resumed || this.lastEventId === null) throw dropped(cause);
        resumed = true;
        this.controller.abort();
        await sleeper(backoffMs(0, null));
        const next = await this.client.send(
          resumeRequest(this.prepared, this.conversationId, this.lastEventId),
          this.options,
        );
        this.response = next.response;
        this.controller = next.controller;
      }
    } finally {
      this.controller.abort();
    }
  }

  /** The answer's text, skipping reasoning and every other frame. */
  async *text(): AsyncGenerator<string> {
    for await (const frame of this) {
      if (frame.event === "delta" && frame.content) yield frame.content;
    }
  }

  abort(): void {
    this.controller.abort();
  }
}

export class Conversations {
  constructor(private readonly client: MatterWave) {}

  private call<T extends object>(
    method: Prepared["method"],
    path: string,
    body: unknown,
    options: RequestOptions,
  ): Promise<WithRequestId<T>> {
    return this.client.json<T>({ method, path, body, keyed: true, stream: false }, options);
  }

  /**
   * `GET /api/conversations`: one page of the sidebar list. `filter` is `default` (unarchived,
   * pinned first), `all`, `pinned` or `archived`; `cursor` is a previous page's `next_cursor`,
   * which is null on the last page.
   */
  list(params: ListConversationsParams = {}, options: RequestOptions = {}): Promise<WithRequestId<ConversationList>> {
    if (params.filter !== undefined && !LIST_FILTERS.includes(params.filter)) {
      throw new MatterWaveConfigError(`filter must be one of ${LIST_FILTERS.join(", ")}, got ${params.filter}`);
    }
    const path = `/api/conversations${query({ filter: params.filter, limit: params.limit, cursor: params.cursor })}`;
    return this.call("GET", path, undefined, options);
  }

  /** `GET /api/conversations/search`: full text over the caller's own messages. */
  search(q: string, params: { limit?: number } = {}, options: RequestOptions = {}): Promise<WithRequestId<SearchResults>> {
    return this.call("GET", `/api/conversations/search${query({ q, limit: params.limit })}`, undefined, options);
  }

  /**
   * `POST /api/conversations`. An untitled one is named from its first
   * message. `preset_id` puts it on one of the org's presets; null or left
   * out is no preset.
   */
  create(params: CreateConversationParams = {}, options: RequestOptions = {}): Promise<WithRequestId<Conversation>> {
    if (params.preset_id === "") throw new MatterWaveConfigError("preset_id must be a preset's id, or null for no preset");
    return this.call("POST", "/api/conversations", defined({ ...params }), options);
  }

  /** The conversation and its active path; `full: true` adds `tree`. */
  get(
    conversationId: string,
    params: { full?: boolean } = {},
    options: RequestOptions = {},
  ): Promise<WithRequestId<ConversationWithMessages>> {
    const path = conversationPath(conversationId) + query({ full: params.full ? "1" : undefined });
    return this.call("GET", path, undefined, options);
  }

  /**
   * `PATCH /api/conversations/{id}`: rename the conversation, set the model
   * its turns use when a turn names none, set or clear its org preset, or a
   * combination.
   *
   * `default_model: null` clears the model back to the deployment's default;
   * `preset_id: null` clears the preset back to the conversation's own picks;
   * a key left out is left alone on the server, which reads an empty body as
   * "nothing to update" -- refused here before the request is made.
   */
  update(
    conversationId: string,
    params: UpdateConversationParams,
    options: RequestOptions = {},
  ): Promise<WithRequestId<Conversation>> {
    if (params.preset_id === "") {
      throw new MatterWaveConfigError("preset_id must be a preset's id, or null for no preset");
    }
    const body: Record<string, unknown> = {};
    if (params.default_model !== undefined) body.default_model = params.default_model;
    if (params.title !== undefined) body.title = params.title;
    if (params.preset_id !== undefined) body.preset_id = params.preset_id;
    if (Object.keys(body).length === 0) {
      throw new MatterWaveConfigError("update needs a title, a default_model, or a preset_id");
    }
    return this.call("PATCH", conversationPath(conversationId), body, options);
  }

  /** Every message, branches included, in creation order, as `messages`. */
  tree(conversationId: string, options: RequestOptions = {}): Promise<WithRequestId<ConversationWithMessages>> {
    return this.call("GET", conversationPath(conversationId, "/tree"), undefined, options);
  }

  /** Copy the path down to `messageId` into a new conversation. `ConflictError` for a temporary conversation: a temporary one is not kept, so it cannot be forked. */
  fork(
    conversationId: string,
    messageId: string,
    params: { title?: string | null } = {},
    options: RequestOptions = {},
  ): Promise<WithRequestId<ConversationWithMessages>> {
    segment("messageId", messageId);
    const body: Record<string, unknown> = { message_id: messageId };
    if (params.title !== undefined && params.title !== null) body.title = params.title;
    return this.call("POST", conversationPath(conversationId, "/fork"), body, options);
  }

  /** Show the branch ending at `messageId`; returns the new path. */
  setActiveLeaf(
    conversationId: string,
    messageId: string,
    options: RequestOptions = {},
  ): Promise<WithRequestId<ConversationWithMessages>> {
    segment("messageId", messageId);
    return this.call("PUT", conversationPath(conversationId, "/active-leaf"), { message_id: messageId }, options);
  }

  /**
   * `PUT /api/conversations/{id}/instructions`: set the conversation's own
   * instructions, or clear it back to the person's with `null`. Answers the
   * effective layers, `effective` included.
   */
  setInstructions(
    conversationId: string,
    text: string | null,
    options: RequestOptions = {},
  ): Promise<WithRequestId<ConversationInstructions>> {
    return this.call("PUT", conversationPath(conversationId, "/instructions"), { text }, options);
  }

  private async stream(prepared: Prepared, conversationId: string, options: RequestOptions): Promise<ConversationStream> {
    const { response, controller } = await this.client.send(prepared, options);
    return new ConversationStream(this.client, prepared, conversationId, response, controller, options);
  }

  /**
   * Append a user message and stream the reply. The server builds the prompt
   * from the stored history and instructions; `parent_id` sends onto that
   * branch instead of the current leaf.
   */
  send(conversationId: string, params: SendMessageParams, options: RequestOptions = {}): Promise<ConversationStream> {
    const body = turnBody({ ...params, attachment_ids: params.attachment_ids?.length ? params.attachment_ids : undefined });
    const prepared: Prepared = {
      method: "POST",
      path: conversationPath(conversationId, "/messages"),
      body,
      keyed: true,
      stream: true,
    };
    return this.stream(prepared, conversationId, options);
  }

  /** Edit a user message as a new branch beside it, and stream the answer. */
  edit(
    conversationId: string,
    messageId: string,
    params: EditMessageParams,
    options: RequestOptions = {},
  ): Promise<ConversationStream> {
    const prepared: Prepared = {
      method: "POST",
      path: conversationPath(conversationId, `/messages/${segment("messageId", messageId)}/edit`),
      body: turnBody({ ...params }),
      keyed: true,
      stream: true,
    };
    return this.stream(prepared, conversationId, options);
  }

  /** Answer an assistant message's turn again, as a sibling of it. */
  regenerate(
    conversationId: string,
    messageId: string,
    params: RegenerateMessageParams = {},
    options: RequestOptions = {},
  ): Promise<ConversationStream> {
    const prepared: Prepared = {
      method: "POST",
      path: conversationPath(conversationId, `/messages/${segment("messageId", messageId)}/regenerate`),
      body: defined({ ...params }),
      keyed: true,
      stream: true,
    };
    return this.stream(prepared, conversationId, options);
  }
}

/** The device-flow refusal inside an error response, or null for any other failure. Read bare or inside the API's `detail`. */
function deviceErrorOf(error: APIError): DeviceAuthError | null {
  const body = (typeof error.body === "object" && error.body !== null ? error.body : {}) as Record<string, unknown>;
  const detail = body.detail;
  let code: unknown = body.error;
  if (code === undefined && typeof detail === "object" && detail !== null) code = (detail as { error?: unknown }).error;
  else if (code === undefined && typeof detail === "string") code = detail;
  if (typeof code !== "string" || !DEVICE_ERRORS.has(code)) return null;
  const description = typeof body.error_description === "string" ? body.error_description : code;
  return new DeviceAuthError(description, {
    status: error.status,
    code,
    requestId: error.requestId,
    body: error.body,
  });
}

export class DeviceAuth {
  constructor(private readonly client: MatterWave) {}

  /** `POST /api/auth/device`: a code to show and the URL to approve it at. */
  start(params: { client_name?: string } = {}, options: RequestOptions = {}): Promise<WithRequestId<DeviceCode>> {
    return this.client.json<DeviceCode>(
      { method: "POST", path: "/api/auth/device", body: defined({ ...params }), keyed: false, stream: false },
      options,
    );
  }

  /** `POST /api/auth/device/token`, once. The token when approved; `DeviceAuthError` with the RFC's `code` while it is not. */
  async poll(deviceCode: string, options: RequestOptions = {}): Promise<WithRequestId<DeviceToken>> {
    if (!deviceCode) throw new MatterWaveConfigError("deviceCode must be non-empty");
    try {
      return await this.client.json<DeviceToken>(
        {
          method: "POST",
          path: "/api/auth/device/token",
          body: { device_code: deviceCode },
          keyed: false,
          stream: false,
        },
        options,
      );
    } catch (err) {
      const device = err instanceof APIError ? deviceErrorOf(err) : null;
      throw device ?? err;
    }
  }
}

export class Auth {
  readonly device: DeviceAuth;
  constructor(client: MatterWave) {
    this.device = new DeviceAuth(client);
  }
}

// --- presets (upstream connectors.ts, the reads) --------------------------------

/**
 * `/api/org/presets`: the org's agent presets. Any member reads them, an API
 * key with `chat:read` included, which is what a picker needs.
 */
export class Presets {
  constructor(private readonly client: MatterWave) {}

  /** The live presets, the tools a preset may name, the limits, and whether the caller may change them (`can_manage`). */
  list(options: RequestOptions = {}): Promise<WithRequestId<PresetListing>> {
    return this.client.json<PresetListing>(
      { method: "GET", path: "/api/org/presets", body: undefined, keyed: true, stream: false },
      options,
    );
  }

  /** One preset, a deleted one included (`deleted_at` says so). */
  get(presetId: string, options: RequestOptions = {}): Promise<WithRequestId<Preset>> {
    return this.client.json<Preset>(
      {
        method: "GET",
        path: `/api/org/presets/${segment("presetId", presetId)}`,
        body: undefined,
        keyed: true,
        stream: false,
      },
      options,
    );
  }
}

// --- Pi 1.0 provider & RPC protocol types (upstream pi/{provider,types}.ts) -----

export const MATTERWAVE_PROVIDER_NAME = "matterwave";
export const PRESET_HEADER = "X-MatterWave-Preset-Id";
export const TEMPORARY_HEADER = "X-MatterWave-Temporary";
export const ORG_HEADER = "X-MatterWave-Org-Id";

export interface PiModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface PiModelDefinition {
  id: string;
  name: string;
  api?: "openai-completions" | "openai-responses" | "anthropic-messages" | (string & {});
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: PiModelCost;
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

export interface PiProviderConfig {
  name?: string;
  baseUrl: string;
  apiKey?: string;
  api: "openai-completions" | "openai-responses" | "anthropic-messages" | (string & {});
  headers?: Record<string, string>;
  authHeader?: boolean;
  models: PiModelDefinition[];
}

export type PiRpcCommand =
  | { id?: string; type: "prompt"; message: string; images?: unknown[]; streamingBehavior?: "steer" | "followUp" }
  | { id?: string; type: "steer"; message: string; images?: unknown[] }
  | { id?: string; type: "follow_up"; message: string; images?: unknown[] }
  | { id?: string; type: "abort" }
  | { id?: string; type: "new_session"; parentSession?: string }
  | { id?: string; type: "get_state" }
  | { id?: string; type: "set_model"; provider: string; modelId: string }
  | { id?: string; type: "get_messages" }
  | { id?: string; type: "compact"; customInstructions?: string };

export type PiRpcCommandType = PiRpcCommand["type"];

export interface PiRpcSessionState {
  model?: { provider: string; id: string; [key: string]: unknown };
  thinkingLevel?: string;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled?: boolean;
  messageCount: number;
  pendingMessageCount: number;
  [key: string]: unknown;
}

export interface PiRpcResponseEvent<T = Record<string, unknown>> {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: T;
  error?: string;
}

export interface PiRpcAssistantMessageDelta {
  type: string;
  delta?: string;
  contentIndex?: number;
  id?: string;
  toolName?: string;
  [key: string]: unknown;
}

export type PiRpcEvent =
  | { type: "agent_start"; [key: string]: unknown }
  | { type: "agent_end"; messages?: unknown[]; [key: string]: unknown }
  | { type: "turn_start"; turnIndex?: number; timestamp?: number; [key: string]: unknown }
  | { type: "turn_end"; turnIndex?: number; message?: unknown; toolResults?: unknown[]; [key: string]: unknown }
  | { type: "message_start"; message: unknown; [key: string]: unknown }
  | { type: "message_update"; message?: unknown; assistantMessageEvent?: PiRpcAssistantMessageDelta; usage?: unknown; [key: string]: unknown }
  | { type: "message_end"; message: unknown; [key: string]: unknown }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown>; parentToolCallId?: string; [key: string]: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: Record<string, unknown>; partialResult: unknown; parentToolCallId?: string; [key: string]: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean; durationMs?: number; parentToolCallId?: string; [key: string]: unknown }
  | PiRpcResponseEvent;
