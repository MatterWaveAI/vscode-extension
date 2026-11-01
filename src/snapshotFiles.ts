import * as vscode from "vscode";
import type { SnapshotFiles } from "./checkpoints";

/**
 * Checkpoint snapshots as files in one folder of the extension's storage,
 * one `<id>.txt` per checkpoint, read and written through the editor's file
 * system. Ids are the store's own; anything else is refused rather than
 * joined into a path.
 */
export function snapshotFolder(folder: vscode.Uri): SnapshotFiles {
  const fileOf = (id: string): vscode.Uri => {
    if (!/^[a-z0-9-]{1,64}$/.test(id)) throw new Error(`not a checkpoint id: ${id}`);
    return vscode.Uri.joinPath(folder, `${id}.txt`);
  };
  return {
    async write(id, text) {
      await vscode.workspace.fs.createDirectory(folder);
      await vscode.workspace.fs.writeFile(fileOf(id), new TextEncoder().encode(text));
    },
    async read(id) {
      try {
        return new TextDecoder().decode(await vscode.workspace.fs.readFile(fileOf(id)));
      } catch {
        return null;
      }
    },
    async delete(id) {
      try {
        await vscode.workspace.fs.delete(fileOf(id));
      } catch {
        // Already gone: what a delete wanted.
      }
    },
    async list() {
      try {
        const entries = await vscode.workspace.fs.readDirectory(folder);
        return entries
          .filter(([name, type]) => type === vscode.FileType.File && /^[a-z0-9-]{1,64}\.txt$/.test(name))
          .map(([name]) => name.slice(0, -".txt".length));
      } catch {
        return [];
      }
    },
  };
}
