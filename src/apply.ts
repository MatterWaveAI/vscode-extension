import * as vscode from "vscode";
import { whereItLands } from "./targets";

/**
 * Applying code to a file, the only way the extension ever changes one: a
 * diff of the document as it is against the code as it would be, in a
 * virtual document, and the change happens only on the person's Apply.
 *
 * The change goes through a `WorkspaceEdit`, never a write to disk: it
 * lands in the editor's buffer beside any unsaved edits, joins the
 * document's undo stack, and never races the editor's own copy into a save
 * conflict. What the diff, the checkpoint and the comparison read is the
 * document's text -- unsaved edits included -- not the file on disk.
 * Afterwards the document is shown (without stealing focus) so its
 * language server re-lints what landed and the Problems panel says so.
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
   * Called with the document's current text once the person has said Apply
   * but before anything changes -- the moment a checkpoint is taken. Null
   * when the file does not exist yet.
   */
  onSnapshot?: (before: string | null) => Promise<void> | void;
  /** Show the document after the change so diagnostics refresh; on by default. */
  lint?: boolean;
}

/**
 * Show the diff, ask, and change the document on Apply. True when it
 * changed, false when the code already matched, the person kept the file as
 * it was, or the document moved on while the diff was open.
 */
export async function applyToFile(target: vscode.Uri, newContent: string, opts: ApplyOptions): Promise<boolean> {
  const name = vscode.workspace.asRelativePath(target, true);
  let document: vscode.TextDocument | null;
  try {
    document = await documentOrNull(target);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `${name} could not be opened as text, so nothing was applied: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
  const before = document ? document.getText() : null;
  // The answer's lines end in \n; a CRLF document compares and previews in its own endings.
  const content = document ? withEol(newContent, document.eol) : newContent;
  if (before !== null && before === content) {
    void vscode.window.showInformationMessage(`${name} already has this code; nothing to apply.`);
    return false;
  }
  const empty = vscode.Uri.parse(`${APPLY_SCHEME}:empty`);
  const preview = vscode.Uri.parse(`${APPLY_SCHEME}:${target.path.replace(/^\//, "")}`);
  virtualDocuments.set(preview.toString(), content);
  virtualDocuments.set(empty.toString(), "");
  // The left side is the document itself, so the diff shows its unsaved edits.
  await vscode.commands.executeCommand("vscode.diff", document ? target : empty, preview, opts.title);
  // The dialog names where the change lands, resolved, not the name the
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
  if (document && document.getText() !== before) {
    void vscode.window.showWarningMessage(
      `${name} changed while the diff was open, so nothing was applied. Apply again to review it against the new text.`,
    );
    return false;
  }
  await opts.onSnapshot?.(before);
  const wasDirty = document?.isDirty ?? false;
  const edit = new vscode.WorkspaceEdit();
  if (document && before !== null) {
    const change = minimalChange(before, content);
    edit.replace(target, new vscode.Range(document.positionAt(change.start), document.positionAt(change.end)), change.text);
  } else {
    // The editor's file service makes any missing parent directories.
    edit.createFile(target, { ignoreIfExists: false });
    edit.insert(target, new vscode.Position(0, 0), content);
  }
  if (!(await vscode.workspace.applyEdit(edit))) {
    void vscode.window.showErrorMessage(`${name} could not be changed; nothing was applied.`);
    return false;
  }
  // A document the person had not touched is saved, as an apply always
  // left the file; one holding their unsaved edits stays theirs to save.
  if (!wasDirty) {
    const changed = await vscode.workspace.openTextDocument(target);
    await changed.save();
  }
  if (opts.lint !== false) await lintAfterApply(target);
  void vscode.window.showInformationMessage(`Applied to ${name}.`);
  return true;
}

/**
 * Show the document so its language server lints the new content and the
 * Problems panel reflects the applied change. Best-effort: a document that
 * cannot be shown leaves no lint to refresh.
 */
export async function lintAfterApply(uri: vscode.Uri): Promise<void> {
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: true, preserveFocus: true });
  } catch {
    // Nothing to lint.
  }
}

/**
 * The file's document -- the editor's buffer when it is open, unsaved edits
 * and all -- or null when there is no such file yet. A file that exists but
 * will not open as text throws.
 */
async function documentOrNull(uri: vscode.Uri): Promise<vscode.TextDocument | null> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) return open;
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    return null;
  }
  return vscode.workspace.openTextDocument(uri);
}

/** `text` with every line ending the document's own. */
export function withEol(text: string, eol: vscode.EndOfLine): string {
  return text.replace(/\r\n|\r|\n/g, eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n");
}

/**
 * The one range `before` and `after` differ in, as offsets into `before` and
 * the text that replaces it: the common prefix and suffix stay untouched, so
 * the edit moves no marker, fold or cursor outside what changed.
 */
export function minimalChange(before: string, after: string): { start: number; end: number; text: string } {
  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)) {
    endBefore--;
    endAfter--;
  }
  return { start, end: endBefore, text: after.slice(start, endAfter) };
}
