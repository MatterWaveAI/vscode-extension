import {
  APIConnectionError,
  APIError,
  DeviceAuthError,
  MatterWave,
  MatterWaveConfigError,
  sseEvents,
  type ConversationFrame,
  type ConversationStream,
  type Fetch,
  type RequestOptions,
} from "../lib/matterwaveClient";
import { ApiError, detailOf, parseRetryAfter } from "./errors";
import { buildSpeechFormData } from "../chat/dictation";
import type { ChatCompletionChunk, ChatCompletionRequest } from "../agent/wire";
import type {
  Announcement,
  ApiKeyCreated,
  AccountExport,
  ApiKeyListing,
  Attachment,
  BudgetStatus,
  AttachmentLimits,
  ContextUsage,
  Conversation,
  ConversationDetail,
  ConversationInstructions,
  DeviceAuthorization,
  DevicePoll,
  Enforcement,
  Entitlements,
  FeedbackReason,
  FeedbackRow,
  FolderRow,
  ImportRecord,
  Library,
  Me,
  Message,
  ModelList,
  NotificationListing,
  NotificationRow,
  OrgInstructions,
  Preset,
  PresetListing,
  SearchHit,
  SendBody,
  ShareRow,
  TagRow,
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
 * links, reply feedback, revoking the key device login minted, and the
 * library's folders and tags.
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
  /** Told of every request once it is answered or fails: never its body, its query or its credential. */
  onRequest?: (entry: RequestLogEntry) => void;
}

/** One request as the log records it. */
export interface RequestLogEntry {
  method: string;
  /** The URL's path, without its query. */
  path: string;
  /** Null when no answer came. */
  status: number | null;
  requestId: string | null;
  /** Until the answer's headers (a streamed turn goes on after that). */
  ms: number;
  /** What the runtime said when no answer came; null otherwise. */
  error: string | null;
}

/** The log line for a request: method, path, status or failure, time, and the reference to quote. */
export function requestLogLine(entry: RequestLogEntry): string {
  const outcome = entry.status !== null ? String(entry.status) : `failed: ${entry.error ?? "no answer"}`;
  return `${entry.method} ${entry.path} -> ${outcome} in ${entry.ms} ms${entry.requestId ? ` (request ${entry.requestId})` : ""}`;
}

