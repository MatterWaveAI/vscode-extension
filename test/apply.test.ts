import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { commands, window, workspace } from "./vscode-mock";
import { APPLY_SCHEME, applyToFile, registerApplyContentProvider } from "../src/apply";

const FILE = vscode.Uri.file("/workspace/src/a.ts");

function answers(...values: unknown[]): void {
  window.informationAnswers.push(...values);
}

beforeEach(() => {
  workspace.files.clear();
  window.informationAnswers.length = 0;
  window.shownDocuments.length = 0;
  commands.executed.length = 0;
  commands.commandArgs.length = 0;
  workspace.workspaceFolders = [{ uri: vscode.Uri.file("/workspace"), name: "workspace", index: 0 }];
  registerApplyContentProvider();
});

describe("applyToFile", () => {
  it("shows a diff of the file against the new code and writes on Apply", async () => {
    workspace.files.set(FILE.toString(), new TextEncoder().encode("old code\n"));
    answers("Apply");
    const written = await applyToFile(FILE, "new code\n", { title: "src/a.ts — reviewed change" });

    expect(written).toBe(true);
    expect(new TextDecoder().decode(workspace.files.get(FILE.toString()))).toBe("new code\n");
    expect(commands.executed).toContain("vscode.diff");
    const [left, right, title] = commands.commandArgs.at(-1) as unknown[];
    expect(left).toBe(FILE);
    expect((right as vscode.Uri).scheme).toBe(APPLY_SCHEME);
    expect(title).toBe("src/a.ts — reviewed change");
    // The preview serves the new code through the registered provider.
    const provider = workspace.contentProviders[APPLY_SCHEME] as { provideTextDocumentContent(uri: vscode.Uri): string };
    expect(provider.provideTextDocumentContent(right as vscode.Uri)).toBe("new code\n");
    // The lint hook reopened the file so diagnostics refresh.
    expect(window.shownDocuments).toHaveLength(1);
  });

  it("writes nothing when the person keeps the file as it was", async () => {
    workspace.files.set(FILE.toString(), new TextEncoder().encode("old code\n"));
    answers(undefined);
    const written = await applyToFile(FILE, "new code\n", { title: "t" });

    expect(written).toBe(false);
    expect(new TextDecoder().decode(workspace.files.get(FILE.toString()))).toBe("old code\n");
    expect(window.shownDocuments).toHaveLength(0);
  });

  it("is a no-op when the file already has this code", async () => {
    workspace.files.set(FILE.toString(), new TextEncoder().encode("same\n"));
    const written = await applyToFile(FILE, "same\n", { title: "t" });

    expect(written).toBe(false);
    expect(commands.executed).not.toContain("vscode.diff");
    expect(window.shown.at(-1)?.message).toContain("already has this code");
  });

  it("creates a new file from the empty side of the diff, snapshot null", async () => {
    const seen: (string | null)[] = [];
    answers("Apply");
    const written = await applyToFile(FILE, "brand new\n", { title: "t", onSnapshot: async (before) => void seen.push(before) });

    expect(written).toBe(true);
    expect(seen).toEqual([null]);
    expect(new TextDecoder().decode(workspace.files.get(FILE.toString()))).toBe("brand new\n");
    const [left] = commands.commandArgs.at(-1) as unknown[];
    expect((left as vscode.Uri).scheme).toBe(APPLY_SCHEME);
  });

  it("hands the snapshot the file's current contents, before the write", async () => {
    workspace.files.set(FILE.toString(), new TextEncoder().encode("old code\n"));
    const seen: (string | null)[] = [];
    answers("Apply");
    await applyToFile(FILE, "new code\n", { title: "t", onSnapshot: async (before) => void seen.push(before) });

    expect(seen).toEqual(["old code\n"]);
  });

  it("skips the lint hook when asked to", async () => {
    answers("Apply");
    await applyToFile(FILE, "code\n", { title: "t", lint: false });
    expect(window.shownDocuments).toHaveLength(0);
  });
});
