import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { MatterWaveClient } from "../src/api/client";
import { TransportError, UNTRUSTED_CERTIFICATE_MESSAGE } from "../src/api/transport";
import type { ModelInfo } from "../src/api/types";
import { TokenStore } from "../src/auth/session";
import { ChatController, type StatusInfo } from "../src/chat/controller";
import type { HostMessage, ViewState } from "../src/chat/protocol";
import { ChatViewProvider } from "../src/chat/viewProvider";
import { CONVERSATION, fakeFetch, fixture, json, MODELS, sse } from "./fakeApi";
import { FakeWebview, MemorySecrets } from "./vscode-mock";
import { STREAM_ERROR_COPY } from "../src/streamErrors";

const TOKEN = "mw_abcdefgh_THIS-MUST-NEVER-REACH-THE-WEBVIEW";

const USER = JSON.parse(fixture("turn.sse").split("\n")[1]?.slice("data: ".length) ?? "{}");
const DONE = JSON.parse(fixture("turn.sse").trimEnd().split("\n").at(-1)?.slice("data: ".length) ?? "{}");

function routes() {
  return {
    "GET /api/me": () => json({ subject: "u1", kind: "user", email: "ada@example.com", name: "Ada", org_name: "Acme" }),
    "GET /api/models": () => json(MODELS),
    "GET /api/conversations": () => json({ data: [], filter: "default" }),
    "POST /api/conversations": () => json(CONVERSATION, 201),
    "POST /api/attachments": () =>
      json({ id: "att_9", filename: "src/a.ts", content_type: "text/plain", size_bytes: 20, extract_truncated: true }, 201),
    "POST /api/conversations/c_1/messages": () => sse(fixture("turn.sse"), 11),
    "GET /api/conversations/c_1": () => json({ ...CONVERSATION, messages: [USER, DONE] }),
    "GET /api/conversations/c_1/tree": () => json({ ...CONVERSATION, messages: [USER, DONE] }),
    "GET /api/conversations/c_1/context": () =>
      json({ model: "grt-small", context_window: 32768, used_tokens: 1234, compactable: true }),
  };
}

async function setup() {
  const secrets = new MemorySecrets();
  const tokens = new TokenStore(secrets as unknown as vscode.SecretStorage, () => "https://mw.test");
  await tokens.set(TOKEN);
  const fake = fakeFetch(routes());
  // `dead` stands in for a network that answers nothing, as extension.ts wires reachability;
  // `untrusted` for TLS refusing the server's chain, as transport.ts words it.
  const network = { dead: false, untrusted: false };
  const client = new MatterWaveClient({
    baseUrl: "https://mw.test",
    getToken: () => tokens.get(),
    fetch: (input, init) =>
      network.dead
        ? Promise.reject(new TypeError("fetch failed"))
        : network.untrusted
          ? Promise.reject(new TransportError(`${UNTRUSTED_CERTIFICATE_MESSAGE} (SELF_SIGNED_CERT_IN_CHAIN)`, null))
          : fake.fetch(input, init),
    onReachability: (online) => controller.setOffline(!online),
  });
  const webview = new FakeWebview();
  const provider = new ChatViewProvider(vscode.Uri.file("/ext"));
  const statuses: StatusInfo[] = [];
  const controller = new ChatController({
    client,
    post: (message) => provider.post(message),
    isSignedIn: async () => (await tokens.get()) !== null,
    rememberedModel: { get: () => null, set: () => undefined },
    runCommand: () => undefined,
    onStatus: (s) => void statuses.push(s),
  });
  provider.attach(controller);
  provider.resolveWebviewView({
    webview,
    show: () => undefined,
    onDidDispose: () => ({ dispose() {} }),
  } as unknown as vscode.WebviewView);
  const handled = vi.spyOn(controller, "handle");
  /** Deliver a message as the webview would, and wait for the host to finish with it. */
  const fromWebview = async (message: unknown) => {
    const before = handled.mock.results.length;
    webview.receive(message);
    await handled.mock.results[before]?.value;
  };
  return { controller, webview, calls: fake.calls, fromWebview, statuses, network };
}

function lastState(posted: unknown[]): ViewState {
  const states = (posted as HostMessage[]).filter((m): m is Extract<HostMessage, { type: "state" }> => m.type === "state");
  const last = states.at(-1);
  if (!last) throw new Error("no state posted");
  return last.state;
}