/** How long one Retry-After is honoured before giving up instead. */
const MAX_RETRY_WAIT_S = 30;
const MAX_RETRIES = 2;
/** `mw_` and eight display characters: what `/api/keys` lists as a key's `prefix`. */
const KEY_PREFIX_LENGTH = 11;
/** The API's cap on one page of the conversation list. */
const MAX_LIST_PAGE = 200;

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

  /** `GET /api/org/presets`: the org's live presets, the tools a preset may name, and the limits. */
  presets(): Promise<PresetListing> {
    return this.call(({ reads }) => reads.presets.list());
  }

  /** `GET /api/org/presets/{id}`: one preset by id, including a deleted one (`deleted_at` set). */
  preset(id: string): Promise<Preset> {
    return this.call(({ reads }) => reads.presets.get(id));
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

  // --- key management ------------------------------------------------------

  /** Every key the caller may see: the org's, or its own row alone without `keys:manage`. */
  listKeys(): Promise<{ data: ApiKeyListing[] }> {
    return this.json("GET", "/api/keys");
  }

  /**
   * Mint a key; `key` is in this answer and nowhere else, ever. Scopes left
   * out are the API's default (chat:read, chat:write); no expiry is a key
   * that does not expire.
   */
  createKey(name: string, options: { scopes?: string[]; expiresInDays?: number } = {}): Promise<ApiKeyCreated> {
    return this.json("POST", "/api/keys", {
      name,
      ...(options.scopes ? { scopes: options.scopes } : {}),
      ...(options.expiresInDays ? { expires_in_days: options.expiresInDays } : {}),
    });
  }

  /** A new name for a key; its secret, scopes and expiry stay as they are. */
  renameKey(id: string, name: string): Promise<ApiKeyListing> {
    return this.json("PATCH", `/api/keys/${encodeURIComponent(id)}`, { name });
  }

  // --- account ---------------------------------------------------------------

  /** `GET /api/me/enforcement`: what moderation applies to the caller now; `state: "none"` for nearly everyone. */
  enforcement(): Promise<Enforcement> {
    return this.json("GET", "/api/me/enforcement");
  }

  /** `POST /api/me/export`: queue an export of everything this account has stored. */
  startExport(): Promise<AccountExport> {
    return this.json("POST", "/api/me/export", {});
  }

  /** Where an export stands; `download_url` (a path on the deployment) once it is ready. */
  exportStatus(id: string): Promise<AccountExport> {
    return this.json("GET", `/api/me/export/${encodeURIComponent(id)}`);
  }

  /** `GET /api/attachments/limits/me`: the largest upload, and what remains of the caller's storage. */
  attachmentLimits(): Promise<AttachmentLimits> {
    return this.json("GET", "/api/attachments/limits/me");
  }

  /** A new secret for the same key; the old one keeps working while `previous_valid_until` says. */
  rotateKey(id: string): Promise<ApiKeyCreated> {
    return this.json("POST", `/api/keys/${encodeURIComponent(id)}/rotate`, {});
  }

  /** Revoke one key by id; a key may always revoke itself, whatever its scopes. */
  async revokeKeyById(id: string): Promise<void> {
    await this.json("DELETE", `/api/keys/${encodeURIComponent(id)}`);
  }

  // --- conversations -------------------------------------------------------

  /**
   * One page of the sidebar list (the API's page is 50), and the cursor
   * that resumes it -- null on the last page. `archived` reads the archive
   * instead: every row whose `archived_at` is set.
   */
  async listConversations(
    options: { archived?: boolean; cursor?: string | null } = {},
  ): Promise<{ data: Conversation[]; nextCursor: string | null }> {
    const params: { filter?: "archived"; cursor?: string } = {};
    if (options.archived) params.filter = "archived";
    if (options.cursor) params.cursor = options.cursor;
    const list = await this.call(({ reads }) => reads.conversations.list(params));
    return { data: list.data, nextCursor: list.next_cursor ?? null };
  }

  /**
   * Every conversation in the list, page after page at the API's widest
   * page, for a picker that has to offer all of them.
   */
  async allConversations(): Promise<Conversation[]> {
    const rows: Conversation[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.call(({ reads }) => reads.conversations.list({ limit: MAX_LIST_PAGE, ...(cursor ? { cursor } : {}) }));
      rows.push(...page.data);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return rows;
  }

  /** Full-text search over the caller's own messages, newest matches first. */
  async searchConversations(query: string): Promise<(Conversation & { snippet: string })[]> {
    const results = await this.call(({ reads }) => reads.conversations.search(query));
    return results.data;
  }

  /**
   * `GET /api/search`: titles and messages, ranked by relevance and
   * recency, a page at a time; `nextCursor` is null on the last page.
   */
  async search(query: string, cursor?: string | null): Promise<{ data: SearchHit[]; nextCursor: string | null }> {
    const params = new URLSearchParams({ q: query });
    if (cursor) params.set("cursor", cursor);
    const page = await this.json<{ data: SearchHit[]; next_cursor: string | null }>("GET", `/api/search?${params}`);
    return { data: page.data, nextCursor: page.next_cursor ?? null };
  }

  /** Copy the path down to `messageId` into a new conversation of the caller's; a temporary one answers 409. */
  forkConversation(id: string, messageId: string, title?: string): Promise<Conversation> {
    return this.json("POST", `/api/conversations/${encodeURIComponent(id)}/fork`, {
      message_id: messageId,
      ...(title ? { title } : {}),
    });
  }

  /**
   * Report a conversation, or one message in it: `unsafe` goes to review,
   * `unhelpful` to the product backlog. The note is the reporter's own words.
   */
  async reportConversation(id: string, report: { kind: "unsafe" | "unhelpful"; messageId?: string; note?: string }): Promise<void> {
    await this.json("POST", `/api/conversations/${encodeURIComponent(id)}/report`, {
      kind: report.kind,
      ...(report.messageId ? { message_id: report.messageId } : {}),
      ...(report.note ? { note: report.note } : {}),
    });
  }

  /** `GET /api/announcements`: the deployment's notices inside their window, most severe first. */
  announcements(): Promise<{ data: Announcement[] }> {
    return this.json("GET", "/api/announcements");
  }

  /**
   * Create the conversation. `temporary` is fixed at creation, and the key
   * rides only when the chat is temporary: off, it is omitted entirely, so
   * the server's default (a kept conversation) governs.
   */
  createConversation(
    body: { title?: string; model?: string; temporary?: boolean; preset_id?: string | null } = {},
  ): Promise<Conversation> {
    const params: { title?: string; model?: string; temporary?: boolean; preset_id?: string | null } = {};
    if (body.title !== undefined) params.title = body.title;
    if (body.model !== undefined) params.model = body.model;
    if (body.temporary === true) params.temporary = true;
    if (body.preset_id !== undefined) params.preset_id = body.preset_id;
    return this.call(({ writes }) => writes.conversations.create(params));
  }

  /** Rename, set (or clear) the model, or set (or clear) the preset for the conversation. */
  updateConversation(
    id: string,
    params: { title?: string; default_model?: string | null; preset_id?: string | null },
  ): Promise<Conversation> {
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
   * shows. `unreadOnly` lists only the unread ones (`?unread=1`; the count is
   * the same); `limit` caps the page, which the API takes up to 100.
   */
  notifications(options: { unreadOnly?: boolean; limit?: number } = {}): Promise<NotificationListing> {
    const params = new URLSearchParams();
    if (options.unreadOnly) params.set("unread", "1");
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const query = params.toString();
    return this.json("GET", `/api/me/notifications${query ? `?${query}` : ""}`);
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

  // --- library -----------------------------------------------------------------

  /**
   * `GET /api/library`: the caller's folders, their tags, and which tags each
   * conversation carries, in one read -- the sidebar's badge and the
   * organize and manage-tags commands all draw from it.
   */
  listLibrary(): Promise<Library> {
    return this.json("GET", "/api/library");
  }

  /** `POST /api/library/folders`; a name the caller already holds answers 409. */
  createFolder(name: string): Promise<FolderRow> {
    return this.json("POST", "/api/library/folders", { name });
  }

  /**
   * `POST /api/library/tags`; the API reads "a tag called X" as a request
   * with one answer, so an existing tag of that name comes back too.
   */
  createTag(name: string): Promise<TagRow> {
    return this.json("POST", "/api/library/tags", { name });
  }

  /**
   * File the conversation in one of the caller's folders, or back into the
   * main list with `null`. The field is always sent: an omitted one would be
   * no answer, not an unfiling.
   */
  moveToFolder(conversationId: string, folderId: string | null): Promise<Conversation> {
    return this.json("PUT", `/api/library/conversations/${encodeURIComponent(conversationId)}/folder`, {
      folder_id: folderId,
    });
  }

  /** Replace the conversation's tags with this set; an empty one clears them. */
  setTags(conversationId: string, tagIds: string[]): Promise<{ conversation_id: string; tag_ids: string[] }> {
    return this.json("PUT", `/api/library/conversations/${encodeURIComponent(conversationId)}/tags`, {
      tag_ids: tagIds,
    });
  }

  /** `PATCH /api/library/folders/{id}`: a new name; one the caller already uses answers 409. */
  renameFolder(id: string, name: string): Promise<FolderRow> {
    return this.json("PATCH", `/api/library/folders/${encodeURIComponent(id)}`, { name });
  }

  /** Delete a folder; its conversations go back to the main list, nothing else is deleted. */
  async deleteFolder(id: string): Promise<void> {
    await this.json("DELETE", `/api/library/folders/${encodeURIComponent(id)}`);
  }

  /** Take a tag off every conversation that carries it; a gone or foreign one is one 404. */
  async deleteTag(id: string): Promise<void> {
    await this.json("DELETE", `/api/library/tags/${encodeURIComponent(id)}`);
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

  /** An attachment's bytes, as `GET /api/attachments/{id}/content` streams them. */
  attachmentContent(id: string): Promise<ArrayBuffer> {
    return this.bytes("GET", `/api/attachments/${encodeURIComponent(id)}/content`);
  }

  /** `POST /api/speech/transcribe`: transcribe an audio clip into text for the composer. */
  transcribeAudio(audioBytes: Uint8Array, mimeType = "audio/webm", filename?: string): Promise<{ text: string }> {
    const form = buildSpeechFormData(audioBytes, mimeType, filename);
    return this.json("POST", "/api/speech/transcribe", form);
  }

  // --- entitlements and org instructions -------------------------------------

  /** `GET /api/entitlements`: what this org's plan allows, any member may read it. */
  entitlements(): Promise<Entitlements> {
    return this.json("GET", "/api/entitlements");
  }

  /** `GET /api/org/instructions`: the org-level text; owner and admins only (403 otherwise). */
  orgInstructions(): Promise<OrgInstructions> {
    return this.json("GET", "/api/org/instructions");
  }

  /** `PUT /api/org/instructions`: replace the org-level text; owner and admins only. */
  setOrgInstructions(text: string): Promise<OrgInstructions> {
    return this.json("PUT", "/api/org/instructions", { text });
  }

  // --- import ----------------------------------------------------------------

  /** Start importing a ChatGPT or Claude export; the answer is the job row, status pending. */
  startImport(file: Blob, filename: string): Promise<ImportRecord> {
    const form = new FormData();
    form.append("file", file, filename);
    return this.json("POST", "/api/me/imports", form);
  }

  /** Where an import stands; another person's import is the same 404 as none. */
  importStatus(id: string): Promise<ImportRecord> {
    return this.json("GET", `/api/me/imports/${encodeURIComponent(id)}`);
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

  // --- /v1 (the coding agent's model calls) ---------------------------------

  /**
   * `POST /v1/chat/completions` with `stream: true`, one agent step: the
   * request's `messages` are the whole prompt (the caller owns the context),
   * `tools` go to the model, and `tool_calls` come back unexecuted. Never
   * retried -- a step the API may have metered must not be bought twice --
   * and a refusal before the stream (402, a 429 budget or rate limit, a 400)
   * throws as `ApiError` with OpenAI's `error.code`. An error object inside
   * the stream throws the same way; a body that ends without `[DONE]` throws
   * a `truncated` error, so a cut step is never taken for a finished one.
   */
  async *chatCompletionsStream(request: ChatCompletionRequest, signal?: AbortSignal): AsyncGenerator<ChatCompletionChunk> {
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "text/event-stream" };
    const token = await this.options.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    let response: Response;
    try {
      response = await this.observed(this.baseUrl + "/v1/chat/completions", {
        method: "POST",
        headers,
        body: JSON.stringify({ ...request, stream: true }),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ApiError(0, error instanceof Error ? error.message : "network error", null);
    }
    const requestId = response.headers.get("x-request-id");
    if (!response.ok) {
      const parsed: unknown = await response.json().catch(() => null);
      throw openAiError(response.status, parsed, requestId, parseRetryAfter(response.headers.get("retry-after")));
    }
    if (!response.body) throw new ApiError(0, "The stream ended before the answer finished.", requestId, null, "truncated");
    for await (const event of sseEvents(response.body)) {
      if (event.data === "[DONE]") return;
      let data: unknown;
      try {
        data = JSON.parse(event.data);
      } catch {
        continue;
      }
      if (data && typeof data === "object" && "error" in data) {
        const envelope = data as { error: unknown };
        throw openAiError(statusOfCode(envelope), envelope, requestId, null);
      }
      yield data as ChatCompletionChunk;
    }
    throw new ApiError(0, "The stream ended before the answer finished.", requestId, null, "truncated");
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
    const started = Date.now();
    const method = (init.method ?? "GET").toUpperCase();
    // The path alone: a query can carry what the person typed (a search).
    const path = new URL(input).pathname;
    let response: Response;
    try {
      response = await this.fetchImpl(input, init);
    } catch (error) {
      const aborted = Boolean(init.signal?.aborted);
      if (!aborted) this.options.onReachability?.(false);
      this.options.onRequest?.({
        method,
        path,
        status: null,
        requestId: null,
        ms: Date.now() - started,
        error: aborted ? "aborted" : error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    this.options.onReachability?.(true);
    const requestId = response.headers.get("x-request-id");
    if (requestId) this.options.onRequestId?.(requestId);
    this.options.onRequest?.({ method, path, status: response.status, requestId, ms: Date.now() - started, error: null });
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

  /** A GET whose answer is the body itself: attachment bytes, not JSON. */
  private async bytes(method: string, path: string): Promise<ArrayBuffer> {
    for (let attempt = 0; ; attempt++) {
      const response = await this.send(method, path, undefined);
      if (response.ok) return response.arrayBuffer();
      const parsed: unknown = await response.json().catch(() => null);
      const error = this.errorFrom(response, parsed);
      const retryable = response.status === 429 || [502, 503, 504].includes(response.status);
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

/**
 * An OpenAI-shaped refusal (`{"error": {"message", "type", "code"}}`) as this
 * extension's error type; a FastAPI `detail` body is read too, for a route
 * the envelope does not wrap.
 */
function openAiError(status: number, body: unknown, requestId: string | null, retryAfterS: number | null): ApiError {
  const error = body && typeof body === "object" && "error" in body ? (body as { error: unknown }).error : null;
  if (error && typeof error === "object") {
    const e = error as { message?: unknown; code?: unknown; type?: unknown };
    const code = typeof e.code === "string" ? e.code : typeof e.type === "string" ? e.type : null;
    return new ApiError(status, typeof e.message === "string" ? e.message : `HTTP ${status}`, requestId, retryAfterS, code);
  }
  return new ApiError(status, detailOf(body, `HTTP ${status}`), requestId, retryAfterS, codeOf(body));
}

/** The status an in-stream error stands for, from its code: the headers already said 200. */
function statusOfCode(envelope: { error: unknown }): number {
  const code = envelope.error && typeof envelope.error === "object" ? (envelope.error as { code?: unknown }).code : null;
  if (code === "insufficient_quota" || code === "rate_limit_exceeded") return 429;
  if (code === "context_length_exceeded" || code === "tool_calls_unsupported") return 400;
  return 502;
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
