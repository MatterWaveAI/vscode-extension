import type { ConversationFrame } from "../lib/matterwaveClient";
import type { MatterWaveClient } from "../api/client";
import { ApiError } from "../api/errors";
import { isUntrustedCertificate } from "../api/transport";
import type { Conversation, ConversationInstructions, FeedbackReason, Message, ModelInfo } from "../api/types";
import { fileAttachment } from "../context";
import { initialModel } from "../models";
import { classifyStreamError, STREAM_ERROR_COPY, type StreamErrorKind } from "../streamErrors";
import { appendDelta, deltaText, emptyAssistant, partFromStart, setPart } from "./assemble";
import { switchTarget, transcriptOf } from "./branches";
import type {
  ConversationSummary,
  ErrorView,
  FeedbackSummary,
  HostMessage,
  InstructionsView,
  Meter,
  SearchHitView,
  ViewState,
  WebviewMessage,
} from "./protocol";

/**
 * The chat's state and every request it makes, with no editor API in it.
 *
 * The view provider forwards webview intents here and posts back whatever
 * this emits; the commands call the same methods. Keeping it editor-free is
 * what lets the tests drive a whole turn over a fake `fetch` and inspect
 * every message that would have crossed into the webview.
 */

export interface StatusInfo {
  signedIn: boolean;
  offline: boolean;
  identity: string | null;
  model: string | null;
  /** 0-100, or null when the server does not know the count or the window. */
  meterPercent: number | null;
}

export interface ChatDeps {
  client: MatterWaveClient;
  post: (message: HostMessage) => void;
  isSignedIn: () => Promise<boolean>;
  rememberedModel: { get(): string | null; set(id: string): void };
  /** Editor-side actions the webview can ask for: the model QuickPick, sign-in, the clipboard, saving and sharing. */
  runCommand: (
    command: "pickModel" | "signIn" | "copyRequestId" | "exportConversation" | "shareConversation",
  ) => void;
  onStatus?: (status: StatusInfo) => void;
}

/** What the Continue button sends after a cut answer. */
export const CONTINUE_PROMPT = "Continue from where you stopped.";

/** Shown while the open conversation is temporary, next to the hidden Share button. */
export const TEMPORARY_CHAT_NOTICE =
  "Temporary chat. It won't appear in your history or search, can't be shared, and is deleted 24 hours after the last message.";

/** The notice when a plan-gated feature refuses with 402. */
export const INSTRUCTIONS_UPGRADE_NOTICE =
  "Custom instructions are not part of your plan. Upgrade the plan to use them.";

interface FailedTurn {
  content: string;
  attachmentIds: string[];
  userMessageId: string | null;
  /** Remembered so a retry of the very first send creates the same kind of chat. */
  temporary: boolean;
}

export class ChatController {
  private signedIn = false;
  private offline = false;
  private identity: string | null = null;
  private conversations: Conversation[] = [];
  private archived: Conversation[] = [];
  /** Non-null while the sidebar's search box holds a query. */
  private searchResults: (Conversation & { snippet: string })[] | null = null;
  private activeId: string | null = null;
  private path: Message[] = [];
  private tree: Message[] = [];
  private live: Message | null = null;
  private models: ModelInfo[] = [];
  private model: ModelInfo | null = null;
  private meter: Meter | null = null;
  private error: ErrorView | null = null;
  private notice: string | null = null;
  /** True while the open conversation is temporary: fixed at its creation. */
  private temporary = false;
  private instructions: InstructionsView | null = null;
  private feedback = new Map<string, FeedbackSummary>();
  private abort: AbortController | null = null;
  private failed: FailedTurn | null = null;
  private reloadAfterTurn = false;
  lastRequestId: string | null = null;

  constructor(private readonly deps: ChatDeps) {}

  // --- intents from the webview --------------------------------------------

