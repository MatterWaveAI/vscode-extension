/// <reference types="mocha" />
import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { applyToFile } from "../../src/apply";
import { createFetch } from "../../src/api/transport";
import { CheckpointStore } from "../../src/checkpoints";
import { commitMessagePrompt, gitApi, repositoryFor } from "../../src/commitMessage";
import { searchWorkspaceFiles } from "../../src/fileSearch";
import { snapshotFolder } from "../../src/snapshotFiles";
import { editorFolders, resolveNamedFile } from "../../src/targets";
import { copyTerminalText, terminalCommandPrompt, TerminalHistory, terminalText } from "../../src/terminalOutput";

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

describe("activation in a real editor", function () {
  it("stays inactive at start-up, and activates on its first command", async function () {
    const extension = vscode.extensions.getExtension("matterwave.matterwave");
    assert.ok(extension, "the extension under development is installed");
    assert.equal(extension.isActive, false, "nothing runs until MatterWave is used");
    await vscode.commands.executeCommand("matterwave.showLog");
    assert.equal(extension.isActive, true);
  });
});

describe("the lightbulb in a real editor", function () {
  it("offers a MatterWave Fix for a reported problem, and Explain, Tests and Docs for a selection", async function () {
    await vscode.commands.executeCommand("matterwave.showLog");
    const uri = vscode.Uri.joinPath(folder("alpha").uri, "src", "shared.ts");
    await vscode.workspace.openTextDocument(uri);
    const problems = vscode.languages.createDiagnosticCollection("e2e");
    try {
      const range = new vscode.Range(0, 7, 0, 12);
      problems.set(uri, [new vscode.Diagnostic(range, "Unexpected const.", vscode.DiagnosticSeverity.Error)]);
      const atProblem = await vscode.commands.executeCommand<vscode.CodeAction[]>("vscode.executeCodeActionProvider", uri, range);
      const fix = atProblem.find((a) => a.title === "Fix with MatterWave: Unexpected const.");
      assert.ok(fix, `offered: ${atProblem.map((a) => a.title).join(", ")}`);
      assert.equal(fix.command?.command, "matterwave.fixProblem");

      const selection = new vscode.Range(0, 0, 0, 20);
      problems.clear();
      const titles = (await vscode.commands.executeCommand<vscode.CodeAction[]>("vscode.executeCodeActionProvider", uri, selection)).map((a) => a.title);
      for (const title of ["Explain with MatterWave", "Generate Tests with MatterWave", "Add Docs with MatterWave"]) {
        assert.ok(titles.includes(title), `${title} in ${titles.join(", ")}`);
      }
    } finally {
      problems.dispose();
    }
  });
});

