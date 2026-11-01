import * as vscode from "vscode";
import { APPLY_SCHEME } from "../apply";
import type { EditorContext } from "./promptContext";
import type { ReviewHandle, ReviewSurface } from "./session";
import type { ChangeRequest } from "./tools";

/**
 * The editor's side of the coding agent: the native diff a change is
 * reviewed in, the WorkspaceEdit that applies it, and what the editor shows
 * (for the prompt's context).
 *
 * A proposal is a virtual document in an in-memory file system
 * (`matterwave-proposal:`), not a read-only content provider, so the person
 * can edit the right side of the diff before accepting; Accept writes what
 * the right side holds then. Writing goes through a WorkspaceEdit on the
 * file's document and a save, so Ctrl+Z in that editor undoes it.
 */

export const PROPOSAL_SCHEME = "matterwave-proposal";
/** The context key the editor's Accept and Reject buttons show under. */
export const REVIEWING_CONTEXT = "matterwave.agentReviewing";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** The proposals under review, as files only this extension serves; the person may write to them (that is the edit). */
export class ProposalFileSystem implements vscode.FileSystemProvider {
  private readonly files = new Map<string, { data: Uint8Array; ctime: number; mtime: number }>();
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  set(uri: vscode.Uri, text: string): void {
    const now = Date.now();
    this.files.set(uri.path, { data: encoder.encode(text), ctime: now, mtime: now });
  }

  text(uri: vscode.Uri): string | null {
    const file = this.files.get(uri.path);
    return file ? decoder.decode(file.data) : null;
  }

  remove(uri: vscode.Uri): void {
    this.files.delete(uri.path);
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const file = this.files.get(uri.path);
    if (file) return { type: vscode.FileType.File, ctime: file.ctime, mtime: file.mtime, size: file.data.length };
    // The proposal's folders exist only as the paths of its files.
    if ([...this.files.keys()].some((path) => path.startsWith(`${uri.path.replace(/\/+$/, "")}/`))) {
      return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    }
    throw vscode.FileSystemError.FileNotFound(uri);
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(): void {
    // Folders are implied by the files.
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const file = this.files.get(uri.path);
    if (!file) throw vscode.FileSystemError.FileNotFound(uri);
    return file.data;
  }

  writeFile(uri: vscode.Uri, content: Uint8Array): void {
    const existing = this.files.get(uri.path);
    if (!existing) throw vscode.FileSystemError.NoPermissions("Only a proposal under review can be saved here.");
    this.files.set(uri.path, { ...existing, data: content, mtime: Date.now() });
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  delete(uri: vscode.Uri): void {
    this.files.delete(uri.path);
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions("A proposal cannot be renamed.");
  }
}

function sameUri(a: vscode.Uri, b: vscode.Uri): boolean {
  return a.toString() === b.toString();
}

function diffTabs(proposal: vscode.Uri): vscode.Tab[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputTextDiff && sameUri(tab.input.modified, proposal));
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/**
 * Replace a document's text with `content` through a WorkspaceEdit, as one
 * undo step, then save. Only the span that differs is replaced, so the
 * cursor and folds outside it stay put.
 */
export async function replaceDocumentText(document: vscode.TextDocument, content: string): Promise<boolean> {
  const current = document.getText();
  if (current === content) return true;
  let start = 0;
  const max = Math.min(current.length, content.length);
  while (start < max && current[start] === content[start]) start++;
  let end = 0;
  while (end < max - start && current[current.length - 1 - end] === content[content.length - 1 - end]) end++;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    document.uri,
    new vscode.Range(document.positionAt(start), document.positionAt(current.length - end)),
    content.slice(start, content.length - end),
  );
  return vscode.workspace.applyEdit(edit);
}

export class EditorReviewSurface implements ReviewSurface {
  private open_ = 0;

  constructor(private readonly proposals: ProposalFileSystem) {}