describe("the webview message channel", () => {
  it("streams a whole turn to the webview and never carries the token", async () => {
    const { webview, calls, fromWebview, statuses } = await setup();
    await fromWebview({ type: "ready" });
    await fromWebview({ type: "send", content: "What time is it?" });

    // The token was used -- every API call carried it...
    expect(calls.every((c) => c.headers.Authorization === `Bearer ${TOKEN}`)).toBe(true);
    // ...and nothing that crossed into the webview, nor the page itself, contains it.
    const channel = JSON.stringify(webview.posted);
    expect(channel).not.toContain(TOKEN);
    expect(channel).not.toContain("abcdefgh");
    expect(channel).not.toMatch(/Bearer|Authorization/);
    expect(webview.html).not.toContain(TOKEN);

    const deltas = (webview.posted as HostMessage[]).filter((m) => m.type === "delta");
    expect(deltas.map((d) => (d.type === "delta" ? d.text : ""))).toEqual(["Need the clock.", "It is ", "10:00 UTC."]);

    const state = lastState(webview.posted);
    expect(state.streaming).toBe(false);
    expect(state.live).toBeNull();
    expect(state.transcript.map((e) => e.message.id)).toEqual(["m_user", "m_asst"]);
    expect(state.conversations).toEqual([{ id: "c_1", title: "What time is it?" }]);
    expect(state.meter).toEqual({ usedTokens: 1234, contextWindow: 32768, compactable: true });
    expect(statuses.at(-1)).toMatchObject({ signedIn: true, identity: "Ada", model: "GRT Small", meterPercent: 4 });

    const send = calls.find((c) => c.method === "POST" && c.url === "/api/conversations/c_1/messages");
    expect(JSON.parse(String(send?.body))).toEqual({ content: "What time is it?", model: "grt-small" });
  });

  it("rejects malformed intents from the webview", async () => {
    const { controller, webview } = await setup();
    const handle = vi.spyOn(controller, "handle");
    webview.receive({ type: "send" });
    webview.receive({ type: "evil", token: "x" });
    webview.receive("ready");
    expect(handle).not.toHaveBeenCalled();
  });

  it("serves a page with a nonce-only script policy and no remote source", async () => {
    const { webview } = await setup();
    const csp = /content="([^"]+)"/.exec(webview.html)?.[1] ?? "";
    const nonce = /script-src 'nonce-([A-Za-z0-9]+)'/.exec(csp)?.[1];
    expect(nonce).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toMatch(/https?:|unsafe-inline|unsafe-eval|connect-src/);
    expect(webview.html.match(/<script /g)).toHaveLength(1);
    expect(webview.html).toContain(`<script nonce="${nonce}"`);
  });
});

describe("ask about file", () => {
  it("uploads the file as text/plain named by its path, then sends attachment_ids", async () => {
    const { controller, calls, webview } = await setup();
    await controller.refresh();
    await controller.askAboutFile("Explain this file.", "export const a = 1;\n", "src/a.ts");

    const upload = calls.find((c) => c.url.startsWith("/api/attachments"));
    const file = (upload?.body as FormData).get("file") as File;
    expect(file.name).toBe("src/a.ts");
    expect(file.type).toBe("text/plain");
    expect(await file.text()).toBe("export const a = 1;\n");

    const send = calls.find((c) => c.url === "/api/conversations/c_1/messages");
    expect(JSON.parse(String(send?.body))).toEqual({
      content: "Explain this file.",
      model: "grt-small",
      attachment_ids: ["att_9"],
    });
    // The API cut the file; the reader is told so.
    expect(lastState(webview.posted).notice).toContain("only its start was sent");
  });
});

describe("model selection", () => {
  it("refuses a model the plan does not include", async () => {
    const { controller } = await setup();
    await controller.refresh();
    const excluded = MODELS.data.find((m) => !m.included) as ModelInfo;
    expect(controller.setModel(excluded)).toBe(false);
    expect(controller.currentModel()?.id).toBe("grt-small");
  });
});

describe("stream failures", () => {
  it("shows the moderation copy and its reference", async () => {
    const { controller, webview } = await setup();
    await controller.refresh();
    controller["deps"].client = new MatterWaveClient({
      baseUrl: "https://mw.test",
      getToken: async () => TOKEN,
      fetch: fakeFetch({
        ...routes(),
        "POST /api/conversations/c_1/messages": () =>
          sse('event: moderation_block\ndata: {"detail": "Blocked", "code": "moderation", "request_id": "req-mod"}\n\n'),
      }).fetch,
    });
    await controller.send("something");
    const state = lastState(webview.posted);
    expect(state.error).toMatchObject({ title: "MatterWave would not send this message", retryable: false, requestId: "req-mod" });
    expect(controller.lastRequestId).toBe("req-mod");
  });
});

