/// <reference types="mocha" />
import * as assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import * as vscode from "vscode";
import type { MatterWaveApi } from "../../src/extension";

/**
 * Agent mode in a real editor, against a scripted fake `/v1` this suite
 * serves from inside the extension host: the model "proposes" an edit, and
 * the editor's own diff, WorkspaceEdit and undo do the rest. No deployment,
 * no credential: e2e/run.mjs opens a scratch folder as the workspace.
 */

const EXTENSION_ID = "matterwave.matterwave";
const WORKSPACE = process.env.E2E_WORKSPACE ?? "";
const FILE = "src/greet.ts";
const ORIGINAL = 'export function greet(name: string): string {\r\n  return "Hello, " + name;\r\n}\r\n';

type Step = Record<string, unknown>[];

/** The fake deployment: just enough of `/api` to sign in, and a `/v1` that answers from a script. */
class FakeDeployment {
  private server: Server | null = null;
  readonly script: Step[] = [];
  readonly v1Bodies: Record<string, unknown>[] = [];

  async start(): Promise<string> {
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
    const url = new URL(request.url ?? "/", "http://fake");
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json", "X-Request-Id": "req-e2e" });
      response.end(JSON.stringify(value));
    };
    const route = `${request.method} ${url.pathname}`;
    if (route === "GET /api/me") return json({ subject: "e2e", kind: "user", email: "e2e@example.com", name: "E2E", roles: [], org_id: "o", org_name: "E2E", org_role: "member", local_agent_tools: true });
    if (route === "GET /api/models") {
      return json({
        default_model: "grt-e2e",
        data: [{ id: "grt-e2e", label: "GRT E2E", included: true, upgrade_to: null, partner: false, research_preview: false, supports_vision: false, supports_tools: true, context_window: 32768 }],
      });
    }
    if (route === "GET /api/conversations") return json({ data: [], filter: url.searchParams.get("filter") ?? "default" });
    if (route === "POST /api/conversations") {
      return json({ id: "c_e2e", title: "Agent run", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_message_at: null, default_model: null, current_leaf_message_id: null, pinned_at: null, archived_at: null }, 201);
    }
    if (route === "POST /v1/chat/completions") {
      this.v1Bodies.push(body);
      const step = this.script.shift() ?? [{ choices: [{ index: 0, delta: { content: "Done." } }] }];
      response.writeHead(200, { "Content-Type": "text/event-stream", "X-Request-Id": "req-v1" });
      for (const chunk of step) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      response.end("data: [DONE]\n\n");
      return;
    }
    json({ detail: `no route ${route}` }, 404);
  }
}

function editCall(oldString: string, newString: string): Step {
  return [
    {
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, id: "call_edit", type: "function", function: { name: "edit", arguments: JSON.stringify({ path: FILE, old_string: oldString, new_string: newString }) } }] },
        },
      ],
    },
  ];
}

async function waitFor(what: string, check: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

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

function proposalTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.scheme === "matterwave-proposal");
}

