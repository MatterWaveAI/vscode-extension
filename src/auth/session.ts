import type * as vscode from "vscode";

/**
 * The credentials this extension holds, in the editor's SecretStorage (the
 * OS keychain where there is one). Every sign-in ends in the same place: a
 * pasted `mw_` key and the key the device flow mints are the same kind of
 * bearer, so there is one store, and sign-out empties the acting slot.
 *
 * Several accounts can be kept side by side, the way the web app keeps
 * several on one browser: each entry is one account's key under the subject
 * it acts for, one of which is acting. Switching swaps which entry is
 * acting; it sends nobody's key anywhere. The platform's own account switch
 * is a cookie swap between browser sessions, which an editor holding
 * bearers cannot take part in -- so the parked accounts are this store's.
 *
 * The store remembers which path filled each entry. A key device login
 * minted exists for this editor alone, so sign-out revokes it on the
 * server; a pasted key is the person's own, used elsewhere too, and is only
 * forgotten here.
 *
 * Keyed by base URL so pointing the setting at another deployment never
 * sends one deployment's keys to the other.
 */

export interface StoredSession {
  token: string;
  /** True when device login minted the key for this editor. */
  minted: boolean;
}

/** One kept account: its key, who it acts for, and a name to show. */
export interface StoredAccount extends StoredSession {
  /** The account's subject (`me().subject`), or "" when it was never learned. */
  subject: string;
  /** Name or email for the switcher, when it was learned. */
  label: string | null;
}

/** Who a `set` is for, when the caller has just learned it. */
export interface AccountIdentity {
  subject: string;
  label: string | null;
}

/** The document as it is stored: one JSON value under the base URL's key. */
interface AccountsDoc {
  active: string;
  accounts: Record<string, StoredAccount>;
}

const EMPTY_DOC: AccountsDoc = { active: "", accounts: {} };

export class TokenStore {
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly baseUrl: () => string,
  ) {}

  private key(): string {
    return `matterwave.token:${this.baseUrl().replace(/\/+$/, "")}`;
  }

  /**
   * The stored document, whatever release wrote it: today's accounts map, a
   * single-slot `{token, minted}`, or a bare key from before either. All
   * three read as one entry; only the shapes differ.
   */
  private async read(): Promise<AccountsDoc> {
    const raw = await this.secrets.get(this.key());
    if (!raw) return { ...EMPTY_DOC, accounts: {} };
    if (!raw.startsWith("{")) {
      return { active: "", accounts: { "": { subject: "", label: null, token: raw, minted: false } } };
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && "accounts" in parsed) {
        const doc = parsed as Partial<AccountsDoc>;
        if (typeof doc.active === "string" && doc.accounts && typeof doc.accounts === "object") {
          const accounts: Record<string, StoredAccount> = {};
          for (const [subject, entry] of Object.entries(doc.accounts)) {
            if (
              entry &&
              typeof entry === "object" &&
              typeof (entry as StoredAccount).token === "string" &&
              typeof (entry as StoredAccount).subject === "string"
            ) {
              const account = entry as StoredAccount;
              accounts[subject] = {
                subject,
                token: account.token,
                minted: account.minted === true,
                label: typeof account.label === "string" ? account.label : null,
              };
            }
          }
          return { active: doc.accounts[doc.active] ? doc.active : "", accounts };
        }
      }
      if (parsed && typeof parsed === "object" && "token" in parsed) {
        const slot = parsed as { token: unknown; minted: unknown };
        if (typeof slot.token === "string") {
          return {
            active: "",
            accounts: { "": { subject: "", label: null, token: slot.token, minted: slot.minted === true } },
          };
        }
      }
    } catch {
      // Not ours: treated as empty below.
    }
    return { ...EMPTY_DOC, accounts: {} };
  }

  private async write(doc: AccountsDoc): Promise<void> {
    await this.secrets.store(this.key(), JSON.stringify(doc));
    this.changed();
  }

  /** The acting account's credential, or null when signed out. */
  async session(): Promise<StoredSession | null> {
    const doc = await this.read();
    const active = doc.accounts[doc.active];
    return active ? { token: active.token, minted: active.minted } : null;
  }

  async get(): Promise<string | null> {
    return (await this.session())?.token ?? null;
  }

  /**
   * Store a credential and make it the acting one. `identity` names the
   * account it acts for, so the switcher can list it; without one it
   * updates whatever entry is acting now.
   */
  async set(token: string, minted = false, identity?: AccountIdentity): Promise<void> {
    const doc = await this.read();
    const subject = identity?.subject ?? doc.active;
    const known = doc.accounts[subject];
    doc.accounts[subject] = {
      subject,
      token,
      minted,
      label: identity?.label ?? known?.label ?? null,
    };
    // A named sign-in supersedes the anonymous slot an older release kept:
    // one key acting is the story from here.
    if (identity && subject !== "") delete doc.accounts[""];
    doc.active = subject;
    await this.write(doc);
  }

  /** Forget the acting account's key. Others stay parked for the switcher. */
  async clear(): Promise<void> {
    const doc = await this.read();
    if (!doc.accounts[doc.active]) return;
    delete doc.accounts[doc.active];
    doc.active = "";
    await this.write(doc);
  }

  /** Every kept account, the acting one first, then by name. */
  async list(): Promise<(StoredAccount & { active: boolean })[]> {
    const doc = await this.read();
    return Object.values(doc.accounts)
      .map((account) => ({ ...account, active: account.subject === doc.active }))
      .sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        const labelOf = (account: StoredAccount) => account.label || account.subject;
        return labelOf(a).localeCompare(labelOf(b));
      });
  }

  /** Make a parked account the acting one; false when nothing is kept for it. */
  async setActive(subject: string): Promise<boolean> {
    const doc = await this.read();
    if (!doc.accounts[subject]) return false;
    doc.active = subject;
    await this.write(doc);
    return true;
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
