import { confine } from "./lib/sdk/agent/confine";
import { DenyList } from "./lib/sdk/agent/deny";
import type { Memento } from "./promptLibrary";

/**
 * Checkpoints: the contents a file had before each apply, kept so an
 * applied edit is never beyond taking back.
 *
 * One row per apply, named by the conversation it came from (the chat's own
 * restore list). The snapshots themselves are files in the extension's
 * storage folder; only a small index of rows lives in the editor's global
 * state, which VS Code loads at every start. The whole store is capped --
 * per chat, in rows overall and in bytes overall -- so it stays the same
 * size however many chats there are: past a cap, the least recently used
 * checkpoints go first. Large files are refused rather than
 * half-snapshotted: a checkpoint that would not restore faithfully is not
 * a checkpoint.
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
  /** True when the file did not exist before the apply: restoring removes it. */
  isNew: boolean;
  /** Characters in the snapshot (0 for a new file). */
  size: number;
  createdAt: string;
  /** When the checkpoint was last taken or restored: what "least recently used" reads. */
  usedAt: string;
  /** What took the checkpoint: "Apply" or "Inline edit". */
  label: string;
}

/** Where snapshots are kept: one text per checkpoint id. */
export interface SnapshotFiles {
  write(id: string, text: string): Promise<void>;
  /** Null when the file is gone. */
  read(id: string): Promise<string | null>;
  delete(id: string): Promise<void>;
  /** Every id with a file, so files the index lost track of can be swept. */
  list(): Promise<string[]>;
}

const INDEX_KEY = "matterwave.checkpointIndex";
/** Where an older release kept whole snapshots in global state; read once and moved to files. */
const LEGACY_KEY = "matterwave.checkpoints";

/** How many checkpoints one chat keeps, and the cap on any one snapshot. */
export const MAX_CHECKPOINTS_PER_CHAT = 20;
export const MAX_SNAPSHOT_CHARS = 200_000;
/** The caps on the whole store, every chat together. */
export const MAX_CHECKPOINTS = 200;
export const MAX_TOTAL_CHARS = 10_000_000;

interface LegacyRow {
  id: string;
  conversationId: string | null;
  uri?: string;
  path: string;
  content: string | null;
  createdAt: string;
  label: string;
}

export class CheckpointStore {
  /** The first use moves an older release's snapshots to files and sweeps stray files; later uses wait on it. */
  private ready: Promise<void> | null = null;