describe("commit messages in a real editor", function () {
  it("reads the staged diff of the repository whose title bar was clicked, through the Git extension", async function () {
    const api = await gitApi();
    assert.ok(api, "the built-in Git extension is enabled");
    const beta = folder("beta").uri;
    await waitFor("the Git extension to open the repository", () => api.getRepository(beta) ?? undefined, 30_000);
    const repository = await repositoryFor(api, { rootUri: beta });
    assert.ok(repository);
    const diff = await repository.diff(true);
    assert.match(diff, /\+export const staged = true;/);
    assert.match(commitMessagePrompt(diff, ""), /```diff\n[\s\S]*src\/staged\.ts/);
    repository.inputBox.value = "Stage the flag";
    assert.equal(repository.inputBox.value, "Stage the flag");
    repository.inputBox.value = "";
  });
});

describe("finding a workspace file in a real editor", function () {
  it("reaches a file past any fixed count by searching for it, whatever its case", async function () {
    const found = await searchWorkspaceFiles("FILE-0599");
    assert.deepEqual(
      found.map((uri) => vscode.workspace.asRelativePath(uri, true)),
      ["alpha/many/file-0599.ts"],
    );
  });

  it("finds the files under a directory whose name was typed, and a path across folders", async function () {
    const underMany = await searchWorkspaceFiles("many");
    assert.ok(underMany.length > 100, `files under many/ (found ${underMany.length})`);
    assert.ok(underMany.every((uri) => uri.path.includes("/many/")));
    const shared = (await searchWorkspaceFiles("src/shared")).map((uri) => vscode.workspace.asRelativePath(uri, true));
    assert.deepEqual(shared.sort(), ["alpha/src/shared.ts", "beta/src/shared.ts"]);
  });
});

async function waitFor<T>(what: string, check: () => T | undefined | null | false, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("reading a terminal in a real editor", function () {
  let history: TerminalHistory;
  before(function () {
    history = new TerminalHistory();
  });
  after(function () {
    history.dispose();
  });

  it("keeps a command's output and exit code through shell integration", async function () {
    const terminal = vscode.window.createTerminal({ name: "e2e shell" });
    try {
      terminal.show();
      const integration = await waitFor("shell integration", () => terminal.shellIntegration, 45_000);
      integration.executeCommand("echo mw-e2e-marker");
      const record = await waitFor("the command to finish", () => {
        const last = history.last(terminal);
        return last?.done && last.output.includes("mw-e2e-marker") ? last : undefined;
      });
      assert.equal(record.exitCode, 0);
      const text = await terminalText(history, terminal);
      assert.match(text ?? "", /\$ echo mw-e2e-marker/);
      assert.match(text ?? "", /\[exit code 0\]/);
    } finally {
      terminal.dispose();
    }
  });

  it("sees a failed command's exit code, which is what Fix is asked about", async function () {
    const terminal = vscode.window.createTerminal({ name: "e2e failing" });
    try {
      terminal.show();
      const integration = await waitFor("shell integration", () => terminal.shellIntegration, 45_000);
      integration.executeCommand("git --no-such-option");
      const record = await waitFor("the command to finish", () => {
        const last = history.last(terminal);
        return last?.done ? last : undefined;
      });
      assert.notEqual(record.exitCode, 0);
      const prompt = terminalCommandPrompt("fix", terminal.name, record);
      assert.match(prompt, /\$ git --no-such-option/);
      assert.match(prompt, /\[exit code [1-9][0-9]*\]/);
    } finally {
      terminal.dispose();
    }
  });

  it("copies the buffer of a terminal shell integration does not cover, and keeps the clipboard", async function () {
    const write = new vscode.EventEmitter<string>();
    const terminal = vscode.window.createTerminal({
      name: "e2e plain",
      pty: { onDidWrite: write.event, open: () => write.fire("plain-buffer-marker\r\n"), close: () => undefined },
    });
    try {
      terminal.show();
      await vscode.env.clipboard.writeText("what the person had copied");
      // The pseudoterminal writes when it opens; give the renderer a moment to draw it.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const text = await copyTerminalText(terminal);
      assert.match(text ?? "", /plain-buffer-marker/);
      assert.equal(await vscode.env.clipboard.readText(), "what the person had copied");
    } finally {
      terminal.dispose();
      write.dispose();
    }
  });
});

describe("a private CA behind an authenticating proxy", function () {
  // From e2e/run.mjs: an HTTPS server signed by a throwaway CA, and the
  // proxy in front of it that this editor's http.proxy names.
  const target = process.env.E2E_TLS_TARGET ?? "";
  const caFile = process.env.E2E_TLS_CA ?? "";
  const statsUrl = process.env.E2E_PROXY_STATS ?? "";

  async function proxyStats(): Promise<{ tunnels: number; refused: number }> {
    return (await fetch(statsUrl)).json() as Promise<{ tunnels: number; refused: number }>;
  }

  before(function () {
    if (!target) this.skip();
  });

  it("reaches the server through the editor's proxy, trusting matterwave.caFile on top of the system's roots", async function () {
    const before = await proxyStats();
    const send = createFetch(() => caFile);
    const response = await send(`${target}/api/me`, { headers: { accept: "application/json" } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { through: "target", path: "/api/me" });
    const after = await proxyStats();
    assert.equal(after.tunnels, before.tunnels + 1, "the request went through the proxy's tunnel, credentials and all");
  });

  it("goes through the same proxy without a CA file, and refuses the private CA in words that name the setting", async function () {
    const before = await proxyStats();
    const send = createFetch(() => "");
    await assert.rejects(send(`${target}/api/me`, {}), (error: Error) => error.message.includes("matterwave.caFile"));
    const after = await proxyStats();
    assert.equal(after.tunnels, before.tunnels + 1, "the host's own fetch followed http.proxy");
  });
});

describe("checkpoints in a real editor", function () {
  it("keeps snapshots as files in a storage folder, not in the editor's state", async function () {
    const storage = vscode.Uri.joinPath(folder("alpha").uri, ".storage", "checkpoints");
    const values = new Map<string, unknown>();
    const state = {
      get: <T>(key: string) => values.get(key) as T | undefined,
      update: async (key: string, value: unknown) => void values.set(key, value),
    };
    const store = new CheckpointStore(state, snapshotFolder(storage));
    const row = await store.record("c_e2e", { uri: "file:///x.ts", path: "x.ts" }, "the text before\n", "Apply");
    assert.ok(row);
    assert.equal(await disk(vscode.Uri.joinPath(storage, `${row.id}.txt`)), "the text before\n");
    assert.equal(await store.content(row.id), "the text before\n");
    assert.ok(!JSON.stringify([...values.values()]).includes("the text before"), "the index holds no snapshot text");
    await store.remove(row.id);
    assert.deepEqual(await vscode.workspace.fs.readDirectory(storage), []);
  });
});

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

  it("applies a path both folders have to the folder of the file the person is in", async function () {
    const beta = vscode.Uri.joinPath(folder("beta").uri, "src", "shared.ts");
    const alpha = vscode.Uri.joinPath(folder("alpha").uri, "src", "shared.ts");
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(beta));

    const named = await resolveNamedFile("src/shared.ts", editorFolders());
    assert.equal(named.kind, "file");
    if (named.kind !== "file") return;
    assert.equal(named.uri.toString(), beta.toString(), "the second folder's file, not the first's");
    assert.equal(vscode.workspace.asRelativePath(named.uri, true), "beta/src/shared.ts");

    const applied = await withStub("showInformationMessage", applyAnswer, () =>
      applyToFile(named.uri, 'export const where = "beta, applied";\n', { title: "e2e", lint: false }),
    );
    assert.equal(applied, true);
    assert.equal(await disk(beta), 'export const where = "beta, applied";\n');
    assert.equal(await disk(alpha), 'export const where = "alpha";\n', "the first folder's file is untouched");
  });

  it("follows a path that names the folder, and refuses one that climbs out of every folder", async function () {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const named = await resolveNamedFile("alpha/src/shared.ts", editorFolders());
    assert.equal(named.kind === "file" && named.uri.toString(), vscode.Uri.joinPath(folder("alpha").uri, "src", "shared.ts").toString());
    assert.deepEqual(await resolveNamedFile("alpha/../../outside.ts", editorFolders()), { kind: "outside" });
    assert.deepEqual(await resolveNamedFile("..\\..\\outside.ts", editorFolders()), { kind: "outside" });
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
