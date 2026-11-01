import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { activate, exportsFor, type MatterWaveApi } from "../src/extension";
import type { Memento } from "../src/promptLibrary";
import { commands, ExtensionMode, MemorySecrets, Uri, workspace } from "./vscode-mock";

function fakeMemento(): Memento {
  const values = new Map<string, unknown>();
  return {
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
