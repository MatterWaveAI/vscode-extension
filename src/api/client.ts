import {
  APIConnectionError,
  APIError,
  DeviceAuthError,
  MatterWave,
  MatterWaveConfigError,
  type ConversationFrame,
  type ConversationStream,
  type Fetch,
  type RequestOptions,
} from "../lib/matterwaveClient";
import { ApiError, detailOf, parseRetryAfter } from "./errors";
import type {
  ApiKeyListing,
  Attachment,
  BudgetStatus,
  ContextUsage,
  Conversation,
  ConversationDetail,
  ConversationInstructions,
  DeviceAuthorization,
  DevicePoll,
  FeedbackReason,
  FeedbackRow,
  Me,
  Message,
  ModelList,
  NotificationListing,
  NotificationRow,
  SendBody,
  ShareRow,
  UsageReport,
  UserInstructions,
} from "./types";

/**
 * The `/api` client the extension host uses. Everything that carries the
 * bearer goes through here, in the host; the webview never makes a request
 * and never sees a credential.
 *
 * Conversations, their streamed turns and device login come from the
 * MatterWave SDK, vendored at `src/lib/matterwaveClient.ts` (the package is
 * not published to npm, and this repository no longer sits beside its
 * source). What the SDK does not cover stays here: the chat model list, the
 * context meter and compaction sized by the picked model, attachment upload
 * (multipart), the conversation's pin / archive / delete toggles, share
 * links, reply feedback, and revoking the key device login minted.
 *
 * The SDK takes its key at construction and the editor's can change at any
 * moment (sign-in, sign-out, a new base URL), so an SDK client is built for
 * the credential in the secret store and replaced when that changes.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  /** A function so a change to the setting applies to the next request. */
  baseUrl: string | (() => string);
  /** Read on every request, so a sign-in or sign-out takes effect at once. */
  getToken: () => Promise<string | null>;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Told the `X-Request-Id` of every answer, error or not. */
  onRequestId?: (id: string) => void;
  /** Told whether the last request reached the API at all. */
  onReachability?: (online: boolean) => void;
}

/** How long one Retry-After is honoured before giving up instead. */
const MAX_RETRY_WAIT_S = 30;
const MAX_RETRIES = 2;
/** `mw_` and eight display characters: what `/api/keys` lists as a key's `prefix`. */
const KEY_PREFIX_LENGTH = 11;