  async open(change: ChangeRequest, id: string): Promise<ReviewHandle> {
    const proposal = vscode.Uri.from({ scheme: PROPOSAL_SCHEME, path: `/${id}/${change.relative}` });
    this.proposals.set(proposal, change.after);
    const target = vscode.Uri.file(change.absolute);
    const left = change.before === null ? vscode.Uri.parse(`${APPLY_SCHEME}:empty`) : target;
    const title = `${change.relative} ↔ proposed change (MatterWave agent)`;
    const show = async () => {
      await vscode.commands.executeCommand("vscode.diff", left, proposal, title, { preview: false });
    };
    this.open_ += 1;
    await vscode.commands.executeCommand("setContext", REVIEWING_CONTEXT, true);
    await show();
    return {
      proposal: async () => {
        const document = vscode.workspace.textDocuments.find((d) => sameUri(d.uri, proposal));
        return document ? document.getText() : (this.proposals.text(proposal) ?? change.after);
      },
      reveal: show,
      close: async () => {
        const document = vscode.workspace.textDocuments.find((d) => sameUri(d.uri, proposal));
        // Saved into memory first, so closing the edited proposal asks nothing.
        if (document?.isDirty) await document.save();
        const tabs = diffTabs(proposal);
        if (tabs.length > 0) await vscode.window.tabGroups.close(tabs);
        this.proposals.remove(proposal);
        this.open_ = Math.max(0, this.open_ - 1);
        if (this.open_ === 0) await vscode.commands.executeCommand("setContext", REVIEWING_CONTEXT, false);
      },
    };
  }

  async apply(change: ChangeRequest, content: string): Promise<string> {
    const uri = vscode.Uri.file(change.absolute);
    if (!(await exists(uri))) {
      // A new file: created with exactly these bytes (the creation is on the
      // workspace's undo stack), then opened so the person sees it.
      const edit = new vscode.WorkspaceEdit();
      edit.createFile(uri, { ignoreIfExists: true, contents: encoder.encode(content) });
      if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`${change.relative} could not be created.`);
      await this.show(uri);
      return content;
    }
    const document = await vscode.workspace.openTextDocument(uri);
    if (!(await replaceDocumentText(document, content))) throw new Error(`The editor refused the change to ${change.relative}.`);
    // Saved, so a command the agent runs next sees the change on disk.
    await document.save();
    await this.show(uri);
    return document.getText();
  }

  private async show(uri: vscode.Uri): Promise<void> {
    try {
      await vscode.window.showTextDocument(uri, { preview: true, preserveFocus: true });
    } catch {
      // Nothing to show: the change is applied either way.
    }
  }
}

/** The open document's text when the editor holds one, so the agent reads what the person sees. */
export async function openDocumentText(absolute: string): Promise<string | null> {
  const uri = vscode.Uri.file(absolute);
  const document = vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && d.uri.fsPath === uri.fsPath);
  return document ? document.getText() : null;
}

/** The active file, the selection and the files opened lately, for the prompt's context. */
export class EditorTracker implements vscode.Disposable {
  private readonly recent: string[] = [];
  private readonly subscription: vscode.Disposable;

  constructor() {
    this.note(vscode.window.activeTextEditor);
    this.subscription = vscode.window.onDidChangeActiveTextEditor((editor) => this.note(editor));
  }

  private note(editor: vscode.TextEditor | undefined): void {
    if (!editor || editor.document.uri.scheme !== "file") return;
    const path = editor.document.uri.fsPath;
    const at = this.recent.indexOf(path);
    if (at >= 0) this.recent.splice(at, 1);
    this.recent.unshift(path);
    this.recent.splice(20);
  }

  snapshot(): EditorContext {
    const editor = vscode.window.activeTextEditor;
    const file = editor && editor.document.uri.scheme === "file" ? editor : null;
    const selection = file && !file.selection.isEmpty ? file.selection : null;
    return {
      activeFile: file ? { absolute: file.document.uri.fsPath, line: file.selection.active.line + 1 } : null,
      selection:
        file && selection
          ? {
              absolute: file.document.uri.fsPath,
              startLine: selection.start.line + 1,
              endLine: selection.end.line + 1,
              text: file.document.getText(selection),
              languageId: file.document.languageId,
            }
          : null,
      recentFiles: [...this.recent],
    };
  }

  dispose(): void {
    this.subscription.dispose();
  }
}