  async handle(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case "ready":
      case "reconnect":
        return this.refresh();
      case "newChat":
        return this.newChat();
      case "openConversation":
        return this.openConversation(message.id);
      case "searchConversations":
        return this.searchConversations(message.query);
      case "renameConversation":
        return this.renameConversation(message.id, message.title);
      case "deleteConversation":
        return this.deleteConversation(message.id);
      case "pinConversation":
        return this.pinConversation(message.id, message.pinned);
      case "archiveConversation":
        return this.archiveConversation(message.id, message.archived);
      case "exportConversation":
      case "shareConversation":
        this.deps.runCommand(message.type);
        return;
      case "send":
        return this.send(message.content, [], message.temporary === true);
      case "stop":
        this.abort?.abort();
        return;
      case "retry":
        return this.retry();
      case "edit":
        return this.edit(message.messageId, message.content);
      case "regenerate":
        return this.regenerate(message.messageId);
      case "rateMessage":
        return this.rateMessage(message.messageId, message.rating, message.reasons, message.comment);
      case "setInstructions":
        return this.setInstructions(message.text);
      case "switchBranch":
        return this.switchBranch(message.messageId, message.step);
      case "continue":
        return this.send(CONTINUE_PROMPT);
      case "compact":
        return this.compact();
      case "pickModel":
      case "signIn":
      case "copyRequestId":
        this.deps.runCommand(message.type);
        return;
    }
  }

  // --- loading ---------------------------------------------------------------

  async refresh(): Promise<void> {
    this.signedIn = await this.deps.isSignedIn();
    // A re-read answers the error it is about to retry (the API could not be
    // reached, the list did not load); one that holds a turn to send again
    // stays, since its Retry is how that text gets through.
    if (!this.failed) this.error = null;
    if (!this.signedIn) {
      this.identity = null;
      this.conversations = [];
      this.archived = [];
      this.searchResults = null;
      this.activeId = null;
      this.path = [];
      this.tree = [];
      this.meter = null;
      this.temporary = false;
      this.instructions = null;
      this.feedback = new Map();
      this.emit();
      return;
    }
    await this.guard(async () => {
      const [me, models, conversations, archived] = await Promise.all([
        this.deps.client.me(),
        this.deps.client.models(),
        this.deps.client.listConversations(),
        this.deps.client.listArchivedConversations(),
      ]);
      this.identity = me.name || me.email || me.subject;
      this.models = models.data;
      this.model = initialModel(models.data, this.deps.rememberedModel.get(), models.default_model);
      // A temporary conversation is in no list, whatever a deployment's rows
      // say: it would be gone within a day anyway.
      this.conversations = conversations.filter(notTemporary);
      this.archived = archived.filter(notTemporary);
      if (this.activeId) await this.loadConversation(this.activeId);
    });
    this.emit();
  }

  async openConversation(id: string): Promise<void> {
    // A turn still streaming belongs to the conversation being left: stop it
    // (the server keeps what arrived as a cut answer) and let go of it, so
    // none of its frames land in the one being opened.
    if (id !== this.activeId) this.detachTurn();
    this.activeId = id;
    this.error = null;
    this.notice = null;
    await this.guard(() => this.loadConversation(id));
    this.emit();
  }

  newChat(): void {
    this.detachTurn();
    this.activeId = null;
    this.path = [];
    this.tree = [];
    this.live = null;
    this.meter = null;
    this.error = null;
    this.notice = null;
    this.temporary = false;
    this.instructions = null;
    this.feedback = new Map();
    this.searchResults = null;
    this.emit();
  }

  private detachTurn(): void {
    this.abort?.abort();
    this.abort = null;
    this.live = null;
  }

  private async loadConversation(id: string): Promise<void> {
    const [detail, tree] = await Promise.all([this.deps.client.getConversation(id), this.deps.client.tree(id)]);
    if (this.activeId !== id) return;
    this.path = detail.messages;
    this.tree = tree;
    // A deployment that does not echo the flag leaves what creation said; one
    // that does is authoritative.
    if (detail.temporary !== undefined && detail.temporary !== null) this.temporary = detail.temporary === true;
    this.instructions = instructionsViewOf(detail.instructions);
    await Promise.all([this.loadMeter(id), this.loadFeedback(id)]);
  }

  private async loadMeter(id: string): Promise<void> {
    try {
      const usage = await this.deps.client.context(id, this.model?.id);
      this.meter = { usedTokens: usage.used_tokens, contextWindow: usage.context_window, compactable: usage.compactable };
    } catch {
      // A deployment without the context route still chats; the meter just
      // stays blank rather than turning the whole view into an error.
      this.meter = null;
    }
  }

  // --- sidebar management ----------------------------------------------------

  activeConversationId(): string | null {
    return this.activeId;
  }

  /** The sidebar's search. An empty query leaves search mode for the list. */
  async searchConversations(query: string): Promise<void> {
    const q = query.trim();
    if (!q) {
      this.searchResults = null;
      this.emit();
      return;
    }
    await this.guard(async () => {
      // The server keeps temporary conversations out of search; the filter
      // holds if a row ever leaks through.
      this.searchResults = (await this.deps.client.searchConversations(q)).filter(notTemporary);
    });
    this.emit();
  }

  async renameConversation(id: string, title: string): Promise<void> {
    const trimmed = title.trim();
    if (!trimmed) return;
    await this.guard(async () => {
      const updated = await this.deps.client.updateConversation(id, { title: trimmed });
      this.replaceRow(updated);
    });
    this.emit();
  }

  async deleteConversation(id: string): Promise<void> {
    await this.guard(async () => {
      await this.deps.client.deleteConversation(id);
      this.conversations = this.conversations.filter((c) => c.id !== id);
      this.archived = this.archived.filter((c) => c.id !== id);
      this.searchResults = this.searchResults?.filter((c) => c.id !== id) ?? null;
      // The record is gone; the open view would only be a 404 on the next turn.
      if (this.activeId === id) this.newChat();
    });
    this.emit();
  }

  async pinConversation(id: string, pinned: boolean): Promise<void> {
    await this.guard(async () => {
      try {
        const updated = await this.deps.client.pinConversation(id, pinned);
        this.replaceRow(updated);
      } catch (error) {
        if (!this.surfaceConflictNotice(error)) throw error;
      }
    });
    this.emit();
  }

  async archiveConversation(id: string, archived: boolean): Promise<void> {
    await this.guard(async () => {
      try {
        const updated = await this.deps.client.archiveConversation(id, archived);
        this.replaceRow(updated);
        // Archiving the open conversation closes it: it has left the list the
        // sidebar opens from, exactly as in the web app.
        if (archived && this.activeId === id) this.newChat();
      } catch (error) {
        if (!this.surfaceConflictNotice(error)) throw error;
      }
    });
    this.emit();
  }

  /**
   * A temporary conversation refuses pin and fork (and share, in the host
   * command) with a 409 whose `detail` is the sentence written for people:
   * shown as a notice rather than dressed up as a failure.
   */
  private surfaceConflictNotice(error: unknown): boolean {
    if (error instanceof ApiError && error.status === 409) {
      this.notice = error.detail;
      return true;
    }
    return false;
  }

  /** A row moved between lists (or re-sorted) comes back from the API as a whole row. */
  private replaceRow(updated: Conversation): void {
    this.conversations = this.conversations.filter((c) => c.id !== updated.id);
    this.archived = this.archived.filter((c) => c.id !== updated.id);
    if (updated.archived_at) this.archived.push(updated);
    else this.conversations.push(updated);
    this.sortRows(this.conversations);
    this.sortRows(this.archived);
    if (this.searchResults) {
      this.searchResults = this.searchResults.map((hit) => (hit.id === updated.id ? { ...updated, snippet: hit.snippet } : hit));
    }
  }

  /** The server's sidebar order: pinned first, then as sent (newest activity first). */
  private sortRows(rows: Conversation[]): void {
    rows.sort((a, b) => Number(Boolean(b.pinned_at)) - Number(Boolean(a.pinned_at)));
  }

  /**
   * Thumbs on a reply, over the full feedback contract: a thumbs-down may
   * carry the picker's reasons and comment, a re-vote replaces, and 0
   * withdraws. The map is the record the thumbs render; the webview holds an
   * optimistic copy until the next state post.
   */
  async rateMessage(
    messageId: string,
    rating: -1 | 0 | 1,
    reasons?: FeedbackReason[],
    comment?: string | null,
  ): Promise<void> {
    try {
      if (rating === 0) {
        await this.deps.client.deleteFeedback(messageId);
        this.feedback.delete(messageId);
      } else {
        await this.deps.client.setFeedback(messageId, {
          rating,
          ...(reasons?.length ? { reasons } : {}),
          ...(comment !== undefined ? { comment } : {}),
        });
        this.feedback.set(messageId, { rating, reasons: reasons ?? [], comment: comment ?? null });
      }
    } catch (error) {
      // A thumbs click that failed is told through the error banner; a click
      // that worked needs none.
      this.fail(error);
    }
    this.emit();
  }

  /** The caller's own rows, read back so the thumbs survive closing the editor. */
  private async loadFeedback(id: string): Promise<void> {
    try {
      const rows = await this.deps.client.conversationFeedback(id);
      if (this.activeId !== id) return;
      this.feedback = new Map(
        rows.data.map((row) => [row.message_id, { rating: row.rating, reasons: row.reasons ?? [], comment: row.comment ?? null }]),
      );
    } catch {
      // A deployment without the route still chats; the thumbs just start blank.
      this.feedback = new Map();
    }
  }

  /**
   * Set the open conversation's own instructions; `null` is "use my
   * instructions". The answer carries the effective layers, which is what
   * the badge reads.
   */
  async setInstructions(text: string | null): Promise<void> {
    if (!this.activeId || this.abort) return;
    const id = this.activeId;
    try {
      const saved = await this.deps.client.setConversationInstructions(id, text);
      if (this.activeId === id) this.instructions = instructionsViewOf(saved);
    } catch (error) {
      if (error instanceof ApiError && error.status === 402) {
        this.notice = INSTRUCTIONS_UPGRADE_NOTICE;
      } else {
        this.fail(error);
      }
    }
    this.emit();
  }

  // --- turns -----------------------------------------------------------------

  async send(content: string, attachmentIds: string[] = [], temporary = false): Promise<void> {
    if (this.abort) return;
    const id = await this.ensureConversation(temporary);
    if (!id) {
      // The composer has already let the text go; when the conversation
      // could not be made, Retry is the one place it is still held.
      if (this.error) this.failed = { content, attachmentIds, userMessageId: null, temporary };
      return;
    }
    const parent = this.path[this.path.length - 1] ?? null;
    const optimistic: Message = {
      ...emptyAssistant(id, parent?.id ?? null),
      role: "user",
      parts: [{ type: "text", text: content }],
      content,
    };
    this.path = [...this.path, optimistic];
    const body = { content, ...(this.model ? { model: this.model.id } : {}), ...(attachmentIds.length ? { attachment_ids: attachmentIds } : {}) };
    await this.runTurn(id, (signal) => this.deps.client.sendMessage(id, body, signal), { content, attachmentIds, userMessageId: null, temporary });
  }

  async edit(messageId: string, content: string): Promise<void> {
    if (this.abort || !this.activeId) return;
    const id = this.activeId;
    const body = { content, ...(this.model ? { model: this.model.id } : {}) };
    await this.runTurn(id, (signal) => this.deps.client.editMessage(id, messageId, body, signal), { content, attachmentIds: [], userMessageId: messageId, temporary: this.temporary });
  }

  async regenerate(messageId: string): Promise<void> {
    if (this.abort || !this.activeId) return;
    const id = this.activeId;
    const body = this.model ? { model: this.model.id } : {};
    const at = this.path.findIndex((m) => m.id === messageId);
    if (at >= 0) this.path = this.path.slice(0, at);
    await this.runTurn(id, (signal) => this.deps.client.regenerate(id, messageId, body, signal), null);
  }

  /** Try a failed turn again in the cheapest way that cannot double-post it. */
  async retry(): Promise<void> {
    const failed = this.failed;
    if (!failed) return;
    // No conversation yet: nothing reached the server, so the first send is the retry.
    if (!this.activeId) return this.send(failed.content, failed.attachmentIds, failed.temporary);
    await this.guard(() => this.loadConversation(this.activeId ?? ""));
    const last = this.path[this.path.length - 1];
    if (last?.role === "assistant") return this.regenerate(last.id);
    if (failed.userMessageId) return this.edit(failed.userMessageId, failed.content);
    return this.send(failed.content, failed.attachmentIds, failed.temporary);
  }

  /**
   * "Ask about file": upload the text, then send the question with the attachment.
   *
   * Images go the same road with their own bytes and content type, for the
   * models that can see them; the API decides an upload's type from the
   * bytes, so the shape the conversation records is the file's own.
   */
  async askAboutFile(question: string, text: string, path: string): Promise<void> {
    const id = await this.ensureConversation();
    if (!id) return;
    const { blob, filename } = fileAttachment(text, path);
    let attachmentId: string;
    try {
      const attachment = await this.deps.client.uploadAttachment(blob, filename, id);
      attachmentId = attachment.id;
      this.notice = attachment.extract_truncated
        ? `${path} is longer than the model reads from one file: only its start was sent.`
        : null;
    } catch (error) {
      this.fail(error);
      this.emit();
      return;
    }
    await this.send(question, [attachmentId]);
  }

  /** Upload `attachment` into the conversation, then send `question` about it. */
  async sendAttachment(question: string, attachment: { blob: Blob; filename: string }): Promise<void> {
    // Before anything is sent: a model the API says cannot see images gets a
    // refusal that names what to pick instead, not a 422 after the upload.
    const refusal = this.visionRefusal();
    if (refusal) {
      this.notice = refusal;
      this.emit();
      return;
    }
    const id = await this.ensureConversation();
    if (!id) return;
    let attachmentId: string;
    try {
      const saved = await this.deps.client.uploadAttachment(attachment.blob, attachment.filename, id);
      attachmentId = saved.id;
    } catch (error) {
      this.fail(error);
      this.emit();
      return;
    }
    await this.send(question, [attachmentId]);
  }

  /**
   * The refusal for sending an image to a model with `supports_vision:
   * false`, naming up to three vision-capable models. `null` (allowed) and
   * an unknown model pass: the server's own 422 stays the backstop.
   */
  private visionRefusal(): string | null {
    const model = this.model;
    if (!model || model.supports_vision !== false) return null;
    const capable = this.models
      .filter((m) => m.supports_vision === true)
      .slice(0, 3)
      .map((m) => m.label || m.id);
    const label = model.label || model.id;
    return capable.length > 0
      ? `${label} cannot see images. Pick a vision-capable model (for example ${capable.join(", ")}) to send one.`
      : `${label} cannot see images, and no vision-capable model is available.`;
  }

  private async ensureConversation(temporary = false): Promise<string | null> {
    if (this.activeId) return this.activeId;
    if (!this.signedIn) {
      this.deps.runCommand("signIn");
      return null;
    }
    try {
      const conv = await this.deps.client.createConversation({
        ...(this.model ? { model: this.model.id } : {}),
        ...(temporary ? { temporary: true } : {}),
      });
      this.temporary = temporary;
      // A temporary conversation appears in no list, so it never joins the sidebar.
      if (!temporary) this.conversations = [conv, ...this.conversations];
      this.activeId = conv.id;
      this.path = [];
      this.tree = [];
      this.instructions = null;
      this.feedback = new Map();
      return conv.id;
    } catch (error) {
      this.fail(error);
      this.emit();
      return null;
    }
  }

  private async runTurn(
    conversationId: string,
    start: (signal: AbortSignal) => AsyncGenerator<ConversationFrame>,
    retryable: FailedTurn | null,
  ): Promise<void> {
    const abort = new AbortController();
    this.abort = abort;
    this.error = null;
    this.failed = null;
    this.reloadAfterTurn = false;
    const parent = this.path[this.path.length - 1] ?? null;
    this.live = emptyAssistant(conversationId, parent?.id ?? null);
    let userMessageId = retryable?.userMessageId ?? null;
    // False once the user has moved to another conversation: from then on
    // the turn's frames, errors and reloads are dropped.
    const attached = () => this.abort === abort && this.activeId === conversationId;
    this.emit();
    try {
      for await (const frame of start(abort.signal)) {
        if (!attached()) break;
        const result = this.applyFrame(conversationId, frame);
        if (frame.event === "message" && typeof frame.message.id === "string") userMessageId = frame.message.id;
        if (result === "failed" && retryable) this.failed = { ...retryable, userMessageId };
      }
    } catch (error) {
      if (!attached()) {
        // Detached: the conversation now open has nothing to do with this turn.
      } else if (abort.signal.aborted) {
        this.notice = "Stopped. Whatever arrived is kept; the server saves it as a cut answer.";
      } else {
        this.fail(error);
        if (retryable) this.failed = { ...retryable, userMessageId };
      }
      if (attached()) this.keepPartial();
    } finally {
      if (this.abort === abort) this.abort = null;
    }
    if (!attached() && this.abort !== null) return;
    if (this.activeId !== conversationId) return;
    // The server is the record: the tree (sibling counts), the meter, and --
    // after a failure or a compaction -- the transcript itself are re-read.
    await this.guard(async () => {
      if (this.activeId !== conversationId) return;
      if (this.error || this.reloadAfterTurn || abort.signal.aborted) {
        await this.loadConversation(conversationId);
      } else {
        this.tree = await this.deps.client.tree(conversationId);
        await this.loadMeter(conversationId);
      }
    });
    this.emit();
  }

  /** One frame's effect. Returns "failed" for a frame that ends the turn in error. */
  private applyFrame(conversationId: string, frame: ConversationFrame): "ok" | "failed" {
    switch (frame.event) {
      case "message": {
        const message = frame.message as Message;
        const own = this.path.findIndex((m) => m.id === message.id);
        if (own >= 0) {
          this.path = this.path.slice(0, own + 1);
        } else {
          const withoutOptimistic = this.path.filter((m) => m.id !== "");
          const parentAt = withoutOptimistic.findIndex((m) => m.id === message.parent_id);
          this.path = [...withoutOptimistic.slice(0, parentAt + 1), message];
        }
        this.live = emptyAssistant(conversationId, message.id);
        this.emit();
        return "ok";
      }
      case "title": {
        if (frame.title) this.conversations = this.conversations.map((c) => (c.id === conversationId ? { ...c, title: frame.title } : c));
        this.emit();
        return "ok";
      }
      case "part_start": {
        if (!this.live) return "ok";
        const part = partFromStart(frame);
        setPart(this.live, frame.index, part);
        this.deps.post({ type: "part", index: frame.index, part });
        return "ok";
      }
      case "delta": {
        if (!this.live) return "ok";
        const text = deltaText(frame);
        if (!text) return "ok";
        appendDelta(this.live, frame.index, text);
        this.deps.post({ type: "delta", index: frame.index, field: "text", text });
        return "ok";
      }
      case "context": {
        const prompt = frame.prompt_tokens;
        this.meter = {
          usedTokens: prompt === null ? null : prompt + (frame.completion_tokens ?? 0),
          contextWindow: frame.context_window ?? this.meter?.contextWindow ?? null,
          compactable: this.meter?.compactable ?? true,
        };
        this.emit();
        return "ok";
      }
      case "compaction": {
        // The SDK reads a missing count as 0; a summary of nothing is not a thing, so 0 means unknown.
        const { tokens_before: before, tokens_after: after } = frame;
        this.notice =
          before > 0
            ? `Earlier turns were summarised to fit the context window (${before.toLocaleString()} → ${after.toLocaleString()} tokens).`
            : "Earlier turns were summarised to fit the context window.";
        this.reloadAfterTurn = true;
        this.emit();
        return "ok";
      }
      case "notice": {
        // The API puts a notice's text in `detail`, like its errors.
        if (frame.detail) this.notice = frame.detail;
        this.emit();
        return "ok";
      }
      case "done": {
        const message = frame.message as Message;
        this.path = [...this.path.filter((m) => m.id !== ""), message];
        this.live = null;
        this.emit();
        return "ok";
      }
      case "moderation_block": {
        const requestId = frame.request_id ?? this.lastRequestId;
        if (requestId) this.lastRequestId = requestId;
        this.error = errorView("moderation", requestId);
        this.path = this.path.filter((m) => m.id !== "");
        this.live = null;
        this.emit();
        return "failed";
      }
      case "error": {
        this.error = errorView(classifyStreamError(frame.detail, undefined, frame.code ?? undefined), this.lastRequestId);
        this.keepPartial();
        this.emit();
        return "failed";
      }
      default:
        return "ok";
    }
  }

  /** A cut answer stays on screen, marked as cut, until the server's copy replaces it. */
  private keepPartial(): void {
    if (this.live && this.live.parts.length > 0) this.path = [...this.path, { ...this.live, truncated: true }];
    this.live = null;
  }

  // --- branches, compaction, model ----------------------------------------------

  async switchBranch(messageId: string, step: -1 | 1): Promise<void> {
    if (!this.activeId || this.abort) return;
    const leaf = switchTarget(this.tree, messageId, step);
    if (!leaf) return;
    const id = this.activeId;
    await this.guard(async () => {
      const detail = await this.deps.client.setActiveLeaf(id, leaf);
      if (this.activeId === id) this.path = detail.messages;
    });
    this.emit();
  }

  async compact(): Promise<void> {
    if (!this.activeId || this.abort) return;
    const id = this.activeId;
    try {
      await this.deps.client.compact(id, this.model?.id);
      this.notice = "Earlier turns were summarised. Use Show originals on the divider to read them.";
      await this.loadConversation(id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        this.notice = "Nothing to compact yet: the conversation is short enough as it is.";
      } else {
        this.fail(error);
      }
    }
    this.emit();
  }

  availableModels(): readonly ModelInfo[] {
    return this.models;
  }

  currentModel(): ModelInfo | null {
    return this.model;
  }

  async loadModels(): Promise<readonly ModelInfo[]> {
    const list = await this.deps.client.models();
    this.models = list.data;
    if (!this.model) this.model = initialModel(list.data, this.deps.rememberedModel.get(), list.default_model);
    return this.models;
  }

  /**
   * Only an included model is accepted; the picker never offers another, and this holds if it did.
   *
   * The pick is remembered twice: in the editor (the model every new
   * conversation starts with) and, when a conversation is open, on the
   * conversation itself (`default_model`), so the web app's next turn in it
   * uses the same model. The conversation write is best-effort: a deployment
   * without the route, or briefly offline, still chats -- every turn names
   * its model anyway.
   */
  setModel(model: ModelInfo): boolean {
    if (!model.included) return false;
    this.model = model;
    this.deps.rememberedModel.set(model.id);
    const conversationId = this.activeId;
    if (conversationId) {
      void this.deps.client.updateConversation(conversationId, { default_model: model.id }).catch(() => {
        /* the conversation keeps its previous default; the next turn still sends this one */
      });
    }
    this.emit();
    return true;
  }

  setOffline(offline: boolean): void {
    if (this.offline === offline) return;
    this.offline = offline;
    this.emit();
  }

  hasConversation(): boolean {
    return this.activeId !== null;
  }

  // --- plumbing ------------------------------------------------------------------

  private async guard(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    if (error instanceof ApiError) {
      if (error.requestId) this.lastRequestId = error.requestId;
      const kind =
        error.status === 0
          ? isUntrustedCertificate(error.detail)
            ? "untrusted_certificate"
            : "network"
          : classifyStreamError(error.detail, error.status, error.code ?? undefined);
      this.error = errorView(kind, error.requestId);
    } else {
      this.error = errorView("unknown", null);
    }
  }

  snapshot(): ViewState {
    return {
      signedIn: this.signedIn,
      offline: this.offline,
      identity: this.identity,
      conversations: this.conversations.map(conversationSummary),
      archivedConversations: this.archived.map(conversationSummary),
      searchResults: this.searchResults?.map((hit): SearchHitView => ({ ...conversationSummary(hit), snippet: hit.snippet })) ?? null,
      activeId: this.activeId,
      transcript: transcriptOf(this.path, this.tree),
      live: this.live,
      model: this.model ? { id: this.model.id, label: this.model.label || this.model.id } : null,
      meter: this.meter,
      streaming: this.abort !== null,
      error: this.error,
      notice: this.notice,
      temporary: this.temporary,
      instructions: this.instructions,
      feedback: Object.fromEntries(this.feedback),
    };
  }

  emit(): void {
    const state = this.snapshot();
    this.deps.post({ type: "state", state });
    this.deps.onStatus?.({
      signedIn: state.signedIn,
      offline: state.offline,
      identity: state.identity,
      model: state.model?.label ?? null,
      meterPercent: meterPercent(state.meter),
    });
  }
}

export function meterPercent(meter: Meter | null): number | null {
  if (!meter || meter.usedTokens === null || !meter.contextWindow) return null;
  return Math.min(100, Math.round((meter.usedTokens / meter.contextWindow) * 100));
}

/** What the sidebar needs from a row; `pinned_at`/`archived_at` read as flags. */
function conversationSummary(c: Conversation): ConversationSummary {
  return { id: c.id, title: c.title, pinned: Boolean(c.pinned_at), archived: Boolean(c.archived_at) };
}

/** A temporary conversation is in no list and no search, whatever a row says. */
function notTemporary(c: Conversation): boolean {
  return c.temporary !== true;
}

/** The API's instruction layers as the view reads them; null when there are none. */
function instructionsViewOf(raw: ConversationInstructions | null | undefined): InstructionsView | null {
  if (!raw) return null;
  return {
    conversation: raw.conversation ?? null,
    effective: raw.effective ?? null,
    overridden: raw.user_overridden === true,
  };
}

function errorView(kind: StreamErrorKind, requestId: string | null): ErrorView {
  return { ...STREAM_ERROR_COPY[kind], requestId };
}