/** What a turn ends with when its body was cut and could not be resumed. */
const TRUNCATED: ConversationFrame = {
  event: "error",
  id: null,
  detail: "The stream ended before the answer finished.",
  code: "truncated",
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface SdkClients {
  key: string;
  /** Retries 429 and 5xx as the SDK does: safe for reads and idempotent writes. */
  reads: MatterWave;
  /** Never retries: a turn or a create the API may already have applied must not be applied twice. */
  writes: MatterWave;
}

export class MatterWaveClient {
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private sdk: SdkClients | null = null;

  constructor(private readonly options: ClientOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? defaultSleep;
  }

  get baseUrl(): string {
    const base = typeof this.options.baseUrl === "function" ? this.options.baseUrl() : this.options.baseUrl;
    return base.replace(/\/+$/, "");
  }

  // --- identity and configuration ----------------------------------------

  me(): Promise<Me> {
    return this.call(({ reads }) => reads.me());
  }

  models(): Promise<ModelList> {
    return this.json("GET", "/api/models");
  }

  // --- device login (no bearer yet, by definition) ------------------------

  startDeviceLogin(clientName: string): Promise<DeviceAuthorization> {
    return this.call(({ reads }) => reads.auth.device.start({ client_name: clientName }));
  }

  /**
   * One poll of the token endpoint. A 4xx carrying an RFC 8628 `error` is an
   * answer, not a failure, so it comes back as a value; only an answer
   * without one throws.
   */
  async pollDeviceToken(deviceCode: string): Promise<DevicePoll> {
    try {
      const token = await (await this.api()).reads.auth.device.poll(deviceCode);
      return { ok: true, token };
    } catch (error) {
      if (error instanceof DeviceAuthError && error.code) return { ok: false, error: error.code };
      throw fromSdk(error);
    }
  }

  /**
   * Revoke the key `token` is. Device login hands back the key's value and
   * nothing else, so its id is found by the display prefix the listing
   * shows (the retired prefix too, if Settings rotated it meanwhile). A key
   * the listing no longer has was already revoked there: nothing to do.
   */
  async revokeKey(token: string): Promise<void> {
    const prefix = token.slice(0, KEY_PREFIX_LENGTH);
    const { data } = await this.json<{ data: ApiKeyListing[] }>("GET", "/api/keys");
    const match = data.find((k) => k.revoked_at === null && (k.prefix === prefix || k.previous_prefix === prefix));
    if (match) await this.json("DELETE", `/api/keys/${encodeURIComponent(match.id)}`);
  }

  // --- conversations -------------------------------------------------------

  async listConversations(): Promise<Conversation[]> {
    const list = await this.call(({ reads }) => reads.conversations.list());
    return list.data;
  }

  /** The archive sidebar draws from: every row whose `archived_at` is set. */
  async listArchivedConversations(): Promise<Conversation[]> {
    const list = await this.call(({ reads }) => reads.conversations.list({ filter: "archived" }));
    return list.data;
  }

  /** Full-text search over the caller's own messages, newest matches first. */
  async searchConversations(query: string): Promise<(Conversation & { snippet: string })[]> {
    const results = await this.call(({ reads }) => reads.conversations.search(query));
    return results.data;
  }

  /**
   * Create the conversation. `temporary` is fixed at creation, and the key
   * rides only when the chat is temporary: off, it is omitted entirely, so
   * the server's default (a kept conversation) governs.
   */
  createConversation(body: { title?: string; model?: string; temporary?: boolean } = {}): Promise<Conversation> {
    const params: { title?: string; model?: string; temporary?: boolean } = {};
    if (body.title !== undefined) params.title = body.title;
    if (body.model !== undefined) params.model = body.model;
    if (body.temporary === true) params.temporary = true;
    return this.call(({ writes }) => writes.conversations.create(params));
  }

  /** Rename, or set (or clear) the model the conversation's turns default to. */
  updateConversation(id: string, params: { title?: string; default_model?: string | null }): Promise<Conversation> {
    return this.call(({ reads }) => reads.conversations.update(id, params));
  }

  async getConversation(id: string): Promise<ConversationDetail> {
    return narrow(await this.call(({ reads }) => reads.conversations.get(id)));
  }

  async tree(id: string): Promise<Message[]> {
    return narrow(await this.call(({ reads }) => reads.conversations.tree(id))).messages;
  }

  async setActiveLeaf(id: string, messageId: string): Promise<ConversationDetail> {
    return narrow(await this.call(({ reads }) => reads.conversations.setActiveLeaf(id, messageId)));
  }

  // --- sidebar management (PUT sets a state, DELETE clears it) -------------

  pinConversation(id: string, pinned: boolean): Promise<Conversation> {
    return this.json(pinned ? "PUT" : "DELETE", `/api/conversations/${encodeURIComponent(id)}/pin`);
  }

  archiveConversation(id: string, archived: boolean): Promise<Conversation> {
    return this.json(archived ? "PUT" : "DELETE", `/api/conversations/${encodeURIComponent(id)}/archive`);
  }

  async deleteConversation(id: string): Promise<void> {
    await this.json("DELETE", `/api/conversations/${encodeURIComponent(id)}`);
  }

  /**
   * Mint a read-only link to a snapshot of the active path. The token is in
   * this one answer and nowhere else; `path` is the web app's `/share/…`
   * route, which the caller prefixes with its origin.
   */
  createShare(id: string): Promise<{ token: string; path: string }> {
    return this.json("POST", `/api/conversations/${encodeURIComponent(id)}/share`, {});
  }

  /** Rate a reply (1 or -1), with the optional reasons and comment the contract takes. A re-vote replaces. */
  setFeedback(
    messageId: string,
    feedback: { rating: -1 | 1; reasons?: FeedbackReason[]; comment?: string | null },
  ): Promise<FeedbackRow> {
    const body: { rating: -1 | 1; reasons?: FeedbackReason[]; comment?: string | null } = { rating: feedback.rating };
    if (feedback.reasons?.length) body.reasons = feedback.reasons;
    if (feedback.comment !== undefined) body.comment = feedback.comment;
    return this.json("PUT", `/api/messages/${encodeURIComponent(messageId)}/feedback`, body);
  }

  /** Withdraw a rating; idempotent on a message with none. */
  async deleteFeedback(messageId: string): Promise<void> {
    await this.json("DELETE", `/api/messages/${encodeURIComponent(messageId)}/feedback`);
  }

  /** The caller's own feedback rows for a conversation, to rehydrate the thumbs on open. */
  conversationFeedback(id: string): Promise<{ data: FeedbackRow[] }> {
    return this.json("GET", `/api/conversations/${encodeURIComponent(id)}/feedback`);
  }

  // --- notifications --------------------------------------------------------

  /**
   * The caller's notifications, newest first, with the unread count the bell
   * shows. `?unread=1` lists only the unread ones; the count is the same.
   */
  notifications(unreadOnly = false): Promise<NotificationListing> {
    return this.json("GET", unreadOnly ? "/api/me/notifications?unread=1" : "/api/me/notifications");
  }

  /** Mark one read; the answer carries the row and the count that remains. */
  readNotification(id: string): Promise<NotificationRow & { unread_count: number }> {
    return this.json("POST", `/api/me/notifications/${encodeURIComponent(id)}/read`, {});
  }

  /** Mark every row read; the answer is how many that was. */
  readAllNotifications(): Promise<{ read: number }> {
    return this.json("POST", "/api/me/notifications/read-all", {});
  }

  // --- usage and budget -------------------------------------------------------

  /** `GET /api/me/usage`: the org's balance this period, with its warn / overage / exhausted states. */
  usage(): Promise<UsageReport> {
    return this.json("GET", "/api/me/usage");
  }

  /** `GET /api/budget`: the period's allowance and the caller's own cap, in tokens and micro-dollars. */
  budget(): Promise<BudgetStatus> {
    return this.json("GET", "/api/budget");
  }

  // --- share management -------------------------------------------------------

  /** Every link this person made, live and revoked, for the manage command. */
  myShares(): Promise<{ data: ShareRow[] }> {
    return this.json("GET", "/api/me/shares");
  }

  /** One conversation's own links, for looking at what a share created. */
  conversationShares(id: string): Promise<{ data: ShareRow[] }> {
    return this.json("GET", `/api/conversations/${encodeURIComponent(id)}/shares`);
  }

  /** Take a link back; a share that is gone or was never the caller's is one 404. */
  async revokeShare(id: string): Promise<void> {
    await this.json("DELETE", `/api/shares/${encodeURIComponent(id)}`);
  }

  // --- instructions ---------------------------------------------------------

  /** `GET /api/me/instructions`: the person's own about/style text. */
  myInstructions(): Promise<UserInstructions> {
    return this.call(({ reads }) => reads.meInstructions());
  }

  /** `PUT /api/me/instructions`: replaces both fields; 422 past 3000 characters combined, 402 when plan-gated. */
  updateMyInstructions(params: { about?: string | null; style?: string | null }): Promise<UserInstructions> {
    return this.call(({ writes }) => writes.updateMeInstructions(params));
  }

  /** `GET /api/org/instructions`; owner and admins only. */
  orgInstructions(): Promise<UserInstructions> {
    return this.call(({ reads }) => reads.orgInstructions());
  }

  /** Set (or clear, with `null`) the conversation's own instructions; the answer carries the effective layers. */
  setConversationInstructions(id: string, text: string | null): Promise<ConversationInstructions> {
    return this.call(({ writes }) => writes.conversations.setInstructions(id, text));
  }

  /** `model` sizes the meter by that model's window; the conversation's default otherwise. */
  context(id: string, model?: string): Promise<ContextUsage> {
    const query = model ? `?model=${encodeURIComponent(model)}` : "";
    return this.json("GET", `/api/conversations/${encodeURIComponent(id)}/context${query}`);
  }

  /** The summary message, or an ApiError with status 409 when there is nothing to fold. */
  compact(id: string, model?: string): Promise<Message> {
    return this.json("POST", `/api/conversations/${encodeURIComponent(id)}/compact`, model ? { model } : {});
  }

  /** Upload one file; the API decides its type from the bytes, not from `type` here. */
  uploadAttachment(file: Blob, filename: string, conversationId?: string): Promise<Attachment> {
    const form = new FormData();
    form.append("file", file, filename);
    const query = conversationId ? `?conversation_id=${encodeURIComponent(conversationId)}` : "";
    return this.json("POST", `/api/attachments${query}`, form);
  }

  // --- turns (SSE) ---------------------------------------------------------

  sendMessage(conversationId: string, body: SendBody, signal?: AbortSignal): AsyncGenerator<ConversationFrame> {
    return this.turn(signal, (api, options) => api.conversations.send(conversationId, body, options));
  }

  editMessage(
    conversationId: string,
    messageId: string,
    body: { content: string; model?: string },
    signal?: AbortSignal,
  ): AsyncGenerator<ConversationFrame> {
    return this.turn(signal, (api, options) => api.conversations.edit(conversationId, messageId, body, options));
  }

  regenerate(
    conversationId: string,
    messageId: string,
    body: { model?: string },
    signal?: AbortSignal,
  ): AsyncGenerator<ConversationFrame> {
    return this.turn(signal, (api, options) => api.conversations.regenerate(conversationId, messageId, body, options));
  }

  /**
   * One turn's typed frames. The SDK picks a dropped body up once with
   * `Last-Event-ID`, which replays the rest of the same generation and never
   * starts a second one (no double billing). A body that still ends without
   * a terminal frame comes back as a synthetic `truncated` error so the UI
   * can say the answer is incomplete instead of presenting a cut answer as
   * finished. An HTTP refusal (402, 409, 422 ...) is final and throws.
   */
  private async *turn(
    signal: AbortSignal | undefined,
    start: (api: MatterWave, options: RequestOptions) => Promise<ConversationStream>,
  ): AsyncGenerator<ConversationFrame> {
    const { writes } = await this.api();
    let stream: ConversationStream;
    try {
      stream = await start(writes, { signal });
    } catch (error) {
      throw fromSdk(error);
    }
    try {
      for await (const frame of stream) yield frame;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof APIConnectionError) {
        yield TRUNCATED;
        return;
      }
      throw fromSdk(error);
    }
  }

  // --- plumbing ------------------------------------------------------------

  /** The SDK clients for the credential in the store right now. */
  private async api(): Promise<SdkClients> {
    const token = await this.options.getToken();
    const baseUrl = this.baseUrl;
    const key = `${baseUrl}\n${token ?? ""}`;
    if (this.sdk?.key !== key) {
      // An empty key rather than null: null makes the SDK fall back to
      // MATTERWAVE_API_KEY in the host's environment, which must never sign
      // the editor in. Empty sends a bearer the API refuses with a 401, the
      // same answer a request with no credential gets.
      const common = { baseUrl, apiKey: token ?? "", fetch: this.observed };
      try {
        this.sdk = { key, reads: new MatterWave(common), writes: new MatterWave({ ...common, maxRetries: 0 }) };
      } catch (error) {
        throw fromSdk(error);
      }
    }
    return this.sdk;
  }

  private async call<T>(work: (api: SdkClients) => Promise<T>): Promise<T> {
    try {
      return await work(await this.api());
    } catch (error) {
      throw fromSdk(error);
    }
  }

  /** Every request, the SDK's and this file's own, reports reachability and the request id here. */
  private readonly observed: Fetch = async (input, init) => {
    let response: Response;
    try {
      response = await this.fetchImpl(input, init);
    } catch (error) {
      if (!init.signal?.aborted) this.options.onReachability?.(false);
      throw error;
    }
    this.options.onReachability?.(true);
    const requestId = response.headers.get("x-request-id");
    if (requestId) this.options.onRequestId?.(requestId);
    return response;
  };

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    // A write is POSTed once: retrying one the API may have applied would
    // apply it twice. 429 is the exception -- it is a refusal before any
    // work -- and GETs also retry on a gateway that is briefly unavailable.
    for (let attempt = 0; ; attempt++) {
      const response = await this.send(method, path, body);
      const parsed: unknown = response.status === 204 ? null : await response.json().catch(() => null);
      if (response.ok) return parsed as T;
      const error = this.errorFrom(response, parsed);
      const retryable = response.status === 429 || (method === "GET" && [502, 503, 504].includes(response.status));
      const wait = error.retryAfterS ?? (retryable ? 1 : null);
      if (!retryable || attempt >= MAX_RETRIES || wait === null || wait > MAX_RETRY_WAIT_S) throw error;
      await this.sleep(wait * 1000);
    }
  }

  private async send(method: string, path: string, body: unknown): Promise<Response> {
    const headers: Record<string, string> = {};
    const token = await this.options.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload: BodyInit | undefined;
    if (body instanceof FormData) {
      payload = body;
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    try {
      return await this.observed(this.baseUrl + path, { method, headers, body: payload });
    } catch (error) {
      throw new ApiError(0, error instanceof Error ? error.message : "network error", null);
    }
  }

  private errorFrom(response: Response, body: unknown): ApiError {
    return new ApiError(
      response.status,
      detailOf(body, `HTTP ${response.status}`),
      response.headers.get("x-request-id"),
      parseRetryAfter(response.headers.get("retry-after")),
      codeOf(body),
    );
  }
}

