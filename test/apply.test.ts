import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { commands, EndOfLine, window, workspace, type WorkspaceEdit } from "./vscode-mock";
import { APPLY_SCHEME, applyToFile, minimalChange, registerApplyContentProvider, withEol } from "../src/apply";

const FILE = vscode.Uri.file("/workspace/src/a.ts");

function answers(...values: unknown[]): void {
  window.informationAnswers.push(...values);
}

beforeEach(() => {
  workspace.files.clear();
  workspace.documents.clear();
  workspace.appliedEdits.length = 0;
  workspace.applyEditAnswer = true;
  window.shown.length = 0;
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

  it("diffs against the unsaved buffer and changes it in place, leaving the person's edits unsaved", async () => {
    workspace.files.set(FILE.toString(), new TextEncoder().encode("saved\n"));
    const document = await workspace.openTextDocument(FILE);
    document.type("unsaved line\nkept\n");
    const seen: (string | null)[] = [];
    answers("Apply");
    const written = await applyToFile(FILE, "unsaved line\nchanged\n", { title: "t", onSnapshot: (before) => void seen.push(before) });

    expect(written).toBe(true);
    // The checkpoint is what the buffer held, not the file on disk.
    expect(seen).toEqual(["unsaved line\nkept\n"]);
    expect(document.getText()).toBe("unsaved line\nchanged\n");
    // Nothing was written behind the editor's back: the file is as last saved, the buffer still dirty.
    expect(new TextDecoder().decode(workspace.files.get(FILE.toString()))).toBe("saved\n");
    expect(document.isDirty).toBe(true);
  });

  it("goes through one workspace edit over the range that differs", async () => {
    workspace.files.set(FILE.toString(), new TextEncoder().encode("one\ntwo\nthree\n"));
    answers("Apply");
    await applyToFile(FILE, "one\nTWO\nthree\n", { title: "t" });

    expect(workspace.appliedEdits).toHaveLength(1);
    const [op] = (workspace.appliedEdits[0] as WorkspaceEdit).operations;
    expect(op).toMatchObject({ kind: "replace", text: "TWO" });
    if (op?.kind !== "replace") throw new Error("expected a replace");
    expect([op.range.start.line, op.range.start.character, op.range.end.line, op.range.end.character]).toEqual([1, 0, 1, 3]);
  });

  it("saves a document that had no unsaved edits, as an apply always left the file", async () => {
    workspace.files.set(FILE.toString(), new TextEncoder().encode("old\n"));
    answers("Apply");
    await applyToFile(FILE, "new\n", { title: "t" });

    const document = await workspace.openTextDocument(FILE);
    expect(document.isDirty).toBe(false);
    expect(new TextDecoder().decode(workspace.files.get(FILE.toString()))).toBe("new\n");
  });

  it("applies nothing when the buffer changed while the diff was open", async () => {
    workspace.files.set(FILE.toString(), new TextEncoder().encode("old\n"));
    const document = await workspace.openTextDocument(FILE);
    const original = window.showInformationMessage;
    window.showInformationMessage = function (message: string, ...rest: unknown[]) {
      if (message.startsWith("Apply this code")) document.type("typed during the review\n");
      return original.call(window, message, ...rest);
    };
    try {
      answers("Apply");
      expect(await applyToFile(FILE, "new\n", { title: "t" })).toBe(false);
    } finally {
      window.showInformationMessage = original;
    }
    expect(document.getText()).toBe("typed during the review\n");
    expect(workspace.appliedEdits).toHaveLength(0);
    expect(window.shown.at(-1)?.message).toContain("changed while the diff was open");
  });

  it("keeps a CRLF document's line endings", async () => {
    workspace.files.set(FILE.toString(), new TextEncoder().encode("a\r\nb\r\n"));
    answers("Apply");
    await applyToFile(FILE, "a\nc\n", { title: "t" });

    expect(new TextDecoder().decode(workspace.files.get(FILE.toString()))).toBe("a\r\nc\r\n");
  });

  it("treats code that differs only in line endings as already applied", async () => {
    workspace.files.set(FILE.toString(), new TextEncoder().encode("a\r\nb\r\n"));
    expect(await applyToFile(FILE, "a\nb\n", { title: "t" })).toBe(false);
    expect(window.shown.at(-1)?.message).toContain("already has this code");
  });

  it("says so, and changes nothing, when the editor refuses the edit", async () => {
    workspace.files.set(FILE.toString(), new TextEncoder().encode("old\n"));
    workspace.applyEditAnswer = false;
    answers("Apply");
    expect(await applyToFile(FILE, "new\n", { title: "t" })).toBe(false);
    expect(window.shown.at(-1)?.message).toContain("could not be changed");
    expect(new TextDecoder().decode(workspace.files.get(FILE.toString()))).toBe("old\n");
  });
});

describe("minimalChange", () => {
  it("keeps the common prefix and suffix", () => {
    expect(minimalChange("abcXYZdef", "abc123def")).toEqual({ start: 3, end: 6, text: "123" });
  });

  it("is an insertion or a deletion where one side is empty", () => {
    expect(minimalChange("ab", "aXb")).toEqual({ start: 1, end: 1, text: "X" });
    expect(minimalChange("aXb", "ab")).toEqual({ start: 1, end: 2, text: "" });
    expect(minimalChange("", "new")).toEqual({ start: 0, end: 0, text: "new" });
  });

  it("is empty for equal text", () => {
    expect(minimalChange("same", "same")).toEqual({ start: 4, end: 4, text: "" });
  });
});

describe("withEol", () => {
  it("rewrites every ending to the document's", () => {
    expect(withEol("a\nb\r\nc\rd", EndOfLine.CRLF)).toBe("a\r\nb\r\nc\r\nd");
    expect(withEol("a\r\nb", EndOfLine.LF)).toBe("a\nb");
  });
});
