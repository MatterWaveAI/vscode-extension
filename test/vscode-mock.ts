/**
 * The slice of the `vscode` module the code under test touches, aliased in
 * vitest.config.ts. Only what a test needs is here; anything else throws
 * by being undefined, which is the point -- a test reaching for an API this
 * mock does not model should fail loudly rather than pass against a stub.
 */

import { posix } from "node:path";

/**
 * A URI in the parts the editor's has -- scheme, authority, path -- so code
 * that must keep a remote host's authority (`vscode-remote://ssh-remote+box`)
 * is tested against one. `joinPath` normalises `.` and `..` the way the
 * editor's does (POSIX join), which is exactly what lets a careless join
 * climb out of a folder.
 */
export class Uri {
  private constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
    readonly query: string,
    readonly fragment: string,
  ) {}
  static parse(value: string): Uri {
    const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):(\/\/([^/?#]*))?([^?#]*)(\?[^#]*)?(#.*)?$/.exec(value);
    if (!match) return new Uri("file", "", value, "", "");
    return new Uri(match[1] ?? "file", match[3] ?? "", match[4] ?? "", (match[5] ?? "").slice(1), (match[6] ?? "").slice(1));
  }
  static file(path: string): Uri {
    const normalized = path.replace(/\\/g, "/");
    return new Uri("file", "", normalized.startsWith("/") ? normalized : `/${normalized}`, "", "");
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    return base.with({ path: posix.join(base.path || "/", ...segments) });
  }
  with(change: { scheme?: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment,
    );
  }
  get fsPath(): string {
    return this.path;
  }
  toString(skipEncoding?: boolean): string {
    void skipEncoding;
    const authority = this.authority || this.scheme === "file" ? `//${this.authority}` : "";
    return `${this.scheme}:${authority}${this.path}${this.query ? `?${this.query}` : ""}${this.fragment ? `#${this.fragment}` : ""}`;
  }
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum ExtensionMode {
  Production = 1,
  Development = 2,
  Test = 3,
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export enum QuickPickItemKind {
  Separator = -1,
  Default = 0,
}

export const window = {
  createStatusBarItem: () => ({ text: "", tooltip: "", command: "", show() {}, dispose() {} }),
  /** Answers a test queues; a dialog with none queued answers undefined. */
  informationAnswers: [] as unknown[],
  shown: [] as { kind: string; message: string; options: unknown }[],
  showInformationMessage(message: string, ...rest: unknown[]): Promise<unknown> {
    this.shown.push({ kind: "information", message, options: rest });
    return Promise.resolve(this.informationAnswers.shift());
  },
  showWarningMessage(message: string, ...rest: unknown[]): Promise<unknown> {
    this.shown.push({ kind: "warning", message, options: rest });
    return Promise.resolve(this.informationAnswers.shift());
  },
  showErrorMessage(message: string, ...rest: unknown[]): Promise<unknown> {
    this.shown.push({ kind: "error", message, options: rest });
    return Promise.resolve(this.informationAnswers.shift());
  },
  showInputBox: () => Promise.resolve(undefined),
  showQuickPick: () => Promise.resolve(undefined),
  showOpenDialog: () => Promise.resolve(undefined),
  showSaveDialog: () => Promise.resolve(undefined),
  /** Documents a test opened through the apply path's lint hook. */
  shownDocuments: [] as unknown[],
  showTextDocument(document: unknown, options?: unknown): Promise<unknown> {
    void options;
    this.shownDocuments.push(document);
    return Promise.resolve(document);
  },
  terminals: [] as unknown[],
  activeTextEditor: undefined as { document: { uri: Uri } } | undefined,
  /** What the folder pick answers: a folder's name, or undefined for Escape. */
  folderPickAnswer: undefined as string | undefined,
  folderPicks: [] as string[],
  showWorkspaceFolderPick(options?: { placeHolder?: string }): Promise<unknown> {
    window.folderPicks.push(options?.placeHolder ?? "");
    return Promise.resolve(workspace.workspaceFolders.find((folder) => folder.name === window.folderPickAnswer));
  },
  /** The QuickPicks code under test created, newest last. */
  quickPicks: [] as FakeQuickPick[],
  createQuickPick(): FakeQuickPick {
    const pick = new FakeQuickPick();
    window.quickPicks.push(pick);
    return pick;
  },
  /** Views registered by `activate`, by id. */
  viewProviders: {} as Record<string, unknown>,
  registerWebviewViewProvider(id: string, provider: unknown): { dispose(): void } {
    window.viewProviders[id] = provider;
    return { dispose() {} };
  },
};

export const commands = {
  executed: [] as string[],
  /** The arguments of each executeCommand, parallel to `executed`. */
  commandArgs: [] as unknown[][],
  /** Commands registered by `activate`, by id. */
  registered: new Map<string, (...args: unknown[]) => unknown>(),
  executeCommand(id: string, ...rest: unknown[]): Promise<void> {
    commands.executed.push(id);
    commands.commandArgs.push(rest);
    return Promise.resolve();
  },
  registerCommand(id: string, run: (...args: unknown[]) => unknown): { dispose(): void } {
    commands.registered.set(id, run);
    return { dispose: () => void commands.registered.delete(id) };
  },
};

/**
 * An in-memory workspace: a folder list, a file map standing in for
 * `workspace.fs`, and the content providers registered on it. Only what a
 * test needs is modelled; the rest throws by being undefined.
 */
export const workspace = {
  workspaceFolders: [] as { uri: Uri; name: string; index: number }[],
  files: new Map<string, Uint8Array>(),
  contentProviders: {} as Record<string, unknown>,
  /** Settings by `section.key`; `getConfiguration` reads and writes here. */
  settings: new Map<string, unknown>(),
  getConfiguration(section: string) {
    return {
      get<T>(key: string): T | undefined {
        return workspace.settings.get(`${section}.${key}`) as T | undefined;
      },
      update(key: string, value: unknown): Promise<void> {
        workspace.settings.set(`${section}.${key}`, value);
        return Promise.resolve();
      },
    };
  },
  onDidChangeConfiguration(): { dispose(): void } {
    return { dispose() {} };
  },
  registerTextDocumentContentProvider(scheme: string, provider: unknown): { dispose(): void } {
    workspace.contentProviders[scheme] = provider;
    return { dispose() {} };
  },
  /** As the editor's: with several folders open, `includeWorkspaceFolder` leads with the folder's name. */
  asRelativePath(uri: Uri, includeWorkspaceFolder?: boolean): string {
    const value = uri.toString();
    for (const folder of workspace.workspaceFolders) {
      const base = folder.uri.toString().replace(/\/+$/, "");
      if (!value.startsWith(`${base}/`)) continue;
      const relative = value.slice(base.length + 1);
      return includeWorkspaceFolder && workspace.workspaceFolders.length > 1 ? `${folder.name}/${relative}` : relative;
    }
    return value.replace(/^file:\/\//, "").replace(/^\//, "");
  },
  getWorkspaceFolder(uri: Uri): { uri: Uri; name: string; index: number } | undefined {
    const value = uri.toString();
    return workspace.workspaceFolders.find((folder) => {
      const base = folder.uri.toString().replace(/\/+$/, "");
      return value === base || value.startsWith(`${base}/`);
    });
  },
  /** Every file search, and the answer a test gives it (all of `files` by default). */
  findFilesCalls: [] as { include: string; exclude: string; max: number }[],
  findFilesAnswer: null as ((include: string) => Uri[]) | null,
  async findFiles(include: string, exclude: string, max: number): Promise<Uri[]> {
    workspace.findFilesCalls.push({ include, exclude, max });
    const all = workspace.findFilesAnswer?.(include) ?? Array.from(workspace.files.keys(), (key) => Uri.parse(key));
    return all.slice(0, max);
  },
  /** The open documents: a buffer over a file, which may hold unsaved edits. */
  documents: new Map<string, TextDocument>(),
  get textDocuments(): TextDocument[] {
    return Array.from(workspace.documents.values());
  },
  openTextDocument(uri: Uri): Promise<TextDocument> {
    const key = uri.toString();
    const open = workspace.documents.get(key);
    if (open) return Promise.resolve(open);
    const bytes = workspace.files.get(key);
    if (!bytes) return Promise.reject(new Error(`no document ${key}`));
    const document = new TextDocument(uri, new TextDecoder().decode(bytes));
    workspace.documents.set(key, document);
    return Promise.resolve(document);
  },
  /** The edits a test's code applied, in order; `applyEditAnswer` false makes the editor refuse. */
  appliedEdits: [] as WorkspaceEdit[],
  applyEditAnswer: true,
  async applyEdit(edit: WorkspaceEdit): Promise<boolean> {
    workspace.appliedEdits.push(edit);
    if (!workspace.applyEditAnswer) return false;
    for (const op of edit.operations) {
      const key = op.uri.toString();
      if (op.kind === "createFile") {
        if (workspace.files.has(key) && !op.ignoreIfExists) return false;
        if (!workspace.files.has(key)) workspace.files.set(key, new Uint8Array());
        continue;
      }
      if (op.kind === "deleteFile") {
        workspace.files.delete(key);
        workspace.documents.delete(key);
        continue;
      }
      const document = await workspace.openTextDocument(op.uri);
      document.splice(op.range, op.text);
    }
    return true;
  },
  fs: {
    async readFile(uri: Uri): Promise<Uint8Array> {
      const bytes = workspace.files.get(uri.toString());
      if (!bytes) throw new Error(`file not found: ${uri.toString()}`);
      return bytes;
    },
    async stat(uri: Uri): Promise<{ type: number; size: number }> {
      const bytes = workspace.files.get(uri.toString());
      if (!bytes) throw new Error(`file not found: ${uri.toString()}`);
      return { type: 1, size: bytes.byteLength };
    },
    async delete(uri: Uri): Promise<void> {
      workspace.files.delete(uri.toString());
    },
    async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
      workspace.files.set(uri.toString(), new Uint8Array(content));
    },
    async createDirectory(uri: Uri): Promise<void> {
      void uri;
      return undefined;
    },
    async readDirectory(uri: Uri): Promise<[string, number][]> {
      const base = uri.toString().replace(/\/+$/, "");
      const found = new Map<string, number>();
      for (const path of workspace.files.keys()) {
        if (!path.startsWith(`${base}/`)) continue;
        const rest = path.slice(base.length + 1);
        const slash = rest.indexOf("/");
        if (slash < 0) found.set(rest, 0);
        else found.set(rest.slice(0, slash), 2);
      }
      return Array.from(found, ([name, type]) => [name, type] as [string, number]);
    },
  },
};

export enum EndOfLine {
  LF = 1,
  CRLF = 2,
}

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

export class Range {
  constructor(
    readonly start: Position,
    readonly end: Position,
  ) {}
  get isEmpty(): boolean {
    return this.start.line === this.end.line && this.start.character === this.end.character;
  }
}

export class Selection extends Range {
  get isEmptySelection(): boolean {
    return this.isEmpty;
  }
}

/**
 * A document over a file: its text may run ahead of the file's bytes (the
 * unsaved edits a test makes with `type`), and `save` writes it back.
 */
export class TextDocument {
  private dirty = false;
  constructor(
    readonly uri: Uri,
    private text: string,
    readonly languageId = "plaintext",
  ) {}
  get isDirty(): boolean {
    return this.dirty;
  }
  get eol(): EndOfLine {
    return this.text.includes("\r\n") ? EndOfLine.CRLF : EndOfLine.LF;
  }
  get lineCount(): number {
    return this.text.split("\n").length;
  }
  getText(range?: Range): string {
    if (!range) return this.text;
    return this.text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
  }
  lineAt(line: number): { text: string; range: Range; rangeIncludingLineBreak: Range; firstNonWhitespaceCharacterIndex: number } {
    const lines = this.text.split("\n");
    const raw = lines[line] ?? "";
    const text = raw.replace(/\r$/, "");
    const last = line >= lines.length - 1;
    return {
      text,
      range: new Range(new Position(line, 0), new Position(line, text.length)),
      rangeIncludingLineBreak: new Range(new Position(line, 0), last ? new Position(line, text.length) : new Position(line + 1, 0)),
      firstNonWhitespaceCharacterIndex: /^\s*/.exec(text)?.[0].length ?? 0,
    };
  }
  offsetAt(position: Position): number {
    const lines = this.text.split("\n");
    let offset = 0;
    for (let i = 0; i < position.line && i < lines.length; i++) offset += (lines[i] ?? "").length + 1;
    return Math.min(offset + position.character, this.text.length);
  }
  positionAt(offset: number): Position {
    const before = this.text.slice(0, Math.max(0, Math.min(offset, this.text.length)));
    const lines = before.split("\n");
    return new Position(lines.length - 1, (lines.at(-1) ?? "").length);
  }
  /** An unsaved edit, as typing in the editor makes one. */
  type(text: string): void {
    this.text = text;
    this.dirty = true;
  }
  splice(range: Range, text: string): void {
    this.text = this.text.slice(0, this.offsetAt(range.start)) + text + this.text.slice(this.offsetAt(range.end));
    this.dirty = true;
  }
  async save(): Promise<boolean> {
    workspace.files.set(this.uri.toString(), new TextEncoder().encode(this.text));
    this.dirty = false;
    return true;
  }
}

type EditOperation =
  | { kind: "replace"; uri: Uri; range: Range; text: string }
  | { kind: "createFile"; uri: Uri; ignoreIfExists: boolean }
  | { kind: "deleteFile"; uri: Uri };

/** The edits the code under test asks the editor for, applied by `workspace.applyEdit`. */
export class WorkspaceEdit {
  readonly operations: EditOperation[] = [];
  replace(uri: Uri, range: Range, text: string): void {
    this.operations.push({ kind: "replace", uri, range, text });
  }
  insert(uri: Uri, position: Position, text: string): void {
    this.operations.push({ kind: "replace", uri, range: new Range(position, position), text });
  }
  createFile(uri: Uri, options: { ignoreIfExists?: boolean } = {}): void {
    this.operations.push({ kind: "createFile", uri, ignoreIfExists: options.ignoreIfExists === true });
  }
  deleteFile(uri: Uri, options: { ignoreIfNotExists?: boolean } = {}): void {
    void options;
    this.operations.push({ kind: "deleteFile", uri });
  }
}

export class CancellationTokenSource {
  readonly token = { isCancellationRequested: false };
  cancel(): void {
    this.token.isCancellationRequested = true;
  }
  dispose(): void {}
}

/** A QuickPick a test drives: it types with `type`, accepts with `accept`, escapes with `hide`. */
export class FakeQuickPick {
  title = "";
  placeholder = "";
  matchOnDescription = false;
  busy = false;
  items: { label: string }[] = [];
  selectedItems: { label: string }[] = [];
  shown = false;
  disposed = false;
  private readonly listeners = { value: [] as ((v: string) => void)[], accept: [] as (() => void)[], hide: [] as (() => void)[] };
  onDidChangeValue(listener: (value: string) => void) {
    this.listeners.value.push(listener);
    return { dispose() {} };
  }
  onDidAccept(listener: () => void) {
    this.listeners.accept.push(listener);
    return { dispose() {} };
  }
  onDidHide(listener: () => void) {
    this.listeners.hide.push(listener);
    return { dispose() {} };
  }
  show(): void {
    this.shown = true;
  }
  dispose(): void {
    this.disposed = true;
  }
  type(value: string): void {
    for (const listener of this.listeners.value) listener(value);
  }
  accept(item: { label: string }): void {
    this.selectedItems = [item];
    for (const listener of this.listeners.accept) listener();
  }
  hide(): void {
    for (const listener of this.listeners.hide) listener();
  }
}

/** An in-memory SecretStorage. */
export class MemorySecrets {
  readonly values = new Map<string, string>();
  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.values.get(key));
  }
  store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }
  onDidChange = () => ({ dispose() {} });
}

/** A fake webview: records what the host posts and lets a test send intents. */
export class FakeWebview {
  readonly posted: unknown[] = [];
  html = "";
  options: unknown = {};
  cspSource = "vscode-resource:";
  private listener: ((message: unknown) => void) | null = null;
  postMessage(message: unknown): Promise<boolean> {
    // Through structured clone, as the real channel does: what arrives is
    // data only, never a live reference into the host.
    this.posted.push(structuredClone(message));
    return Promise.resolve(true);
  }
  onDidReceiveMessage(listener: (message: unknown) => void) {
    this.listener = listener;
    return { dispose() {} };
  }
  asWebviewUri(uri: Uri): Uri {
    return Uri.parse(`vscode-webview-resource:${uri.toString()}`);
  }
  receive(message: unknown): void {
    this.listener?.(message);
  }
}