/** The body's machine-readable `code` or `error`, where it has one. */
function codeOf(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  if ("code" in body && typeof body.code === "string") return body.code;
  if ("error" in body && typeof body.error === "string") return body.error;
  return null;
}

/**
 * The SDK's failures as this extension's one error type, so the controller
 * and the commands keep a single branch. Status 0 is "never answered", which
 * the UI reads as unreachable: that covers a dead network, a timeout, and a
 * base URL setting the SDK will not build a client for.
 */
function fromSdk(error: unknown): unknown {
  if (error instanceof ApiError) return error;
  if (error instanceof APIError) {
    return new ApiError(error.status ?? 0, error.message, error.requestId, error.retryAfter, error.code ?? codeOf(error.body));
  }
  if (error instanceof APIConnectionError || error instanceof MatterWaveConfigError) {
    return new ApiError(0, error.message, null);
  }
  return error;
}

/**
 * The SDK types a message's parts loosely (`type: string`); the renderer
 * switches over the part types the API writes, so the shapes are narrowed
 * here, at the one place they enter. Same bytes, tighter type.
 */
function narrow<T extends { messages: unknown[] }>(detail: T): Omit<T, "messages"> & { messages: Message[] } {
  return detail as Omit<T, "messages"> & { messages: Message[] };
}
