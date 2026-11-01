/**
 * The prompt library: named texts `/name` expands to in the composer.
 *
 * Kept in the editor rather than on the platform, so it survives restarts,
 * belongs to this person alone, and works offline. A prompt lives at one of
 * two scopes: every workspace (the editor's global state) or this workspace
 * alone (its workspace state) -- a project's own review checklist beside
 * the person's general ones. A workspace prompt shadows a global one of the
 * same name while that workspace is open. Each scope is one JSON value
 * under one key -- small by contract (50 prompts of 10k characters), and
 * one value keeps the writes atomic.
 */

export type PromptScope = "global" | "workspace";

export interface PromptRow {
  name: string;
  text: string;
  scope: PromptScope;
}

/** The slice of the editor's memento the library needs. */
export interface Memento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export const PROMPTS_KEY = "matterwave.prompts";

/** How many prompts each scope keeps, and how large one may be. */
export const MAX_PROMPTS = 50;
export const MAX_PROMPT_NAME = 40;
export const MAX_PROMPT_TEXT = 10_000;

/** The canonical form of a prompt's name: trimmed, leading slash off, lower case. */
export function normalizePromptName(name: string): string {
  return name.trim().replace(/^\//, "").toLowerCase();
}

export class PromptLibrary {
  /**
   * `workspace` is the open workspace's state, or null in a window with no
   * folder open, where only the global scope exists.
   */
  constructor(
    private readonly global: Memento,
    private readonly workspace: Memento | null = null,
  ) {}

  /** Whether prompts can be kept for this workspace alone. */
  get hasWorkspace(): boolean {
    return this.workspace !== null;
  }

  private state(scope: PromptScope): Memento | null {
    return scope === "workspace" ? this.workspace : this.global;
  }

  private read(scope: PromptScope): Record<string, string> {
    const rows = this.state(scope)?.get<Record<string, string>>(PROMPTS_KEY);
    return rows && typeof rows === "object" ? { ...rows } : {};
  }

  /** Every prompt, workspace ones first, each scope name-ordered, the way a picker lists them. */
  async list(): Promise<PromptRow[]> {
    const scoped = (scope: PromptScope): PromptRow[] => {
      const rows = this.read(scope);
      return Object.keys(rows)
        .sort()
        .map((name) => ({ name, text: rows[name] ?? "", scope }));
    };
    return [...(this.workspace ? scoped("workspace") : []), ...scoped("global")];
  }

  /** The text a `/name` expands to -- this workspace's prompt first -- or null when none is saved. */
  async get(name: string): Promise<string | null> {
    const normalized = normalizePromptName(name);
    return this.read("workspace")[normalized] ?? this.read("global")[normalized] ?? null;
  }

  /** Save (or replace) a prompt at a scope; false when a cap would be exceeded or the scope is not there. */
  async save(name: string, text: string, scope: PromptScope = "global"): Promise<boolean> {
    const state = this.state(scope);
    if (!state) return false;
    const normalized = normalizePromptName(name);
    if (!/^[a-z0-9_-]{1,40}$/.test(normalized) || normalized.length > MAX_PROMPT_NAME) return false;
    if (!text.trim() || text.length > MAX_PROMPT_TEXT) return false;
    const rows = this.read(scope);
    if (!(normalized in rows) && Object.keys(rows).length >= MAX_PROMPTS) return false;
    rows[normalized] = text;
    await state.update(PROMPTS_KEY, rows);
    return true;
  }

  async remove(name: string, scope: PromptScope = "global"): Promise<void> {
    const state = this.state(scope);
    if (!state) return;
    const rows = this.read(scope);
    delete rows[normalizePromptName(name)];
    await state.update(PROMPTS_KEY, rows);
  }
}
