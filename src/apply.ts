import * as vscode from "vscode";
import { whereItLands } from "./targets";

/**
 * Applying code to a file, the only way the extension ever writes one: a
 * diff of the file as it is against the code as it would be, in a virtual
 * document, and the write happens only on the person's Apply. Afterwards
 * the file is reopened (without stealing focus) so its language server
 * re-lints what landed and the Problems panel says so.
 */

/** The scheme of the virtual right-hand side of a diff preview. */
export const APPLY_SCHEME = "matterwave-apply";

const virtualDocuments = new Map<string, string>();

/** Serve the preview's bytes; call once from `activate` and keep the disposable. */
export function registerApplyContentProvider(): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(APPLY_SCHEME, {
    provideTextDocumentContent: (uri: vscode.Uri) => virtualDocuments.get(uri.toString()) ?? "",
  });
}

export interface ApplyOptions {
  /** The diff editor's title, naming the file and the change. */
  title: string;
  /** What to show in the confirm dialog besides the file's name. */
  detail?: string;
  /**
   * Called with the file's current contents once the person has said Apply
   * but before anything is written -- the moment a checkpoint is taken.
   * Null when the file does not exist yet.
   */
  onSnapshot?: (before: string | null) => Promise<void> | void;
  /** Reopen the file after the write so diagnostics refresh; on by default. */
  lint?: boolean;
}

/**
 * Show the diff, ask, and write on Apply. True when the file was written,
 * false when the code already matched or the person kept the file as it was.
 */
export async function applyToFile(target: vscode.Uri, newContent: string, opts: ApplyOptions): Promise<boolean> {
  const name = vscode.workspace.asRelativePath(target, false);
  const before = await readFileOrNull(target);
  if (before !== null && before === newContent) {
    void vscode.window.showInformationMessage(`${name} already has this code; nothing to apply.`);
    return false;
  }
  const empty = vscode.Uri.parse(`${APPLY_SCHEME}:empty`);
  const preview = vscode.Uri.parse(`${APPLY_SCHEME}:${target.path.replace(/^\//, "")}`);
  virtualDocuments.set(preview.toString(), newContent);
  virtualDocuments.set(empty.toString(), "");
  await vscode.commands.executeCommand("vscode.diff", before === null ? empty : target, preview, opts.title);
  // The dialog names where the write lands, resolved, not the name the
  // answer gave: the two differ exactly when it matters.
  const answer = await vscode.window.showInformationMessage(
    `Apply this code to ${name}?`,
    {
      modal: true,
      detail: `${opts.detail ?? "The file becomes exactly the code on the right."}\n\nWrites to ${whereItLands(target)}`,
    },
    "Apply",
  );
  if (answer !== "Apply") {
    void vscode.window.showInformationMessage(`Kept ${name} as it was.`);
    return false;
  }
  await opts.onSnapshot?.(before);
  if (before === null) {
    // A new file's directory may not exist either.
    await vscode.workspace.fs.createDirectory(directoryOf(target));
  }
  await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(newContent));
  if (opts.lint !== false) await lintAfterApply(target);
  void vscode.window.showInformationMessage(`Applied to ${name}.`);
  return true;
}

/**
 * Reopen the file so its language server lints the new content and the
 * Problems panel reflects the applied change. Best-effort: a file that
 * cannot be opened leaves no lint to refresh.
 */
export async function lintAfterApply(uri: vscode.Uri): Promise<void> {
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: true, preserveFocus: true });
  } catch {
    // Nothing to lint.
  }
}

async function readFileOrNull(uri: vscode.Uri): Promise<string | null> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return null;
  }
}

function directoryOf(uri: vscode.Uri): vscode.Uri {
  const path = uri.path.replace(/^\//, "");
  const at = path.lastIndexOf("/");
  return at < 0 ? vscode.Uri.parse(`${uri.scheme}:`) : vscode.Uri.parse(`${uri.scheme}:${path.slice(0, at)}`);
}
