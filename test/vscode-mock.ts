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
};

export const commands = {
  executed: [] as string[],
  executeCommand(id: string): Promise<void> {
    commands.executed.push(id);
    return Promise.resolve();
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