describe("agent mode in a real editor, against a scripted /v1", function () {
  this.timeout(120_000);
  const fake = new FakeDeployment();
  const target = path.join(WORKSPACE, ...FILE.split("/"));
  let api: MatterWaveApi;

  before(async function () {
    assert.ok(WORKSPACE, "E2E_WORKSPACE comes from e2e/run.mjs");
    assert.equal(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath.toLowerCase(), vscode.Uri.file(WORKSPACE).fsPath.toLowerCase());
    assert.equal(vscode.workspace.isTrusted, true);
    const baseUrl = await fake.start();
    const extension = vscode.extensions.getExtension<MatterWaveApi>(EXTENSION_ID);
    assert.ok(extension);
    api = await extension.activate();
    const settings = vscode.workspace.getConfiguration("matterwave");
    await settings.update("baseUrl", baseUrl, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration("matterwave.agent").update("matterwaveMcp", false, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand("matterwave.signOut");
    await withStub("showInputBox", async () => "mw_e2e_fake_key", () => vscode.commands.executeCommand("matterwave.signInWithApiKey"));
    await waitFor("the signed-in state", () => api.chat.snapshot().signedIn && api.chat.snapshot().model?.id === "grt-e2e");
    await api.chat.toggleAgent(true);
    const agent = api.chat.snapshot().agent;
    assert.ok(agent?.enabled && agent.available, `the agent is available: ${agent?.reason ?? ""}`);
    assert.equal(agent.mode, "ask");
  });

  after(async function () {
    await vscode.commands.executeCommand("matterwave.signOut");
    await vscode.workspace.getConfiguration("matterwave").update("baseUrl", undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration("matterwave.agent").update("matterwaveMcp", undefined, vscode.ConfigurationTarget.Global);
    await fake.stop();
  });

  beforeEach(async function () {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    // A document an earlier test left loaded is reset through the editor: the
    // agent reads an open document, and a write to the disk alone reaches it
    // only when the file watcher gets round to it.
    const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && d.uri.fsPath.toLowerCase() === target.toLowerCase());
    if (open && open.getText() !== ORIGINAL) {
      const reset = new vscode.WorkspaceEdit();
      reset.replace(open.uri, new vscode.Range(open.positionAt(0), open.positionAt(open.getText().length)), ORIGINAL);
      assert.ok(await vscode.workspace.applyEdit(reset));
      await open.save();
    }
    // Windows may hold the file for a moment after the editor's save.
    for (let attempt = 0; readFileSync(target, "utf8") !== ORIGINAL; attempt++) {
      try {
        writeFileSync(target, ORIGINAL);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EBUSY" || attempt > 50) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    // Each test is its own conversation.
    api.chat.newChat();
  });

  it("opens the native diff for an edit, and Reject leaves the file byte-identical", async function () {
    fake.script.push(editCall('"Hello, "', '"Hi, "'));
    const run = api.chat.send("Make the greeting shorter.");
    await waitFor("the approval", () => api.agent.pendingId() !== null);
    await waitFor("the diff tab", () => proposalTabs().length === 1);
    // Nothing is written while the change is under review.
    assert.deepEqual(readFileSync(target), Buffer.from(ORIGINAL));
    // The /v1 request carried the contract's tools and the conversation.
    const body = fake.v1Bodies.at(-1)!;
    assert.deepEqual((body.metadata as { conversation_id: string }).conversation_id, "c_e2e");
    assert.ok((body.tools as { function: { name: string } }[]).some((t) => t.function.name === "edit"));
    await vscode.commands.executeCommand("matterwave.agent.reject");
    await run;
    assert.deepEqual(readFileSync(target), Buffer.from(ORIGINAL), "Reject leaves the file byte-identical");
    assert.equal(proposalTabs().length, 0, "the diff is closed");
    const result = api.chat.snapshot().transcript.at(-1)!.message.parts.find((p) => p.type === "tool_result");
    assert.ok(result && result.type === "tool_result" && result.output.includes("rejected the change"));
  });

  it("applies an accepted change through a WorkspaceEdit, and Ctrl+Z (undo) restores the file", async function () {
    fake.script.push(editCall('"Hello, "', '"Hi, "'));
    const run = api.chat.send("Make the greeting shorter.");
    await waitFor("the approval", () => api.agent.pendingId() !== null);
    await waitFor("the diff tab", () => proposalTabs().length === 1);
    await vscode.commands.executeCommand("matterwave.agent.accept");
    await run;
    const changed = ORIGINAL.replace('"Hello, "', '"Hi, "');
    assert.equal(readFileSync(target, "utf8"), changed, "the accepted change is on disk");
    const document = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
    await vscode.commands.executeCommand("undo");
    await waitFor("the undo", () => document.getText() === ORIGINAL, 10_000);
    await document.save();
    assert.deepEqual(readFileSync(target), Buffer.from(ORIGINAL), "undo brings the original bytes back");
  });

  it("creates a new file, folders and all, from an accepted write_file", async function () {
    const created = path.join(WORKSPACE, "src", "lib", "deep", "util.ts");
    const content = "export const answer = 42;\n";
    fake.script.push([
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: "call_write", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "src/lib/deep/util.ts", content }) } }] },
          },
        ],
      },
    ]);
    const run = api.chat.send("Add a util module.");
    await waitFor("the approval", () => api.agent.pendingId() !== null);
    assert.equal(api.chat.snapshot().agent?.pending?.title, "Create src/lib/deep/util.ts");
    await vscode.commands.executeCommand("matterwave.agent.accept");
    await run;
    assert.equal(readFileSync(created, "utf8"), content);
  });

  it("writes the person's version when they edit the proposal before accepting", async function () {
    fake.script.push(editCall('"Hello, "', '"Hi, "'));
    const run = api.chat.send("Make the greeting shorter.");
    await waitFor("the approval", () => api.agent.pendingId() !== null);
    await waitFor("the proposal document", () => vscode.workspace.textDocuments.some((d) => d.uri.scheme === "matterwave-proposal"));
    const proposal = vscode.workspace.textDocuments.find((d) => d.uri.scheme === "matterwave-proposal")!;
    assert.equal(proposal.getText(), ORIGINAL.replace('"Hello, "', '"Hi, "'));
    // The person types into the right side of the diff.
    const theirs = ORIGINAL.replace('"Hello, "', '"Good day, "');
    const edit = new vscode.WorkspaceEdit();
    edit.replace(proposal.uri, new vscode.Range(proposal.positionAt(0), proposal.positionAt(proposal.getText().length)), theirs);
    assert.ok(await vscode.workspace.applyEdit(edit));
    await vscode.commands.executeCommand("matterwave.agent.accept");
    await run;
    assert.equal(readFileSync(target, "utf8"), theirs, "the file holds the person's version, not the proposal");
    assert.equal(proposalTabs().length, 0);
    // The model was told the file differs from what it proposed.
    const told = (fake.v1Bodies.at(-1)!.messages as { role: string; content: string }[]).at(-1)!;
    assert.equal(told.role, "tool");
    assert.ok(told.content.includes("edited your proposal"));
  });

  it("writes nothing when the file changed while its diff was open, and tells the model to read it again", async function () {
    fake.script.push(editCall('"Hello, "', '"Hi, "'));
    const run = api.chat.send("Make the greeting shorter.");
    await waitFor("the approval", () => api.agent.pendingId() !== null);
    // The person changes the file itself (not the proposal) before accepting.
    const document = await vscode.workspace.openTextDocument(target);
    const theirs = ORIGINAL.replace("name: string", "who: string").replace("+ name", "+ who");
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), theirs);
    assert.ok(await vscode.workspace.applyEdit(edit));
    await document.save();
    await vscode.commands.executeCommand("matterwave.agent.accept");
    await run;
    assert.equal(readFileSync(target, "utf8"), theirs, "the person's change survives");
    const told = (fake.v1Bodies.at(-1)!.messages as { role: string; content: string }[]).at(-1)!;
    assert.equal(told.role, "tool");
    assert.ok(told.content.includes("changed while the change waited"), told.content);
  });

  it("greps the workspace from the bundled extension, the pattern matched off the editor's thread", async function () {
    fake.script.push([
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, id: "call_grep", type: "function", function: { name: "grep", arguments: JSON.stringify({ pattern: "Hel+o" }) } }] } },
        ],
      },
    ]);
    await api.chat.send("Where is the greeting?");
    const told = (fake.v1Bodies.at(-1)!.messages as { role: string; content: string }[]).at(-1)!;
    assert.equal(told.role, "tool");
    assert.equal(told.content, 'src/greet.ts:2:   return "Hello, " + name;');
  });

  it("still asks in auto-edit before writing the workspace's .vscode settings", async function () {
    const settingsFile = path.join(WORKSPACE, ".vscode", "agent-planted.json");
    fake.script.push([
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: "call_cfg", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: ".vscode/agent-planted.json", content: "{}\n" }) } }] },
          },
        ],
      },
    ]);
    await api.agent.setMode("auto-edit");
    try {
      const run = api.chat.send("Configure the editor.");
      await waitFor("the approval", () => api.agent.pendingId("edit") !== null);
      await vscode.commands.executeCommand("matterwave.agent.reject");
      await run;
      assert.equal(existsSync(settingsFile), false);
    } finally {
      await api.agent.setMode("ask");
    }
  });

  it("does not start an MCP server the workspace's settings add until the person approves it", async function () {
    const config = vscode.workspace.getConfiguration("matterwave.agent");
    await config.update("mcpServers", { planted: { command: "node", args: ["-e", "setInterval(() => {}, 1000)"] } }, vscode.ConfigurationTarget.Workspace);
    const asked: string[] = [];
    try {
      await withStub(
        "showWarningMessage",
        async (message: string, options: { detail?: string }) => {
          asked.push(`${message}\n${options?.detail ?? ""}`);
          return undefined;
        },
        async () => {
          await api.chat.send("Hello.");
          await waitFor("the run's end", () => !api.chat.snapshot().agent?.running);
        },
      );
      assert.equal(asked.length, 1, "asked once");
      assert.ok(asked[0]!.includes("planted: runs node -e"), asked[0]);
      assert.ok(!(api.chat.snapshot().agent?.mcp ?? []).some((server) => server.name === "planted"), "the declined server never started");
    } finally {
      await config.update("mcpServers", undefined, vscode.ConfigurationTarget.Workspace);
    }
  });
});