describe("branch switching", () => {
  it("moves the active leaf to the sibling's newest descendant", async () => {
    const { controller, calls } = await setup();
    const second = { ...DONE, id: "m_asst2", created_at: "2026-10-18T10:05:00+00:00" };
    const tree = [USER, DONE, second];
    controller["deps"].client = new MatterWaveClient({
      baseUrl: "https://mw.test",
      getToken: async () => TOKEN,
      fetch: fakeFetch({
        ...routes(),
        "GET /api/conversations/c_1/tree": () => json({ ...CONVERSATION, messages: tree }),
        "PUT /api/conversations/c_1/active-leaf": (call) => {
          calls.push(call);
          return json({ ...CONVERSATION, messages: [USER, second] });
        },
      }).fetch,
    });
    await controller.openConversation("c_1");
    expect(controller.snapshot().transcript[1]).toMatchObject({ siblingIndex: 1, siblingCount: 2 });
    await controller.switchBranch("m_asst", 1);
    const put = calls.find((c) => c.method === "PUT");
    expect(JSON.parse(String(put?.body))).toEqual({ message_id: "m_asst2" });
    expect(controller.snapshot().transcript[1]).toMatchObject({ siblingIndex: 2, siblingCount: 2 });
  });
});

describe("the API's wire shapes", () => {
  function withRoutes(controller: ChatController, extra: Record<string, (call: never) => Response>) {
    const fake = fakeFetch({ ...routes(), ...extra });
    controller["deps"].client = new MatterWaveClient({ baseUrl: "https://mw.test", getToken: async () => TOKEN, fetch: fake.fetch });
    return fake.calls;
  }

  it("shows a notice frame's detail, which is where the API puts its text", async () => {
    const { controller, webview } = await setup();
    await controller.refresh();
    withRoutes(controller, {
      "POST /api/conversations/c_1/messages": () =>
        sse(
          'event: notice\ndata: {"detail": "Earlier turns could not be summarised.", "code": "compaction"}\n\n' +
            fixture("turn.sse").split("\n").slice(3).join("\n"),
        ),
    });
    await controller.send("hello");
    expect(lastState(webview.posted).notice).toBe("Earlier turns could not be summarised.");
  });

  it("posts edit as {content, model} and regenerate as {model} only", async () => {
    const { controller } = await setup();
    await controller.refresh();
    await controller.openConversation("c_1");
    const calls = withRoutes(controller, {
      "POST /api/conversations/c_1/messages/m_user/edit": () => sse(fixture("turn.sse")),
      "POST /api/conversations/c_1/messages/m_asst/regenerate": () => sse(fixture("turn.sse")),
    });
    await controller.edit("m_user", "Better question");
    await controller.regenerate("m_asst");
    const edit = calls.find((c) => c.url.endsWith("/edit"));
    const regen = calls.find((c) => c.url.endsWith("/regenerate"));
    expect(JSON.parse(String(edit?.body))).toEqual({ content: "Better question", model: "grt-small" });
    expect(JSON.parse(String(regen?.body))).toEqual({ model: "grt-small" });
  });

  it("compacts and measures with the picked model, not the server's default", async () => {
    const { controller } = await setup();
    await controller.refresh();
    await controller.openConversation("c_1");
    const calls = withRoutes(controller, { "POST /api/conversations/c_1/compact": () => json(DONE) });
    await controller.compact();
    const compact = calls.find((c) => c.url.endsWith("/compact"));
    expect(JSON.parse(String(compact?.body))).toEqual({ model: "grt-small" });
    expect(calls.some((c) => c.url === "/api/conversations/c_1/context?model=grt-small")).toBe(true);
  });

  it.each([
    [409, "notice", null],
    [402, "error", STREAM_ERROR_COPY.budget.title],
    [502, "error", STREAM_ERROR_COPY.gateway.title],
  ] as const)("maps a %i from compact", async (status, where, title) => {
    const { controller } = await setup();
    await controller.refresh();
    await controller.openConversation("c_1");
    withRoutes(controller, { "POST /api/conversations/c_1/compact": () => json({ detail: "no" }, status) });
    await controller.compact();
    const state = controller.snapshot();
    if (where === "notice") {
      expect(state.error).toBeNull();
      expect(state.notice).toContain("Nothing to compact");
    } else {
      expect(state.error?.title).toBe(title);
    }
  });
});

