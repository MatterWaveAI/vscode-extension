/// <reference types="mocha" />
import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import type { HostMessage, ViewState } from "../../src/chat/protocol";
import type { MatterWaveApi } from "../../src/extension";

/**
 * The extension in a real editor against a real deployment: the commands a
 * person runs, with the editor's prompts answered in their place, and the
 * controller and its channel to the chat view read through the extension's
 * exports. One key, minted by e2e/run.mjs for this run; one model turn.
 */

const EXTENSION_ID = "matterwave.matterwave";
/** The model the deployment answers with: grt-nano on the cluster, whatever a local API serves otherwise. */
const MODEL = process.env.E2E_MODEL || "grt-nano";

const baseUrl = process.env.E2E_BASE_URL ?? "";
const apiKey = process.env.E2E_API_KEY ?? "";
/** The deployment's private root, when it has one; empty trusts the system's authorities. */
const caFile = process.env.E2E_CA_FILE ?? "";

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

async function waitFor(what: string, check: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("the MatterWave extension against a real deployment", function () {
  let api: MatterWaveApi;

  before(async function () {
    assert.ok(baseUrl && apiKey, "E2E_BASE_URL and E2E_API_KEY come from e2e/run.mjs");
    const extension = vscode.extensions.getExtension<MatterWaveApi>(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is not installed in the test editor`);
    api = await extension.activate();
    const settings = vscode.workspace.getConfiguration("matterwave");
    await settings.update("baseUrl", baseUrl, vscode.ConfigurationTarget.Global);
    // The extension trusts a private CA through its own setting, as a person
    // behind one would configure it; the host's NODE_EXTRA_CA_CERTS does not
    // reach the extension's fetch.
    await settings.update("caFile", caFile || undefined, vscode.ConfigurationTarget.Global);
    // A key a previous run left in the secret store would make the sign-in
    // below prove nothing, so the run starts signed out.
    await vscode.commands.executeCommand("matterwave.signOut");
    await waitFor("the signed-out state", () => !api.chat.snapshot().signedIn);
  });

  after(async function () {
    if (!api) return;
    await vscode.commands.executeCommand("matterwave.signOut");
    const settings = vscode.workspace.getConfiguration("matterwave");
    await settings.update("baseUrl", undefined, vscode.ConfigurationTarget.Global);
    await settings.update("caFile", undefined, vscode.ConfigurationTarget.Global);
  });

  it("starts signed out, with the composer pointing at sign-in", function () {
    const state = api.chat.snapshot();
    assert.equal(state.signedIn, false);
    assert.equal(state.identity, null);
    assert.deepEqual(state.conversations, []);
  });

  it("signs in with a pasted API key and learns who it is", async function () {
    await withStub("showInputBox", async () => apiKey, () => vscode.commands.executeCommand("matterwave.signInWithApiKey"));
    // The store's change event drives the refresh; the command itself returns first.
    await waitFor("the signed-in state", () => api.chat.snapshot().signedIn && api.chat.snapshot().identity !== null);
    const state = api.chat.snapshot();
    assert.equal(state.error, null, state.error ? `${state.error.title}: ${state.error.guidance}` : "");
    assert.equal(state.offline, false);
    assert.ok(state.identity, "the identity /api/me reports");
    assert.ok(state.model, "a model the plan includes");
  });

  it(`offers the deployment's models in the picker, ${MODEL} among them`, async function () {
    let offered: vscode.QuickPickItem[] = [];
    await withStub(
      "showQuickPick",
      async (items: vscode.QuickPickItem[] | Thenable<vscode.QuickPickItem[]>) => {
        offered = await items;
        return offered.find((item) => rowOf(item)?.model.id === MODEL);
      },
      () => vscode.commands.executeCommand("matterwave.pickModel"),
    );
    const ids = offered.map((item) => rowOf(item)?.model.id).filter((id): id is string => typeof id === "string");
    assert.ok(ids.includes(MODEL), `the picker offered ${JSON.stringify(ids)}`);
    assert.ok(offered.some((item) => item.kind === vscode.QuickPickItemKind.Separator), "the picker groups its rows under headings");
    const row = offered.map(rowOf).find((r) => r?.model.id === MODEL);
    assert.equal(row?.selectable, true, `${MODEL} is on the account's plan`);
    assert.equal(api.chat.currentModel()?.id, MODEL);
  });

  it("streams an answer to a message and keeps the finished turn", async function () {
    const posted: HostMessage[] = [];
    const tap = api.onHostMessage((message) => posted.push(message));
    try {
      await api.chat.send("Reply with the single word: pong");
    } finally {
      tap.dispose();
    }
    const deltas = posted.filter((m): m is Extract<HostMessage, { type: "delta" }> => m.type === "delta");
    assert.ok(deltas.length > 0, "the answer arrived as streamed deltas");
    const states = posted.filter((m): m is Extract<HostMessage, { type: "state" }> => m.type === "state").map((m) => m.state);
    assert.ok(states.some((s) => s.streaming && s.live !== null), "the view was told the turn was streaming");

    const final: ViewState = api.chat.snapshot();
    assert.equal(final.error, null, final.error ? `${final.error.title}: ${final.error.guidance} (${final.error.requestId})` : "");
    assert.equal(final.streaming, false);
    assert.equal(final.live, null);
    assert.ok(final.activeId, "a conversation was created for the turn");
    assert.equal(final.conversations[0]?.id, final.activeId);
    const roles = final.transcript.map((entry) => entry.message.role);
    assert.deepEqual(roles, ["user", "assistant"]);
    const parts = final.transcript[1]?.message.parts ?? [];
    const answer = parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
    assert.ok(answer.trim().length > 0, "the assistant message has text");
    // The server's copy of the answer is what the deltas built, part by part.
    parts.forEach((part, index) => {
      if (part.type !== "text") return;
      const streamed = deltas.filter((d) => d.index === index).map((d) => d.text).join("");
      assert.equal(streamed, part.text, `text part ${index} was streamed in full`);
    });
    assert.equal(final.model?.id, MODEL);
    // Nothing that crossed to the view carried the key.
    assert.ok(!JSON.stringify(posted).includes(apiKey), "the key never reaches the webview channel");
  });
});

type PickerRow = { kind: "model"; model: { id: string }; selectable: boolean } | { kind: "heading" };

/** The picker's items carry the row they were made from (extension.ts, `PickItem`). */
function rowOf(item: vscode.QuickPickItem): Extract<PickerRow, { kind: "model" }> | null {
  const row = (item as vscode.QuickPickItem & { row?: PickerRow }).row;
  return row && row.kind === "model" ? row : null;
}
