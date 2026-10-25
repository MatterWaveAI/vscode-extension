import type * as vscode from "vscode";

/**
 * The one credential this extension holds, in the editor's SecretStorage
 * (the OS keychain where there is one). Both sign-in paths end in the same
 * place: a pasted `mw_` key and the key the device flow mints are the same
 * kind of bearer, so there is one slot and sign-out empties it.
 *
 * The slot remembers which path filled it. A key device login minted exists
 * for this editor alone, so sign-out revokes it on the server; a pasted key
 * is the person's own, used elsewhere too, and is only forgotten here.
 *
 * Keyed by base URL so pointing the setting at another deployment never
 * sends one deployment's key to the other.
 */

export interface StoredSession {
  token: string;
  /** True when device login minted the key for this editor. */
  minted: boolean;
}

export class TokenStore {
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly baseUrl: () => string,
  ) {}

  private key(): string {
    return `matterwave.token:${this.baseUrl().replace(/\/+$/, "")}`;
  }

  async session(): Promise<StoredSession | null> {
    const raw = await this.secrets.get(this.key());
    if (!raw) return null;
    // A slot written before the flag existed holds the bare key; it is
    // read as pasted, which is the choice that never revokes someone's key.
    if (!raw.startsWith("{")) return { token: raw, minted: false };
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && "token" in parsed && typeof parsed.token === "string") {
        return { token: parsed.token, minted: "minted" in parsed && parsed.minted === true };
      }
    } catch {
      // Not ours: treated as empty below.
    }
    return null;
  }

  async get(): Promise<string | null> {
    return (await this.session())?.token ?? null;
  }

  async set(token: string, minted = false): Promise<void> {
    await this.secrets.store(this.key(), JSON.stringify({ token, minted }));
    this.changed();
  }

  async clear(): Promise<void> {
    await this.secrets.delete(this.key());
    this.changed();
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}

/** A pasted key must look like one; the API is the judge of whether it works. */
export function looksLikeApiKey(value: string): boolean {
  return /^mw_[A-Za-z0-9_-]{8,}$/.test(value.trim());
}
