/**
 * The prompt library: named texts `/name` expands to in the composer.
 *
 * Kept in the editor's global state rather than on the platform, so it
 * survives restarts, belongs to this person alone, and works offline. The
 * whole library is one JSON value under one key -- it is small by contract
 * (50 prompts of 10k characters), and one value keeps the writes atomic.
 */

export interface PromptRow {
  name: string;
  text: string;
}

/** The slice of the editor's memento the library needs. */
export interface Memento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

const KEY = "matterwave.prompts";

/** How many prompts the library keeps, and how large one may be. */
export const MAX_PROMPTS = 50;
export const MAX_PROMPT_NAME = 40;
export const MAX_PROMPT_TEXT = 10_000;

/** The canonical form of a prompt's name: trimmed, leading slash off, lower case. */
export function normalizePromptName(name: string): string {
  return name.trim().replace(/^\//, "").toLowerCase();
}

export class PromptLibrary {
  constructor(private readonly state: Memento) {}

  private async read(): Promise<Record<string, string>> {
    const rows = this.state.get<Record<string, string>>(KEY);
    return rows && typeof rows === "object" ? rows : {};
  }

  /** Every prompt, name-ordered, the way a picker lists them. */
  async list(): Promise<PromptRow[]> {
    const rows = await this.read();
    return Object.keys(rows)
      .sort()
      .map((name) => ({ name, text: rows[name] ?? "" }));
  }

  /** The text a `/name` expands to, or null when none is saved. */
  async get(name: string): Promise<string | null> {
    const rows = await this.read();
    return rows[normalizePromptName(name)] ?? null;
  }

  /** Save (or replace) a prompt; false when a cap would be exceeded. */
  async save(name: string, text: string): Promise<boolean> {
    const normalized = normalizePromptName(name);
    if (!/^[a-z0-9_-]{1,40}$/.test(normalized) || normalized.length > MAX_PROMPT_NAME) return false;
    if (!text.trim() || text.length > MAX_PROMPT_TEXT) return false;
    const rows = await this.read();
    if (!(normalized in rows) && Object.keys(rows).length >= MAX_PROMPTS) return false;
    rows[normalized] = text;
    await this.state.update(KEY, rows);
    return true;
  }

  async remove(name: string): Promise<void> {
    const rows = await this.read();
    delete rows[normalizePromptName(name)];
    await this.state.update(KEY, rows);
  }
}
