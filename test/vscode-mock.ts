/**
 * The slice of the `vscode` module the code under test touches, aliased in
 * vitest.config.ts. Only what a test needs is here; anything else throws
 * by being undefined, which is the point -- a test reaching for an API this
 * mock does not model should fail loudly rather than pass against a stub.
 */

export class Uri {
  private constructor(readonly path: string) {}
  static parse(value: string): Uri {
    return new Uri(value);
  }
  static file(path: string): Uri {
    return new Uri(`file://${path}`);
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri([base.path.replace(/\/+$/, ""), ...segments].join("/"));
  }
  /** The scheme of the URI: what names the document's source. */
  get scheme(): string {
    return /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(this.path)?.[1] ?? "file";
  }
  toString(): string {
    return this.path;
  }
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
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
};

export const commands = {
  executed: [] as string[],
  /** The arguments of each executeCommand, parallel to `executed`. */
  commandArgs: [] as unknown[][],
  executeCommand(id: string, ...rest: unknown[]): Promise<void> {
    commands.executed.push(id);
    commands.commandArgs.push(rest);
    return Promise.resolve();
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
  registerTextDocumentContentProvider(scheme: string, provider: unknown): { dispose(): void } {
    workspace.contentProviders[scheme] = provider;
    return { dispose() {} };
  },
  asRelativePath(uri: Uri): string {
    const value = uri.toString();
    for (const folder of workspace.workspaceFolders) {
      const base = folder.uri.toString().replace(/\/+$/, "");
      if (value.startsWith(`${base}/`)) return value.slice(base.length + 1);
    }
    return value.replace(/^file:\/\//, "").replace(/^\//, "");
  },
  openTextDocument(uri: Uri): Promise<{ uri: Uri }> {
    if (!workspace.files.has(uri.toString())) return Promise.reject(new Error(`no document ${uri.toString()}`));
    return Promise.resolve({ uri });
  },
  fs: {
    async readFile(uri: Uri): Promise<Uint8Array> {
      const bytes = workspace.files.get(uri.toString());
      if (!bytes) throw new Error(`file not found: ${uri.toString()}`);
      return bytes;
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
