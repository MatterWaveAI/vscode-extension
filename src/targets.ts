import * as vscode from "vscode";

/**
 * Where a file a model names lands. The name comes from an answer's code
 * fence, which is model output: it may climb (`../../.bashrc`), be absolute
 * (`/etc/hosts`, `C:\Windows\...`, `\\server\share`) or carry a scheme, and
 * `Uri.joinPath` would happily resolve any of those to somewhere outside the
 * workspace. Only a plain relative path that stays inside its folder is
 * ever resolved; everything else is refused before a diff is shown.
 */

/** The path's segments once `.` and `..` are resolved, or null when it is absolute, a URI, or climbs out. */
export function relativeSegments(raw: string): string[] | null {
  const path = raw.trim();
  if (!path) return null;
  // Absolute on any platform, a UNC share, a drive letter, or a URI.
  if (/^[\\/]/.test(path) || /^[A-Za-z]:/.test(path) || /^[A-Za-z][\w+.-]*:\/\//.test(path)) return null;
  const segments: string[] = [];
  // Both separators: on Windows a backslash is one, whatever a URI path says.
  for (const segment of path.split(/[\\/]+/)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    // A colon inside a segment is a drive or an NTFS stream, never a file name to write.
    if (segment.includes(":")) return null;
    segments.push(segment);
  }
  return segments.length > 0 ? segments : null;
}

/** Whether `uri` is `folder` itself or somewhere under it, on the same host. */
export function isInside(folder: vscode.Uri, uri: vscode.Uri): boolean {
  if (folder.scheme !== uri.scheme || folder.authority !== uri.authority) return false;
  const base = folder.path.replace(/\/+$/, "");
  return uri.path === base || uri.path.startsWith(`${base}/`);
}

/** `raw` resolved under `folder`, or null when it would land anywhere else. */
export function resolveInFolder(folder: vscode.Uri, raw: string): vscode.Uri | null {
  const segments = relativeSegments(raw);
  if (!segments) return null;
  const uri = vscode.Uri.joinPath(folder, ...segments);
  return isInside(folder, uri) ? uri : null;
}

/** What `resolveNamedFile` needs from the editor: its folders, the active one, and a way to ask. */
export interface FolderContext {
  folders: readonly vscode.WorkspaceFolder[];
  /** The folder of the file the person is in, when they are in one. */
  active: vscode.WorkspaceFolder | undefined;
  /** Ask which folder; undefined is the person backing out. */
  pick: (placeHolder: string) => Thenable<vscode.WorkspaceFolder | undefined>;
}

export type NamedFile =
  | { kind: "file"; uri: vscode.Uri }
  /** The name resolves outside every folder. */
  | { kind: "outside" }
  /** No folder is open, or the person backed out of the pick. */
  | { kind: "none" };

/**
 * The file an answer names, in the folder it belongs to. In a multi-root
 * workspace the name may lead with a folder's name (`api/src/a.ts`, the
 * way this extension writes paths there); otherwise it belongs to the
 * folder of the file the person is in, then to the only folder, and
 * failing both the person is asked -- never silently the first folder.
 */
export async function resolveNamedFile(raw: string, context: FolderContext): Promise<NamedFile> {
  const { folders } = context;
  if (folders.length === 0) return { kind: "none" };
  const segments = relativeSegments(raw);
  if (!segments) return { kind: "outside" };
  if (folders.length > 1 && segments.length > 1) {
    const named = folders.find((folder) => folder.name === segments[0]);
    if (named) {
      const uri = resolveInFolder(named.uri, segments.slice(1).join("/"));
      return uri ? { kind: "file", uri } : { kind: "outside" };
    }
  }
  const folder =
    context.active ?? (folders.length === 1 ? folders[0] : await context.pick(`Which folder is ${raw} in?`));
  if (!folder) return { kind: "none" };
  const uri = resolveInFolder(folder.uri, raw);
  return uri ? { kind: "file", uri } : { kind: "outside" };
}

/** The folder of the active editor, the only folder, or one the person picks; undefined when none. */
export async function currentFolder(context: FolderContext, placeHolder: string): Promise<vscode.WorkspaceFolder | undefined> {
  if (context.active) return context.active;
  if (context.folders.length === 1) return context.folders[0];
  if (context.folders.length === 0) return undefined;
  return context.pick(placeHolder);
}

/** The editor's folders, as `resolveNamedFile` and `currentFolder` read them. */
export function editorFolders(): FolderContext {
  const document = vscode.window.activeTextEditor?.document;
  return {
    folders: vscode.workspace.workspaceFolders ?? [],
    active: document ? vscode.workspace.getWorkspaceFolder(document.uri) : undefined,
    pick: (placeHolder) => vscode.window.showWorkspaceFolderPick({ placeHolder }),
  };
}

/** Where a write lands, as the confirm dialog names it: the path on disk, or the whole URI off it. */
export function whereItLands(uri: vscode.Uri): string {
  return uri.scheme === "file" ? uri.fsPath : uri.toString(true);
}
