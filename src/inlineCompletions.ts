import * as vscode from "vscode";
import type { FimCompletionRequest, FimCompletionResponse } from "./api/client";
import { DEFAULT_DENY, DenyList } from "./lib/sdk/agent/node";

export const DEFAULT_FIM_MAX_TOKENS = 128;
export const DEFAULT_FIM_STOP: readonly string[] = ["\n\n", "<|fim_pad|>"];
export const DEFAULT_FIM_DEBOUNCE_MS = 250;
export const MAX_PREFIX_CHARS = 4_000;
export const MAX_SUFFIX_CHARS = 1_000;

const DEFAULT_SECRET_DENY = new DenyList(DEFAULT_DENY);

export interface FimClientLike {
  fimComplete(request: FimCompletionRequest, signal?: AbortSignal): Promise<FimCompletionResponse>;
}

export interface InlineCompletionProviderOptions {
  client: FimClientLike;
  /** Returns whether `matterwave.inlineCompletions.enabled` is turned on. */
  isEnabled?: () => boolean;
  /** Returns whether the current workspace is trusted (`vscode.workspace.isTrusted`). */
  isTrusted?: () => boolean;
  /** Optional active model ID from the extension's picker. */
  getModel?: () => string | null;
  /** Debounce delay in milliseconds before firing `/v1/completions` (default 250ms). */
  debounceMs?: number;
  /** Optional custom path check for secret/denied files. */
  isDeniedPath?: (fsPath: string) => boolean;
}

/**
 * Pure helper extracting the bounded prefix and suffix window around `offset`.
 */
export function extractFimWindow(
  text: string,
  offset: number,
  maxPrefixChars = MAX_PREFIX_CHARS,
  maxSuffixChars = MAX_SUFFIX_CHARS,
): { prefix: string; suffix: string } {
  const clamped = Math.max(0, Math.min(offset, text.length));
  const prefixStart = Math.max(0, clamped - maxPrefixChars);
  const suffixEnd = Math.min(text.length, clamped + maxSuffixChars);
  return {
    prefix: text.slice(prefixStart, clamped),
    suffix: text.slice(clamped, suffixEnd),
  };
}

/**
 * Check whether a document path matches the standing secret deny-list (`.env*`, `*.pem`, `id_*`, `.git/`).
 */
export function isDeniedDocumentPath(fsPath: string): boolean {
  const normalized = fsPath.replace(/\\/g, "/");
  const baseName = normalized.split("/").pop() ?? normalized;
  return DEFAULT_SECRET_DENY.matches(normalized) || DEFAULT_SECRET_DENY.matches(baseName);
}

/**
 * Ghost-text `InlineCompletionItemProvider` backed by `POST /v1/completions` (FIM).
 *
 * Gated on `matterwave.inlineCompletions.enabled` (default `false`) and
 * `vscode.workspace.isTrusted` so untrusted workspaces and users who have not
 * opted in never send background completion requests.
 */
export class MatterWaveInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private readonly client: FimClientLike;
  private readonly isEnabled: () => boolean;
  private readonly isTrusted: () => boolean;
  private readonly getModel: () => string | null;
  private readonly debounceMs: number;
  private readonly isDeniedPath: (fsPath: string) => boolean;
  private activeAbort: AbortController | null = null;
  private requestSeq = 0;

  constructor(options: InlineCompletionProviderOptions) {
    this.client = options.client;
    this.isEnabled =
      options.isEnabled ??
      (() => vscode.workspace.getConfiguration("matterwave").get<boolean>("inlineCompletions.enabled") === true);
    this.isTrusted = options.isTrusted ?? (() => vscode.workspace.isTrusted);
    this.getModel = options.getModel ?? (() => null);
    this.debounceMs = options.debounceMs ?? DEFAULT_FIM_DEBOUNCE_MS;
    this.isDeniedPath = options.isDeniedPath ?? isDeniedDocumentPath;
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | null> {
    if (!this.isTrusted() || !this.isEnabled()) {
      return null;
    }
    if (token.isCancellationRequested) {
      return null;
    }
    if (document.uri.scheme !== "file" && document.uri.scheme !== "untitled") {
      return null;
    }
    if (this.isDeniedPath(document.uri.fsPath || document.uri.path)) {
      return null;
    }

    const fullText = document.getText();
    const offset = document.offsetAt(position);
    const { prefix, suffix } = extractFimWindow(fullText, offset);
    if (!prefix.trim()) {
      return null;
    }

    const seq = ++this.requestSeq;
    this.activeAbort?.abort();
    const controller = new AbortController();
    this.activeAbort = controller;

    const cancelSubscription =
      typeof token.onCancellationRequested === "function"
        ? token.onCancellationRequested(() => controller.abort())
        : { dispose() {} };

    try {
      if (this.debounceMs > 0) {
        const survived = await waitDebounce(this.debounceMs, controller.signal);
        if (!survived || token.isCancellationRequested || seq !== this.requestSeq) {
          return null;
        }
      }

      const model = this.getModel();
      const response = await this.client.fimComplete(
        {
          ...(model ? { model } : {}),
          prompt: prefix,
          suffix,
          max_tokens: DEFAULT_FIM_MAX_TOKENS,
          stop: [...DEFAULT_FIM_STOP],
        },
        controller.signal,
      );

      if (token.isCancellationRequested || controller.signal.aborted || seq !== this.requestSeq) {
        return null;
      }

      const text = response.choices?.[0]?.text ?? "";
      if (!text) {
        return null;
      }

      return [new vscode.InlineCompletionItem(text, new vscode.Range(position, position))];
    } catch {
      return null;
    } finally {
      cancelSubscription.dispose();
      if (this.activeAbort === controller) {
        this.activeAbort = null;
      }
    }
  }
}

function waitDebounce(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
