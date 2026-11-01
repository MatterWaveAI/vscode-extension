import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { activate, exportsFor, type MatterWaveApi } from "../src/extension";
import type { Memento } from "../src/promptLibrary";
import { commands, ExtensionMode, FakeWebview, MemorySecrets, Uri, window, workspace } from "./vscode-mock";

function fakeMemento(): Memento & { synced: string[]; setKeysForSync(keys: readonly string[]): void } {
  const values = new Map<string, unknown>();
  const synced: string[] = [];
  return {
    synced,
    setKeysForSync(keys: readonly string[]) {
      synced.splice(0, synced.length, ...keys);
    },
    get<T>(key: string): T | undefined {
      return values.get(key) as T | undefined;
    },
    update(key: string, value: unknown): Promise<void> {
      values.set(key, value);
      return Promise.resolve();
    },
  };
}

function contextIn(mode: ExtensionMode): vscode.ExtensionContext {
  return {
    extensionMode: mode,
    extensionUri: Uri.file("/ext"),
    globalStorageUri: Uri.file("/storage"),
    secrets: new MemorySecrets(),
    globalState: fakeMemento(),
    workspaceState: fakeMemento(),
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

beforeEach(() => {
  commands.registered.clear();
  workspace.settings.clear();
  // A configured server keeps the first-run prompt out of these runs.
  workspace.settings.set("matterwave.baseUrl", "https://mw.test");
});

describe("activation", () => {
  it("asks nothing while activating, and asks for the server when the chat view first opens", async () => {
    workspace.settings.delete("matterwave.baseUrl");
    window.inputBoxes.length = 0;
    activate(contextIn(ExtensionMode.Production));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.inputBoxes).toEqual([]);

    const view = window.viewProviders["matterwave.chat"] as { resolveWebviewView(view: unknown): void };
    view.resolveWebviewView({ webview: new FakeWebview(), onDidDispose: () => ({ dispose() {} }), show() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.inputBoxes).toEqual(["MatterWave server"]);
  });

  it("lets Settings Sync carry the prompt library and the picked model, and nothing machine-bound", () => {
    const context = contextIn(ExtensionMode.Production);
    activate(context);
    expect((context.globalState as unknown as { synced: string[] }).synced).toEqual(["matterwave.prompts", "matterwave.model"]);
  });

  it("has a command to open the chat and one to show the request log", () => {
    activate(contextIn(ExtensionMode.Production));
    expect(commands.registered.has("matterwave.openChat")).toBe(true);
    expect(commands.registered.has("matterwave.showLog")).toBe(true);
    expect(window.channels.at(-1)?.name).toBe("MatterWave");
  });
});

describe("the extension's exports", () => {
  it("exports nothing in a production host, so no other extension can reach the chat", () => {
    const exported = activate(contextIn(ExtensionMode.Production));
    expect(exported).toBeUndefined();
    // The extension itself still came up: its commands are there.
    expect(commands.registered.has("matterwave.newChat")).toBe(true);
  });

  it("exports nothing in a development host either", () => {
    expect(activate(contextIn(ExtensionMode.Development))).toBeUndefined();
  });

  it("exports the chat seam under the test runner", () => {
    const exported = activate(contextIn(ExtensionMode.Test));
    expect(exported?.chat).toBeDefined();
    expect(typeof exported?.onHostMessage).toBe("function");
  });

  it("decides by the mode alone", () => {
    const api = {} as MatterWaveApi;
    expect(exportsFor(vscode.ExtensionMode.Production, api)).toBeUndefined();
    expect(exportsFor(vscode.ExtensionMode.Development, api)).toBeUndefined();
    expect(exportsFor(vscode.ExtensionMode.Test, api)).toBe(api);
  });
});