describe("offline", () => {
  it("names the caFile setting when TLS refuses the server's certificate", async () => {
    const { webview, fromWebview, network } = await setup();
    await fromWebview({ type: "ready" });
    network.untrusted = true;
    await fromWebview({ type: "reconnect" });
    const state = lastState(webview.posted);
    expect(state.offline).toBe(true);
    expect(state.error?.title).toBe(STREAM_ERROR_COPY.untrusted_certificate.title);
    expect(state.error?.guidance).toContain("matterwave.caFile");
    network.untrusted = false;
    await fromWebview({ type: "reconnect" });
    expect(lastState(webview.posted).error).toBeNull();
  });

  it("goes offline when the API stops answering, and Reconnect brings it back without sending a turn", async () => {
    const { webview, calls, fromWebview, statuses, network } = await setup();
    await fromWebview({ type: "ready" });
    expect(lastState(webview.posted).offline).toBe(false);

    network.dead = true;
    await fromWebview({ type: "reconnect" });
    expect(lastState(webview.posted).offline).toBe(true);
    expect(lastState(webview.posted).error?.title).toBe(STREAM_ERROR_COPY.network.title);
    expect(statuses.at(-1)).toMatchObject({ offline: true });

    network.dead = false;
    const before = calls.length;
    await fromWebview({ type: "reconnect" });
    expect(calls.length).toBeGreaterThan(before);
    const state = lastState(webview.posted);
    expect(state.offline).toBe(false);
    expect(state.error).toBeNull();
    expect(statuses.at(-1)).toMatchObject({ offline: false, identity: "Ada" });
    // A reconnect is a read, never a turn: the draft stays in the composer.
    expect(calls.slice(before).every((c) => c.method === "GET")).toBe(true);
  });

  it("keeps a first message the API never took, so Retry sends it once the API is back", async () => {
    const { webview, calls, fromWebview, network } = await setup();
    await fromWebview({ type: "ready" });

    network.dead = true;
    await fromWebview({ type: "send", content: "What time is it?" });
    let state = lastState(webview.posted);
    expect(state.offline).toBe(true);
    expect(state.error).toMatchObject({ title: STREAM_ERROR_COPY.network.title, retryable: true });
    expect(state.activeId).toBeNull();

    network.dead = false;
    await fromWebview({ type: "reconnect" });
    state = lastState(webview.posted);
    expect(state.offline).toBe(false);
    // The banner, with its Retry, outlives the reconnect: it is where the text is.
    expect(state.error?.retryable).toBe(true);
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    await fromWebview({ type: "retry" });
    state = lastState(webview.posted);
    expect(state.error).toBeNull();
    expect(state.transcript.map((e) => e.message.id)).toEqual(["m_user", "m_asst"]);
    const posts = calls.filter((c) => c.method === "POST").map((c) => c.url);
    expect(posts).toEqual(["/api/conversations", "/api/conversations/c_1/messages"]);
  });
});

describe("switching conversations mid-stream", () => {
  it("leaves the opened conversation with only its own messages", async () => {
    const { controller, webview } = await setup();
    await controller.refresh();
    await controller.openConversation("c_1");
    // A's answer is held after its user turn and released once B is open;
    // the stream ignores the abort signal, as a slow upstream may.
    const lines = fixture("turn.sse").split("\n");
    const head = lines.slice(0, 3).join("\n") + "\n";
    const tail = lines.slice(3).join("\n");
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const enc = new TextEncoder();
    const B = { ...CONVERSATION, id: "c_2", title: "B" };
    const bUser = { ...USER, id: "b_user", conversation_id: "c_2", content: "B question", parts: [{ type: "text", text: "B question" }] };
    const fake = fakeFetch({
      ...routes(),
      "POST /api/conversations/c_1/messages": () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(c) {
              c.enqueue(enc.encode(head));
              await held;
              c.enqueue(enc.encode(tail));
              c.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
      "GET /api/conversations/c_2": () => json({ ...B, messages: [bUser] }),
      "GET /api/conversations/c_2/tree": () => json({ ...B, messages: [bUser] }),
      "GET /api/conversations/c_2/context": () => json({ model: "grt-small", context_window: 32768, used_tokens: 10, compactable: true }),
    });
    controller["deps"].client = new MatterWaveClient({ baseUrl: "https://mw.test", getToken: async () => TOKEN, fetch: fake.fetch });

    const turn = controller.send("A question");
    await vi.waitFor(() => expect(controller.snapshot().transcript.map((e) => e.message.id)).toContain("m_user"));
    await controller.openConversation("c_2");
    release();
    await turn;

    const state = lastState(webview.posted);
    expect(state.transcript.map((e) => e.message.id)).toEqual(["b_user"]);
    expect(state.live).toBeNull();
    expect(state.streaming).toBe(false);
    expect(state.notice).toBeNull();
  });
});
