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

/** Where a write lands, as the confirm dialog names it: the path on disk, or the whole URI off it. */
export function whereItLands(uri: vscode.Uri): string {
  return uri.scheme === "file" ? uri.fsPath : uri.toString(true);
}
