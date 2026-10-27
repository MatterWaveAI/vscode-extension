/**
 * Vendored from the MatterWave TypeScript SDK (MatterWaveAI/typescript-sdk,
 * MIT, version 0.1.0) and trimmed to the surface this extension uses: the
 * request/retry core, `me()`, device login, and the conversation API with
 * its streaming frames. The v1 chat-completions surface, the native
 * org/keys/webhooks/library/shares clients and the environment-variable
 * fallbacks are left out.
 *
 * It is vendored, not depended on, because `@matterwave/sdk` is not
 * published to npm and this repository no longer sits beside the SDK's
 * source in the monorepo. If the package is published, this file and its
 * importers can move back to the dependency. Change both together:
 * upstream `src/{client,conversations,conversation-types,errors,frames,sse}.ts`.
 *
 * The extension's own client (`src/api/client.ts`) wraps this one; the
 * routes the SDK does not model (pin, archive, delete, share, feedback,
 * context, compaction, attachments) ride the wrapper's own `json()` plumbing.
 */

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
export class MatterWaveConfigError extends Error {
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
}

/**
 * A conversation with messages: the active path from `get` and
 * `setActiveLeaf`, every message from `tree`.
 */
export interface ConversationWithMessages extends Conversation {
  messages: ConversationMessage[];
  tree?: ConversationMessage[];
  instructions?: Record<string, unknown>;
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
}

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
const USER_AGENT = "matterwave-typescript/0.1.0 (vscode-extension vendored)";

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
    // FastAPI's shape with the ids beside it, rather than OpenAI's.
    return new Cls(detail, { status: response.status, requestId, retryAfter, rateLimit, body: payload });
  }
  const text = raw.trim();
  const messageText = text ? `HTTP ${response.status}: ${text.slice(0, 200)}` : `HTTP ${response.status}`;
  return new Cls(messageText, { status: response.status, requestId, retryAfter, rateLimit, body: payload });
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
  }

  /** `GET /api/me`: who the key (or device-login token) acts as. */
  me(options: RequestOptions = {}): Promise<WithRequestId<Me>> {
    return this.json<Me>(
      { method: "GET", path: "/api/me", body: undefined, keyed: true, stream: false },
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
    const headers = this.headersFor(prepared, options.headers);
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
   * needs (`Last-Event-ID` on a resume) and the call's own, then the bearer.
   */
  private headersFor(prepared: Prepared, extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: prepared.stream ? "text/event-stream" : "application/json",
      "User-Agent": USER_AGENT,
      ...(prepared.headers ?? {}),
      ...(extra ?? {}),
    };
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

  /** `POST /api/conversations`. An untitled one is named from its first message. */
  create(params: CreateConversationParams = {}, options: RequestOptions = {}): Promise<WithRequestId<Conversation>> {
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
   * its turns use when a turn names none, or both.
   *
   * `default_model: null` clears the model back to the deployment's default;
   * a key left out is left alone on the server, which reads an empty body as
   * "nothing to update" -- refused here before the request is made.
   */
  update(
    conversationId: string,
    params: UpdateConversationParams,
    options: RequestOptions = {},
  ): Promise<WithRequestId<Conversation>> {
    const body: Record<string, unknown> = {};
    if (params.default_model !== undefined) body.default_model = params.default_model;
    if (params.title !== undefined) body.title = params.title;
    if (Object.keys(body).length === 0) {
      throw new MatterWaveConfigError("update needs a title or a default_model");
    }
    return this.call("PATCH", conversationPath(conversationId), body, options);
  }

  /** Every message, branches included, in creation order, as `messages`. */
  tree(conversationId: string, options: RequestOptions = {}): Promise<WithRequestId<ConversationWithMessages>> {
    return this.call("GET", conversationPath(conversationId, "/tree"), undefined, options);
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
