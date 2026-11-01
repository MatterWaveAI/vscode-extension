import type { Memento } from "./promptLibrary";

/**
 * Checkpoints: the contents a file had before each apply, kept so an
 * applied edit is never beyond taking back.
 *
 * One row per apply, named by the conversation it came from (the chat's own
 * restore list) and kept in the editor's global state -- the same place the
 * prompt library lives, written as one value so a save is atomic. Large
 * files are refused rather than half-snapshotted: a checkpoint that would
 * not restore faithfully is not a checkpoint.
 */

export interface Checkpoint {
  id: string;
  /** The chat the apply happened from; null when none was open. */
  conversationId: string | null;
  /**
   * The file's full URI -- its folder in a multi-root workspace, its host in
   * a remote one -- which is what a restore writes to. Absent only on rows
   * an older release kept by their relative path alone.
   */
  uri?: string;
  /** Workspace-relative path of the file, as the restore list shows it. */
  path: string;
  /** The file's contents before the apply; null when the file was new. */
  content: string | null;
  createdAt: string;
  /** What took the checkpoint: "Apply" or "Inline edit". */
  label: string;
}

const KEY = "matterwave.checkpoints";

/** How many checkpoints one chat keeps (oldest dropped first), and the cap on any one snapshot. */
export const MAX_CHECKPOINTS_PER_CHAT = 20;
export const MAX_SNAPSHOT_CHARS = 200_000;

export class CheckpointStore {
  constructor(
    private readonly state: Memento,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private read(): Checkpoint[] {
    const rows = this.state.get<Checkpoint[]>(KEY);
    return Array.isArray(rows) ? rows : [];
  }

  private async write(rows: Checkpoint[]): Promise<void> {
    await this.state.update(KEY, rows);
  }

  /**
   * Keep what the file was before an apply. Null when the file's contents
   * were too large to snapshot faithfully; the apply itself is unaffected.
   */
  async record(
    conversationId: string | null,
    file: { uri: string; path: string },
    content: string | null,
    label: string,
  ): Promise<Checkpoint | null> {
    if (content !== null && content.length > MAX_SNAPSHOT_CHARS) return null;
    const rows = this.read();
    const checkpoint: Checkpoint = {
      id: `${this.now().getTime().toString(36)}-${rows.length.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      conversationId,
      uri: file.uri,
      path: file.path,
      content,
      createdAt: this.now().toISOString(),
      label,
    };
    rows.unshift(checkpoint);
    await this.write(prune(rows, conversationId));
    return checkpoint;
  }

  /** One chat's checkpoints, newest first; null chats every chat's. */
  async list(conversationId: string | null): Promise<Checkpoint[]> {
    const rows = this.read();
    return conversationId === null ? rows : rows.filter((row) => row.conversationId === conversationId);
  }

  async get(id: string): Promise<Checkpoint | null> {
    return this.read().find((row) => row.id === id) ?? null;
  }

  async remove(id: string): Promise<void> {
    await this.write(this.read().filter((row) => row.id !== id));
  }
}

/** Keep the newest per chat, so one busy chat cannot push the others out. */
function prune(rows: Checkpoint[], justRecorded: string | null): Checkpoint[] {
  const thisChat: Checkpoint[] = [];
  const others: Checkpoint[] = [];
  for (const row of rows) (row.conversationId === justRecorded ? thisChat : others).push(row);
  return [...thisChat.slice(0, MAX_CHECKPOINTS_PER_CHAT), ...others];
}
