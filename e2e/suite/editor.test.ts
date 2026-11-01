/// <reference types="mocha" />
import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { applyToFile } from "../../src/apply";

/**
 * The extension's edits inside a real editor, in the two-folder workspace
 * e2e/run.mjs makes for the run. What is checked here is what the unit
 * tests' vscode mock cannot show: an edit landing in the editor's buffer
 * beside unsaved edits, the document's own undo, a save that meets no
 * conflict, and a file made by the editor's file service.
 *
 * The apply path is imported from the source, the same module the
 * extension runs, and its dialogs are answered in the person's place.
 */

/** The editor's prompt functions are plain properties of the API object handed to this extension. */
const window = vscode.window as unknown as Record<string, unknown>;

async function withStub<T>(name: string, stub: unknown, work: () => Thenable<T>): Promise<T> {
  const original = window[name];
  window[name] = stub;
  try {
    return await work();
  } finally {
    window[name] = original;
  }
}

/** Answers Apply to the apply dialog and nothing to anything else. */
const applyAnswer = async (message: string) => (message.startsWith("Apply this code") ? "Apply" : undefined);

function folder(name: string): vscode.WorkspaceFolder {
  const found = vscode.workspace.workspaceFolders?.find((f) => f.name === name);
  assert.ok(found, `the run's workspace has a folder named ${name}`);
  return found;
}

async function disk(uri: vscode.Uri): Promise<string> {
  return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

async function writeDisk(uri: vscode.Uri, text: string): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
}

describe("applying code in a real editor", function () {
  afterEach(async function () {
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  it("changes a document with unsaved edits in its buffer, keeps undo, and saves without a conflict", async function () {
    const uri = vscode.Uri.joinPath(folder("alpha").uri, "src", "dirty.ts");
    await writeDisk(uri, "saved\n");
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document);
    await editor.edit((edit) => edit.replace(document.validateRange(new vscode.Range(0, 0, document.lineCount, 0)), "unsaved\nkept\n"));
    assert.equal(document.isDirty, true, "the document holds an unsaved edit");

    const snapshots: (string | null)[] = [];
    const applied = await withStub("showInformationMessage", applyAnswer, () =>
      applyToFile(uri, "unsaved\nchanged\n", { title: "e2e", lint: false, onSnapshot: (before) => void snapshots.push(before) }),
    );

    assert.equal(applied, true);
    assert.deepEqual(snapshots, ["unsaved\nkept\n"], "the checkpoint is the buffer, unsaved edit included");
    assert.equal(document.getText(), "unsaved\nchanged\n", "the change landed in the buffer");
    assert.equal(document.isDirty, true, "the person's unsaved edits are still theirs to save");
    assert.equal(await disk(uri), "saved\n", "nothing was written behind the editor's back");

    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand("undo");
    assert.equal(document.getText(), "unsaved\nkept\n", "Undo takes the applied change back, and only it");
    await vscode.commands.executeCommand("redo");
    assert.equal(document.getText(), "unsaved\nchanged\n");

    assert.equal(await document.save(), true, "the save meets no conflict");
    assert.equal(await disk(uri), "unsaved\nchanged\n");
  });

  it("saves a document that had no unsaved edits, and Undo still takes the change back", async function () {
    const uri = vscode.Uri.joinPath(folder("alpha").uri, "src", "clean.ts");
    await writeDisk(uri, "one\ntwo\nthree\n");
    const applied = await withStub("showInformationMessage", applyAnswer, () =>
      applyToFile(uri, "one\nTWO\nthree\n", { title: "e2e", lint: false }),
    );
    assert.equal(applied, true);
    const document = await vscode.workspace.openTextDocument(uri);
    assert.equal(document.isDirty, false);
    assert.equal(await disk(uri), "one\nTWO\nthree\n");

    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand("undo");
    assert.equal(document.getText(), "one\ntwo\nthree\n");
  });

  it("creates a new file, and the directories it needs, through the editor", async function () {
    const uri = vscode.Uri.joinPath(folder("alpha").uri, "fresh", "deeper", "made.ts");
    const snapshots: (string | null)[] = [];
    const applied = await withStub("showInformationMessage", applyAnswer, () =>
      applyToFile(uri, "export const made = true;\n", { title: "e2e", lint: false, onSnapshot: (before) => void snapshots.push(before) }),
    );
    assert.equal(applied, true);
    assert.deepEqual(snapshots, [null], "a new file's checkpoint says it was new");
    assert.equal(await disk(uri), "export const made = true;\n");
  });

  it("applies nothing when the person keeps the file as it was", async function () {
    const uri = vscode.Uri.joinPath(folder("alpha").uri, "src", "kept.ts");
    await writeDisk(uri, "as it was\n");
    const applied = await withStub("showInformationMessage", async () => undefined, () =>
      applyToFile(uri, "something else\n", { title: "e2e", lint: false }),
    );
    assert.equal(applied, false);
    assert.equal((await vscode.workspace.openTextDocument(uri)).getText(), "as it was\n");
    assert.equal(await disk(uri), "as it was\n");
  });
});