  constructor(
    private readonly state: Memento,
    private readonly files: SnapshotFiles,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private rows(): Checkpoint[] {
    const rows = this.state.get<Checkpoint[]>(INDEX_KEY);
    return Array.isArray(rows) ? rows : [];
  }

  private async save(rows: Checkpoint[]): Promise<void> {
    await this.state.update(INDEX_KEY, rows);
  }

  private prepare(): Promise<void> {
    this.ready ??= this.migrateAndSweep();
    return this.ready;
  }

  private async migrateAndSweep(): Promise<void> {
    const legacy = this.state.get<LegacyRow[]>(LEGACY_KEY);
    if (Array.isArray(legacy) && legacy.length > 0) {
      const moved: Checkpoint[] = [];
      for (const row of legacy) {
        if (row.content !== null) await this.files.write(row.id, row.content);
        moved.push({
          id: row.id,
          conversationId: row.conversationId,
          ...(row.uri ? { uri: row.uri } : {}),
          path: row.path,
          isNew: row.content === null,
          size: row.content?.length ?? 0,
          createdAt: row.createdAt,
          usedAt: row.createdAt,
          label: row.label,
        });
      }
      await this.save(await this.prune([...this.rows(), ...moved]));
    }
    if (legacy !== undefined) await this.state.update(LEGACY_KEY, undefined);
    // A file the index does not name was left by a write the index never
    // recorded (the editor closed between the two): nothing can restore it.
    const known = new Set(this.rows().map((row) => row.id));
    for (const id of await this.files.list()) if (!known.has(id)) await this.files.delete(id);
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
    await this.prepare();
    const rows = this.rows();
    const at = this.now();
    const checkpoint: Checkpoint = {
      id: `${at.getTime().toString(36)}-${rows.length.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      conversationId,
      uri: file.uri,
      path: file.path,
      isNew: content === null,
      size: content?.length ?? 0,
      createdAt: at.toISOString(),
      usedAt: at.toISOString(),
      label,
    };
    // The file first: an index row must never name a snapshot that is not there.
    if (content !== null) await this.files.write(checkpoint.id, content);
    await this.save(await this.prune([checkpoint, ...rows], conversationId));
    return checkpoint;
  }

  /** One chat's checkpoints, newest first; null chats every chat's. */
  async list(conversationId: string | null): Promise<Checkpoint[]> {
    await this.prepare();
    const rows = [...this.rows()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return conversationId === null ? rows : rows.filter((row) => row.conversationId === conversationId);
  }

  async get(id: string): Promise<Checkpoint | null> {
    await this.prepare();
    return this.rows().find((row) => row.id === id) ?? null;
  }

  /**
   * The snapshot a checkpoint kept, marked as just used. Null for a file
   * that was new (there was nothing to keep) and for a snapshot whose file
   * is gone, which `isNew` tells apart.
   */
  async content(id: string): Promise<string | null> {
    await this.prepare();
    const rows = this.rows();
    const row = rows.find((r) => r.id === id);
    if (!row || row.isNew) return null;
    const text = await this.files.read(id);
    if (text === null) return null;
    row.usedAt = this.now().toISOString();
    await this.save(rows);
    return text;
  }

  async remove(id: string): Promise<void> {
    await this.prepare();
    await this.save(this.rows().filter((row) => row.id !== id));
    await this.files.delete(id);
  }

  /**
   * The rows that stay, their dropped snapshots deleted: the newest per
   * chat (so one busy chat cannot push the others out), then the most
   * recently used until the store is under both caps.
   */
  private async prune(rows: Checkpoint[], justRecorded?: string | null): Promise<Checkpoint[]> {
    const perChat = new Map<string | null, number>();
    const kept: Checkpoint[] = [];
    const dropped: Checkpoint[] = [];
    for (const row of [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
      const n = perChat.get(row.conversationId) ?? 0;
      const limited = justRecorded === undefined || row.conversationId === justRecorded;
      if (limited && n >= MAX_CHECKPOINTS_PER_CHAT) dropped.push(row);
      else kept.push(row);
      perChat.set(row.conversationId, n + 1);
    }
    kept.sort((a, b) => b.usedAt.localeCompare(a.usedAt));
    let total = kept.reduce((sum, row) => sum + row.size, 0);
    while (kept.length > MAX_CHECKPOINTS || total > MAX_TOTAL_CHARS) {
      const oldest = kept.pop();
      if (!oldest) break;
      total -= oldest.size;
      dropped.push(oldest);
    }
    for (const row of dropped) if (!row.isNew) await this.files.delete(row.id);
    return kept;
  }
}

/**
 * What restoring to before `pickedId` puts back: for every file that
 * checkpoint or any later one (in `rows`, newest first) touched, the row
 * holding its contents before the earliest of those changes. Restoring to
 * before the first of two applied edits so brings both files back, not
 * just the one picked. A row that `isNew` is a file that did not exist
 * then, so restoring removes it.
 */
export function restorePlan(rows: readonly Checkpoint[], pickedId: string): Checkpoint[] {
  const at = rows.findIndex((row) => row.id === pickedId);
  if (at < 0) return [];
  const plan = new Map<string, Checkpoint>();
  // Newest to the picked one; an older row of the same file overwrites, so its snapshot wins.
  for (const row of rows.slice(0, at + 1)) plan.set(row.uri ?? row.path, row);
  return [...plan.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Where restoring `path` under `root` writes: the path with its links
 * followed, or null when that now leads out of the root (a folder replaced
 * by a link since the checkpoint was taken), so a restore never writes
 * through it. The deny list does not apply: a checkpoint holds what the
 * person's own Apply wrote, and putting it back is theirs to do.
 */
export function restoreTarget(root: string, path: string): string | null {
  try {
    return confine(root, path, { deny: new DenyList([]) }).absolute;
  } catch {
    return null;
  }
}
