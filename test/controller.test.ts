import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { MatterWaveClient } from "../src/api/client";
import { TransportError, UNTRUSTED_CERTIFICATE_MESSAGE } from "../src/api/transport";
import type { ModelInfo } from "../src/api/types";
import { TokenStore } from "../src/auth/session";
import { ChatController, type StatusInfo } from "../src/chat/controller";
import { MAX_IMAGE_BYTES } from "../src/chat/images";
import type { HostMessage, ViewState } from "../src/chat/protocol";
import { ChatViewProvider, chatHtml } from "../src/chat/viewProvider";
import { CONVERSATION, fakeFetch, fixture, json, MODELS, sse, type Call } from "./fakeApi";
import { FakeWebview, MemorySecrets } from "./vscode-mock";
import { STREAM_ERROR_COPY } from "../src/streamErrors";
import { answerUsageLabel } from "../src/chat/usage";

const TOKEN = "mw_abcdefgh_THIS-MUST-NEVER-REACH-THE-WEBVIEW";

const NOTIFICATION = {
  id: "n_1",
  kind: "budget",
  title: "Budget low",
  body: "80% of the allowance is used.",
  link: null,
  created_at: "2026-10-29T10:00:00+00:00",
  read_at: null,
};

const USAGE = {
  unit: "weighted_tokens",
  used: 4_000_000,
  included: 5_000_000,
  remaining: 1_000_000,
  percent: 80.0,
  warn: true,
  in_overage: false,
  exhausted: false,
  period_start: "2026-10-01",
  resets_at: "2026-11-01T00:00:00+00:00",
  plan: { code: "team", name: "Team" },
};

const USER = JSON.parse(fixture("turn.sse").split("\n")[1]?.slice("data: ".length) ?? "{}");
const DONE = JSON.parse(fixture("turn.sse").trimEnd().split("\n").at(-1)?.slice("data: ".length) ?? "{}");

function routes(over: Record<string, (call: Call) => Response> = {}) {
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
    "GET /api/conversations/c_1/feedback": () => json({ data: [] }),
    "GET /api/me/notifications": () => json({ data: [NOTIFICATION], unread_count: 1 }),
    "POST /api/me/notifications/n_1/read": () => json({ ...NOTIFICATION, read_at: NOTIFICATION.created_at, unread_count: 0 }),
    "POST /api/me/notifications/read-all": () => json({ read: 1 }),
    "GET /api/me/usage": () => json(USAGE),
    "GET /api/library": () => json({ folders: [], tags: [], assignments: {} }),
    "GET /api/org/presets": () => json({ data: [] }),
    ...over,
  };
}

async function setup(
  over: Parameters<typeof routes>[0] = {},
  extra: { resolveMention?: (mention: unknown) => Promise<unknown>; prompts?: { get(name: string): Promise<string | null> } } = {},
) {
  const secrets = new MemorySecrets();
  const tokens = new TokenStore(secrets as unknown as vscode.SecretStorage, () => "https://mw.test");
  await tokens.set(TOKEN);
  const fake = fakeFetch(routes(over));
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
  const openLink = vi.fn();
  const runCommands: string[] = [];
  const controller = new ChatController({
    client,
    post: (message) => provider.post(message),
    isSignedIn: async () => (await tokens.get()) !== null,
    rememberedModel: { get: () => null, set: () => undefined },
    runCommand: (command) => void runCommands.push(command),
    openLink,
    resolveMention: extra.resolveMention as never,
    prompts: extra.prompts,
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
  return { controller, provider, webview, calls: fake.calls, fromWebview, statuses, network, openLink, runCommands };
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
    expect(state.conversations).toEqual([{ id: "c_1", title: "What time is it?", pinned: false, archived: false, badge: null, source: null }]);
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

    const upload = calls.find((c) => c.method === "POST" && c.url.startsWith("/api/attachments"));
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

describe("@-mentions", () => {
  it("uploads each mention's context as an attachment, in the order named", async () => {
    let n = 0;
    const parts: Record<string, { filename: string; text: string }> = {
      file: { filename: "src/a.ts", text: "export const a = 1;\n" },
      git: { filename: "git-diff.diff", text: "diff --git a/a.ts b/a.ts" },
    };
    const picked: string[] = [];
    const { controller, calls } = await setup(
      { "POST /api/attachments": () => json({ id: `att_${++n}`, filename: "x", content_type: "text/plain", size_bytes: 10 }, 201) },
      {
        resolveMention: async (mention) => {
          const kind = (mention as { kind: string }).kind;
          picked.push(kind);
          return parts[kind] ?? null;
        },
      },
    );
    await controller.refresh();
    await controller.send("Review @file against @git, ignoring @unknown");

    expect(picked).toEqual(["file", "git"]);
    const uploads = calls.filter((c) => c.method === "POST" && c.url.startsWith("/api/attachments"));
    expect(uploads).toHaveLength(2);
    expect(await ((uploads[0]?.body as FormData).get("file") as File).text()).toBe("export const a = 1;\n");

    const send = calls.find((c) => c.url === "/api/conversations/c_1/messages");
    expect(JSON.parse(String(send?.body))).toEqual({
      content: "Review @file against @git, ignoring @unknown",
      model: "grt-small",
      attachment_ids: ["att_1", "att_2"],
    });
  });

  it("sends nothing, and creates no conversation, when the person backs out of a pick", async () => {
    const { controller, calls, webview } = await setup({}, { resolveMention: async () => null });
    await controller.refresh();
    await controller.send("Explain @file");

    expect(calls.some((c) => c.url === "/api/conversations/c_1/messages")).toBe(false);
    expect(calls.some((c) => c.method === "POST" && c.url === "/api/conversations")).toBe(false);
    expect(controller.activeConversationId()).toBeNull();
    expect(lastState(webview.posted).notice).toContain("the message was not sent");
    expect(lastState(webview.posted).transcript).toEqual([]);
  });

  it("reads no mention or command out of text the editor composed", async () => {
    let asked = 0;
    const { controller, calls } = await setup(
      {},
      {
        resolveMention: async () => {
          asked++;
          return null;
        },
      },
    );
    await controller.refresh();
    const selection = "/clear the cache\n```ts src/a.ts\n/** @file the module */\n```";
    await controller.sendText(selection);
    expect(asked).toBe(0);
    const send = calls.find((c) => c.url === "/api/conversations/c_1/messages");
    expect(JSON.parse(String(send?.body)).content).toBe(selection);
  });

  it("resolves every mention before the conversation is created", async () => {
    const order: string[] = [];
    const { controller, calls } = await setup(
      {},
      {
        resolveMention: async () => {
          order.push(`pick after ${calls.filter((c) => c.method === "POST" && c.url === "/api/conversations").length} creates`);
          return { filename: "x.txt", text: "x" };
        },
      },
    );
    await controller.refresh();
    await controller.send("Explain @git");
    expect(order).toEqual(["pick after 0 creates"]);
    expect(calls.some((c) => c.url === "/api/conversations/c_1/messages")).toBe(true);
  });

  it("asks once per mention, so two @file mentions attach two files", async () => {
    let n = 0;
    const asked: string[] = [];
    const { controller, calls } = await setup(
      { "POST /api/attachments": () => json({ id: `att_${++n}`, filename: "x", content_type: "text/plain", size_bytes: 1 }, 201) },
      {
        resolveMention: async (mention) => {
          const m = mention as { ordinal: number; of: number };
          asked.push(`${m.ordinal}/${m.of}`);
          return { filename: `f${m.ordinal}.ts`, text: `${m.ordinal}` };
        },
      },
    );
    await controller.refresh();
    await controller.send("Compare @file with @file");
    expect(asked).toEqual(["1/2", "2/2"]);
    const send = calls.find((c) => c.url === "/api/conversations/c_1/messages");
    expect(JSON.parse(String(send?.body)).attachment_ids).toEqual(["att_1", "att_2"]);
  });

  it("sends nothing when an upload fails, with the error banner", async () => {
    const { controller, calls, webview } = await setup(
      { "POST /api/attachments": () => json({ detail: "too big" }, 413) },
      { resolveMention: async () => ({ filename: "src/a.ts", text: "x" }) },
    );
    await controller.refresh();
    await controller.send("Explain @file");

    expect(calls.some((c) => c.url === "/api/conversations/c_1/messages")).toBe(false);
    expect(lastState(webview.posted).error).not.toBeNull();
  });

  it("does not ask for context again when a retried turn already carried the attachments", async () => {
    let resolveCalls = 0;
    const { controller } = await setup(
      { "POST /api/conversations/c_1/messages": () => json({ detail: "stream broke" }, 500) },
      {
        resolveMention: async () => {
          resolveCalls++;
          return { filename: "x.txt", text: "x" };
        },
      },
    );
    await controller.refresh();
    await controller.send("Explain @file");
    expect(resolveCalls).toBe(1);
    // The retry goes out with the ids the first attempt uploaded.
    await controller.retry();
    expect(resolveCalls).toBe(1);
  });
});


describe("tokens and cost per answer", () => {
  const priced = {
    ...MODELS,
    data: MODELS.data.map((m) => (m.id === "grt-small" ? { ...m, input_usd_per_m: 0.5, output_usd_per_m: 1.5 } : m)),
  };

  it("keeps what the turn's context frame said under the answer's id, priced at the model's list price", async () => {
    const { controller } = await setup({ "GET /api/models": () => json(priced) });
    await controller.refresh();
    await controller.send("What time is it?");
    // The fixture's turn: 1,200 prompt tokens, 34 completion tokens, answer m_asst.
    expect(controller.snapshot().answerUsage).toEqual({
      m_asst: { promptTokens: 1200, completionTokens: 34, costUsd: (1200 * 0.5 + 34 * 1.5) / 1_000_000 },
    });
  });

  it("gives tokens without a cost when the model list has no price", async () => {
    const { controller } = await setup();
    await controller.refresh();
    await controller.send("What time is it?");
    expect(controller.snapshot().answerUsage.m_asst).toEqual({ promptTokens: 1200, completionTokens: 34, costUsd: null });
  });

  it("shows nothing while the setting hides it", async () => {
    const { controller } = await setup();
    await controller.refresh();
    await controller.send("What time is it?");
    controller["deps"].showAnswerUsage = () => false;
    expect(controller.snapshot().answerUsage).toEqual({});
  });
});

describe("answerUsageLabel", () => {
  it("reads tokens in and out, and the cost to the place that shows it", () => {
    expect(answerUsageLabel({ promptTokens: 1200, completionTokens: 34, costUsd: 0.000651 })).toBe("1,200 in · 34 out · $0.0007");
    expect(answerUsageLabel({ promptTokens: 90_000, completionTokens: 4_000, costUsd: 1.234 })).toBe("90,000 in · 4,000 out · $1.23");
    expect(answerUsageLabel({ promptTokens: 3, completionTokens: 1, costUsd: 0.000002 })).toBe("3 in · 1 out · under $0.0001");
    expect(answerUsageLabel({ promptTokens: 3, completionTokens: 1, costUsd: null })).toBe("3 in · 1 out");
  });
});

describe("answerOnce", () => {
  it("answers in a temporary conversation it then deletes, leaving the chat as it was", async () => {
    const { controller, calls, webview } = await setup({ "DELETE /api/conversations/c_1": () => new Response(null, { status: 204 }) });
    await controller.refresh();
    const before = lastState(webview.posted);
    const answer = await controller.answerOnce("Write a commit message.");

    expect(answer.length).toBeGreaterThan(0);
    const create = calls.find((c) => c.method === "POST" && c.url === "/api/conversations");
    expect(JSON.parse(String(create?.body))).toMatchObject({ temporary: true, model: "grt-small" });
    expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/conversations/c_1")).toBe(true);
    expect(controller.activeConversationId()).toBeNull();
    expect(lastState(webview.posted).conversations).toEqual(before.conversations);
  });

  it("throws what the API said when no answer came, and still deletes the conversation", async () => {
    const { controller, calls } = await setup({
      "POST /api/conversations/c_1/messages": () => json({ detail: "Your plan's allowance is used up." }, 402),
      "DELETE /api/conversations/c_1": () => new Response(null, { status: 204 }),
    });
    await controller.refresh();
    await expect(controller.answerOnce("x")).rejects.toMatchObject({ status: 402 });
    expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/conversations/c_1")).toBe(true);
  });
});

describe("copy and insert a code block", () => {
  it("hands the block's code to the editor's clipboard and cursor", async () => {
    const answer = { ...DONE, parts: [{ type: "text", text: "Use:\n\n```py\nprint(1)\n```" }] };
    const { controller } = await setup({
      "GET /api/conversations/c_1": () => json({ ...CONVERSATION, messages: [USER, answer] }),
      "GET /api/conversations/c_1/tree": () => json({ ...CONVERSATION, messages: [USER, answer] }),
    });
    const copied: string[] = [];
    const inserted: string[] = [];
    controller["deps"].copyCode = (code) => void copied.push(code);
    controller["deps"].insertCode = (code) => void inserted.push(code);
    await controller.refresh();
    await controller.openConversation("c_1");
    await controller.handle({ type: "copyCodeBlock", messageId: "m_asst", blockIndex: 0 });
    await controller.handle({ type: "insertCodeBlock", messageId: "m_asst", blockIndex: 0 });
    expect(copied).toEqual(["print(1)"]);
    expect(inserted).toEqual(["print(1)"]);
  });
});

describe("prompt names for completion", () => {
  it("reads the library's names with the rest of the state, and again on request", async () => {
    let names = ["review"];
    const { controller } = await setup({}, { prompts: { get: async () => null, names: async () => names } } as never);
    await controller.refresh();
    expect(controller.snapshot().promptNames).toEqual(["review"]);
    names = ["review", "tests"];
    await controller.reloadPrompts();
    expect(controller.snapshot().promptNames).toEqual(["review", "tests"]);
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

function manage(controller: ChatController, extra: Record<string, (call: Call) => Response>) {
    const fake = fakeFetch({
      ...routes(),
      "GET /api/conversations": () => json({ data: [CONVERSATION], filter: "default" }),
      ...extra,
    });
  controller["deps"].client = new MatterWaveClient({ baseUrl: "https://mw.test", getToken: async () => TOKEN, fetch: fake.fetch });
  return fake.calls;
}

describe("conversation list paging", () => {
  const row = (id: string, extra: object = {}) => ({ ...CONVERSATION, id, title: id, ...extra });

  it("loads the next page on request, after the rows on hand, until the cursor runs out", async () => {
    const { controller } = await setup();
    const calls = manage(controller, {
      "GET /api/conversations": (call) => {
        const url = new URL(`https://x${call.url}`);
        if (url.searchParams.get("filter") === "archived") return json({ data: [], filter: "archived", next_cursor: null });
        return url.searchParams.get("cursor") === "p2"
          ? json({ data: [row("c_51"), row("c_1")], filter: "default", next_cursor: null })
          : json({ data: [row("c_1"), row("c_2")], filter: "default", next_cursor: "p2" });
      },
    });
    await controller.refresh();
    expect(controller.snapshot()).toMatchObject({ moreConversations: true, moreArchived: false });

    await controller.handle({ type: "loadMoreConversations", archived: false });
    // c_1 came round again (it moved since): it is not listed twice.
    expect(controller.snapshot().conversations.map((c) => c.id)).toEqual(["c_1", "c_2", "c_51"]);
    expect(controller.snapshot().moreConversations).toBe(false);
    expect(calls.filter((c) => c.url.includes("cursor=p2"))).toHaveLength(1);

    // Past the end, nothing more is asked for.
    await controller.handle({ type: "loadMoreConversations", archived: false });
    expect(calls.filter((c) => c.url.includes("cursor="))).toHaveLength(1);
  });

  it("pages the archive on its own cursor", async () => {
    const { controller } = await setup();
    const calls = manage(controller, {
      "GET /api/conversations": (call) => {
        const url = new URL(`https://x${call.url}`);
        if (url.searchParams.get("filter") !== "archived") return json({ data: [], filter: "default", next_cursor: null });
        return url.searchParams.get("cursor") === "a2"
          ? json({ data: [row("c_old", { archived_at: CONVERSATION.created_at })], filter: "archived", next_cursor: null })
          : json({ data: [row("c_arch", { archived_at: CONVERSATION.created_at })], filter: "archived", next_cursor: "a2" });
      },
    });
    await controller.refresh();
    expect(controller.snapshot()).toMatchObject({ moreConversations: false, moreArchived: true });
    await controller.handle({ type: "loadMoreConversations", archived: true });
    expect(controller.snapshot().archivedConversations.map((c) => c.id)).toEqual(["c_arch", "c_old"]);
    expect(calls.find((c) => c.url.includes("cursor=a2"))?.url).toContain("filter=archived");
  });

  it("starts again from the first page on a refresh", async () => {
    const { controller } = await setup();
    manage(controller, {
      "GET /api/conversations": (call) =>
        call.url.includes("cursor=")
          ? json({ data: [row("c_2")], filter: "default", next_cursor: null })
          : json({ data: [row("c_1")], filter: "default", next_cursor: call.url.includes("archived") ? null : "p2" }),
    });
    await controller.refresh();
    await controller.handle({ type: "loadMoreConversations", archived: false });
    expect(controller.snapshot().conversations).toHaveLength(2);
    await controller.refresh();
    expect(controller.snapshot().conversations.map((c) => c.id)).toEqual(["c_1"]);
    expect(controller.snapshot().moreConversations).toBe(true);
  });
});

describe("budget and attachment limits", () => {
  const BUDGET = {
    period_start: "2026-10-01",
    included_tokens: 5_000_000,
    tokens_used: 4_000_000,
    remaining_tokens: 1_000_000,
    overage_enabled: false,
    overage_cap_micros: 0,
    overage_micros: 0,
    member_default_cap_micros: null,
    member_cap: 10_000_000,
    member_spent: 3_200_000,
    member_exhausted: false,
  };

  it("carries the person's own cap beside the allowance", async () => {
    const { controller } = await setup({ "GET /api/budget": () => json(BUDGET) });
    await controller.refresh();
    expect(controller.snapshot().usage?.memberCap).toEqual({ spentUsd: 3.2, capUsd: 10, exhausted: false });
  });

  it("sends nothing larger than the deployment takes, and says so before uploading", async () => {
    const limits = { max_upload_bytes: 10, quota_bytes: 1_000_000, quota_used_bytes: 0, quota_remaining_bytes: 1_000_000 };
    const { controller, calls, webview } = await setup({ "GET /api/attachments/limits/me": () => json(limits) });
    await controller.refresh();
    await controller.askAboutFile("Explain.", "far more than ten bytes of text", "src/big.ts");
    expect(calls.some((c) => c.method === "POST" && c.url.startsWith("/api/attachments"))).toBe(false);
    expect(calls.some((c) => c.method === "POST" && c.url === "/api/conversations")).toBe(false);
    expect(lastState(webview.posted).notice).toBe("src/big.ts was not sent. That is 1 KB; this deployment takes at most 1 KB per upload.");
  });

  it("names what is left of the person's storage when that is what is short", async () => {
    const limits = { max_upload_bytes: 10 * 1024 * 1024, quota_bytes: 100 * 1024 * 1024, quota_used_bytes: 100 * 1024 * 1024 - 5, quota_remaining_bytes: 5 };
    const { controller, webview } = await setup({ "GET /api/attachments/limits/me": () => json(limits) });
    await controller.refresh();
    await controller.askAboutFile("Explain.", "more than five bytes", "a.ts");
    expect(lastState(webview.posted).notice).toContain("of your 100 MB attachment storage is left");
  });
});

describe("fork, report, ranked search and announcements", () => {
  const hit = (id: string) => ({ ...CONVERSATION, id, title: id, snippet: `in ${id}`, message_id: null });

  it("pages the ranked search on its cursor while the box holds a query", async () => {
    const { controller } = await setup();
    const calls = manage(controller, {
      "GET /api/search": (call) =>
        call.url.includes("cursor=s2")
          ? json({ data: [hit("c_3"), hit("c_1")], query: "clock", next_cursor: null })
          : json({ data: [hit("c_1"), hit("c_2")], query: "clock", next_cursor: "s2" }),
    });
    await controller.refresh();
    await controller.handle({ type: "searchConversations", query: "clock" });
    expect(controller.snapshot().moreConversations).toBe(true);
    await controller.handle({ type: "loadMoreConversations", archived: false });
    expect(controller.snapshot().searchResults?.map((h) => h.id)).toEqual(["c_1", "c_2", "c_3"]);
    expect(controller.snapshot().moreConversations).toBe(false);
    expect(calls.find((c) => c.url.includes("cursor=s2"))?.url).toBe("/api/search?q=clock&cursor=s2");
  });

  it("forks at a message into a new conversation, which opens", async () => {
    const forked = { ...CONVERSATION, id: "c_fork", title: "Fork of New chat" };
    const { controller } = await setup();
    const calls = manage(controller, {
      "POST /api/conversations/c_1/fork": () => json(forked, 201),
      "GET /api/conversations/c_fork": () => json({ ...forked, messages: [USER] }),
      "GET /api/conversations/c_fork/tree": () => json({ ...forked, messages: [USER] }),
      "GET /api/conversations/c_1": () => json({ ...CONVERSATION, messages: [USER, DONE] }),
      "GET /api/conversations/c_1/tree": () => json({ ...CONVERSATION, messages: [USER, DONE] }),
    });
    await controller.refresh();
    await controller.openConversation("c_1");
    await controller.handle({ type: "forkConversation", messageId: "m_asst" });
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith("/fork"))?.body))).toEqual({ message_id: "m_asst" });
    expect(controller.activeConversationId()).toBe("c_fork");
    expect(controller.snapshot().conversations[0]?.id).toBe("c_fork");
    expect(controller.snapshot().notice).toContain("Forked into “Fork of New chat”");
  });

  it("says why a temporary conversation cannot be forked, in the API's words", async () => {
    const { controller } = await setup();
    manage(controller, {
      "POST /api/conversations/c_1/fork": () => json({ detail: "A temporary chat can't be forked." }, 409),
      "GET /api/conversations/c_1": () => json({ ...CONVERSATION, messages: [USER, DONE] }),
      "GET /api/conversations/c_1/tree": () => json({ ...CONVERSATION, messages: [USER, DONE] }),
    });
    await controller.refresh();
    await controller.openConversation("c_1");
    await controller.handle({ type: "forkConversation", messageId: "m_asst" });
    expect(controller.activeConversationId()).toBe("c_1");
    expect(controller.snapshot().notice).toBe("A temporary chat can't be forked.");
  });

  it("hands a report of a message to the editor's report flow", async () => {
    const { controller } = await setup();
    const reported: unknown[] = [];
    controller["deps"].report = (target) => void reported.push(target);
    manage(controller, {
      "GET /api/conversations/c_1": () => json({ ...CONVERSATION, messages: [USER, DONE] }),
      "GET /api/conversations/c_1/tree": () => json({ ...CONVERSATION, messages: [USER, DONE] }),
    });
    await controller.refresh();
    await controller.openConversation("c_1");
    await controller.handle({ type: "reportMessage", messageId: "m_asst" });
    expect(reported).toEqual([{ conversationId: "c_1", messageId: "m_asst" }]);
  });

  it("shows the deployment's announcements until one is dismissed, and keeps an undismissible one", async () => {
    const dismissed = new Set<string>();
    const { controller } = await setup();
    controller["deps"].dismissedAnnouncements = { has: (id) => dismissed.has(id), add: (id) => void dismissed.add(id) };
    manage(controller, {
      "GET /api/announcements": () =>
        json({
          data: [
            { id: "an_1", message: "Maintenance at 02:00 UTC.", severity: "warning", link: null, starts_at: "2026-10-31T00:00:00Z", ends_at: null, dismissible: true },
            { id: "an_2", message: "Read the new terms.", severity: "info", link: "https://mw.test/terms", starts_at: "2026-10-31T00:00:00Z", ends_at: null, dismissible: false },
          ],
        }),
    });
    await controller.refresh();
    expect(controller.snapshot().announcements.map((a) => a.id)).toEqual(["an_1", "an_2"]);
    await controller.handle({ type: "dismissAnnouncement", id: "an_1" });
    await controller.handle({ type: "dismissAnnouncement", id: "an_2" });
    expect(controller.snapshot().announcements).toEqual([
      { id: "an_2", message: "Read the new terms.", severity: "info", link: "https://mw.test/terms", dismissible: false },
    ]);
    expect([...dismissed]).toEqual(["an_1"]);
  });
});

describe("conversation management", () => {
  it("renames through PATCH, trimmed, and the sidebar row follows", async () => {
    const { controller } = await setup();
    const calls = manage(controller, {
      "PATCH /api/conversations/c_1": (call) => {
        expect(JSON.parse(String(call.body))).toEqual({ title: "Better name" });
        return json({ ...CONVERSATION, title: "Better name" });
      },
    });
    await controller.refresh();
    await controller.handle({ type: "renameConversation", id: "c_1", title: "  Better name  " });
    expect(calls.find((c) => c.method === "PATCH")?.url).toBe("/api/conversations/c_1");
    expect(controller.snapshot().conversations).toEqual([{ id: "c_1", title: "Better name", pinned: false, archived: false, badge: null, source: null }]);
  });

  it("pins and unpins over PUT and DELETE, pinned sorting first", async () => {
    const { controller } = await setup();
    const second = { ...CONVERSATION, id: "c_2", title: "Second" };
    const calls = manage(controller, {
      "GET /api/conversations": () => json({ data: [CONVERSATION, second], filter: "default" }),
      "PUT /api/conversations/c_2/pin": () => json({ ...second, pinned_at: second.created_at }),
      "DELETE /api/conversations/c_2/pin": () => json(second),
    });
    await controller.refresh();
    await controller.handle({ type: "pinConversation", id: "c_2", pinned: true });
    expect(controller.snapshot().conversations.map((c) => c.id)).toEqual(["c_2", "c_1"]);
    await controller.handle({ type: "pinConversation", id: "c_2", pinned: false });
    expect(controller.snapshot().conversations.map((c) => c.id)).toEqual(["c_1", "c_2"]);
    expect(calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url}`)).toEqual([
      "PUT /api/conversations/c_2/pin",
      "DELETE /api/conversations/c_2/pin",
    ]);
  });

  it("archives, which moves the row to the archive and closes it when open", async () => {
    const { controller } = await setup();
    await controller.refresh();
    await controller.openConversation("c_1");
    manage(controller, {
      "PUT /api/conversations/c_1/archive": () => json({ ...CONVERSATION, archived_at: CONVERSATION.created_at }),
    });
    await controller.handle({ type: "archiveConversation", id: "c_1", archived: true });
    const state = controller.snapshot();
    expect(state.conversations).toEqual([]);
    expect(state.archivedConversations).toEqual([{ id: "c_1", title: "New chat", pinned: false, archived: true, badge: null, source: null }]);
    expect(state.activeId).toBeNull();
    // Unarchiving puts it back.
    controller["deps"].client = new MatterWaveClient({
      baseUrl: "https://mw.test",
      getToken: async () => TOKEN,
      fetch: fakeFetch({
        ...routes(),
        "GET /api/conversations": () => json({ data: [], filter: "default" }),
        "DELETE /api/conversations/c_1/archive": () => json(CONVERSATION),
      }).fetch,
    });
    await controller.handle({ type: "archiveConversation", id: "c_1", archived: false });
    expect(controller.snapshot().archivedConversations).toEqual([]);
    expect(controller.snapshot().conversations.map((c) => c.id)).toEqual(["c_1"]);
  });

  it("deletes, and closes the view when the open conversation was the one deleted", async () => {
    const { controller } = await setup();
    await controller.refresh();
    await controller.openConversation("c_1");
    const calls = manage(controller, { "DELETE /api/conversations/c_1": () => json({ status: "deleted" }) });
    await controller.handle({ type: "deleteConversation", id: "c_1" });
    expect(calls.find((c) => c.method === "DELETE")?.url).toBe("/api/conversations/c_1");
    const state = controller.snapshot();
    expect(state.conversations).toEqual([]);
    expect(state.activeId).toBeNull();
    expect(state.transcript).toEqual([]);
  });

  it("searches, and an empty query returns to the list", async () => {
    const { controller } = await setup();
    await controller.refresh();
    let query = "";
    const calls = manage(controller, {
      "GET /api/search": (call) => {
        query = String(new URL(`https://mw.test${call.url}`).searchParams.get("q"));
        return json({ data: [{ ...CONVERSATION, snippet: "the clock struck", message_id: "m_1" }], query, next_cursor: null });
      },
    });
    await controller.handle({ type: "searchConversations", query: "clock" });
    expect(query).toBe("clock");
    expect(controller.snapshot().searchResults).toEqual([{ id: "c_1", title: "New chat", pinned: false, archived: false, badge: null, source: null, snippet: "the clock struck" }]);
    const searches = calls.filter((c) => c.url.startsWith("/api/search")).length;
    await controller.handle({ type: "searchConversations", query: "   " });
    expect(controller.snapshot().searchResults).toBeNull();
    expect(calls.filter((c) => c.url.startsWith("/api/search")).length).toBe(searches);
  });

  it("badges a row with its folder and tags from one library read per refresh", async () => {
    const { webview, calls, fromWebview } = await setup({
      "GET /api/conversations": () => json({ data: [{ ...CONVERSATION, folder_id: "f_1" }], filter: "default" }),
      "GET /api/library": () =>
        json({
          folders: [{ id: "f_1", name: "Work", position: 0, created_at: "2026-10-29T10:00:00+00:00", updated_at: "2026-10-29T10:00:00+00:00" }],
          tags: [
            { id: "t_1", name: "bug", created_at: "2026-10-29T10:00:00+00:00" },
            { id: "t_2", name: "spike", created_at: "2026-10-29T10:00:00+00:00" },
          ],
          assignments: { c_1: ["t_1"] },
        }),
    });
    await fromWebview({ type: "ready" });
    const state = lastState(webview.posted);
    // Folder first, then the tags it carries, in the library's order.
    expect(state.conversations).toEqual([{ id: "c_1", title: "New chat", pinned: false, archived: false, badge: "Work · bug", source: null }]);
    // One library read per refresh, whatever the lists asked for.
    expect(calls.filter((c) => c.url === "/api/library")).toHaveLength(1);
    // A deployment without the route loses the badges and nothing else.
    const bare = new ChatController({
      client: new MatterWaveClient({
        baseUrl: "https://mw.test",
        getToken: async () => TOKEN,
        fetch: fakeFetch({
          ...routes(),
          "GET /api/conversations": () => json({ data: [{ ...CONVERSATION, folder_id: "f_1" }], filter: "default" }),
          "GET /api/library": () => json({ detail: "no route" }, 404),
        }).fetch,
      }),
      post: () => undefined,
      isSignedIn: async () => true,
      rememberedModel: { get: () => null, set: () => undefined },
      runCommand: () => undefined,
    });
    await bare.refresh();
    expect(bare.snapshot().conversations).toEqual([{ id: "c_1", title: "New chat", pinned: false, archived: false, badge: null, source: null }]);
  });
});

describe("per-conversation model memory", () => {
  it("writes the picked model to the open conversation as its default_model", async () => {
    const { controller } = await setup();
    await controller.refresh();
    await controller.openConversation("c_1");
    const calls = manage(controller, {
      "PATCH /api/conversations/c_1": (call) => {
        expect(JSON.parse(String(call.body))).toEqual({ default_model: "partner-x" });
        return json({ ...CONVERSATION, default_model: "partner-x" });
      },
    });
    const partner = MODELS.data.find((m) => m.id === "partner-x") as ModelInfo;
    expect(controller.setModel(partner)).toBe(true);
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
  });

  it("keeps the write best-effort: a refusal is not a chat error", async () => {
    const { controller } = await setup();
    await controller.refresh();
    await controller.openConversation("c_1");
    manage(controller, { "PATCH /api/conversations/c_1": () => json({ detail: "no" }, 422) });
    const partner = MODELS.data.find((m) => m.id === "partner-x") as ModelInfo;
    expect(controller.setModel(partner)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(controller.snapshot().error).toBeNull();
    expect(controller.currentModel()?.id).toBe("partner-x");
  });

  it("writes nothing while no conversation is open", async () => {
    const { controller } = await setup();
    await controller.refresh();
    const calls = manage(controller, {});
    const partner = MODELS.data.find((m) => m.id === "partner-x") as ModelInfo;
    controller.setModel(partner);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });
});

describe("message feedback", () => {
  it("rates a reply with PUT and withdraws the rating with DELETE", async () => {
    const { controller } = await setup();
    await controller.refresh();
    await controller.openConversation("c_1");
    const calls = manage(controller, {
      "PUT /api/messages/m_asst/feedback": (call) => {
        expect(JSON.parse(String(call.body))).toEqual({ rating: 1 });
        return json({ message_id: "m_asst", rating: 1 });
      },
      "DELETE /api/messages/m_asst/feedback": () => json({ status: "removed" }),
    });
    await controller.handle({ type: "rateMessage", messageId: "m_asst", rating: 1 });
    await controller.handle({ type: "rateMessage", messageId: "m_asst", rating: 0 });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "PUT /api/messages/m_asst/feedback",
      "DELETE /api/messages/m_asst/feedback",
    ]);
    expect(controller.snapshot().error).toBeNull();
  });

  it("sends the full contract on a thumbs-down: reasons and comment ride, a re-vote replaces", async () => {
    const { controller } = await setup();
    await controller.refresh();
    await controller.openConversation("c_1");
    const bodies: unknown[] = [];
    const calls = manage(controller, {
      "PUT /api/messages/m_asst/feedback": (call) => {
        bodies.push(JSON.parse(String(call.body)));
        return json({ message_id: "m_asst", rating: -1, reasons: bodies.length === 1 ? ["wrong"] : ["too_long"], comment: null });
      },
    });
    await controller.handle({ type: "rateMessage", messageId: "m_asst", rating: -1, reasons: ["wrong"], comment: "no" });
    await controller.handle({ type: "rateMessage", messageId: "m_asst", rating: -1, reasons: ["too_long"] });
    expect(bodies).toEqual([
      { rating: -1, reasons: ["wrong"], comment: "no" },
      { rating: -1, reasons: ["too_long"] },
    ]);
    // The last row is what the thumbs show.
    expect(controller.snapshot().feedback).toEqual({ m_asst: { rating: -1, reasons: ["too_long"], comment: null } });
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(2);
  });

  it("rehydrates the caller's rows when a conversation opens", async () => {
    const { controller } = await setup();
    manage(controller, {
      "GET /api/conversations/c_1/feedback": () =>
        json({ data: [{ message_id: "m_asst", rating: -1, reasons: ["wrong", "too_long"], comment: "nope" }] }),
    });
    await controller.refresh();
    await controller.openConversation("c_1");
    expect(controller.snapshot().feedback).toEqual({
      m_asst: { rating: -1, reasons: ["wrong", "too_long"], comment: "nope" },
    });
    // A withdrawal clears the row.
    manage(controller, { "DELETE /api/messages/m_asst/feedback": () => json({ status: "removed" }) });
    await controller.handle({ type: "rateMessage", messageId: "m_asst", rating: 0 });
    expect(controller.snapshot().feedback).toEqual({});
  });

  it("keeps chatting when the feedback rows cannot be read", async () => {
    const { controller } = await setup();
    manage(controller, { "GET /api/conversations/c_1/feedback": () => json({ detail: "no" }, 500) });
    await controller.refresh();
    await controller.openConversation("c_1");
    expect(controller.snapshot().error).toBeNull();
    expect(controller.snapshot().transcript.map((e) => e.message.id)).toEqual(["m_user", "m_asst"]);
  });

  it("rehydrates the thumbs when the chat view reloads", async () => {
    const { controller, provider, openLink } = await setup();
    manage(controller, {
      "GET /api/conversations/c_1/feedback": () =>
        json({ data: [{ message_id: "m_asst", rating: 1, reasons: [], comment: null }] }),
    });
    await controller.refresh();
    await controller.openConversation("c_1");
    // The view is replaced -- a reload, or the panel closed and reopened --
    // so the page is new and empty while the controller is not.
    const reloaded = new FakeWebview();
    provider.resolveWebviewView({
      webview: reloaded,
      show: () => undefined,
      onDidDispose: () => ({ dispose() {} }),
    } as unknown as vscode.WebviewView);
    await controller.handle({ type: "ready" });
    const state = lastState(reloaded.posted);
    expect(state.feedback).toEqual({ m_asst: { rating: 1, reasons: [], comment: null } });
    expect(openLink).not.toHaveBeenCalled();
  });
});

describe("image previews", () => {
  const IMAGE = {
    ...DONE,
    id: "m_img",
    role: "user",
    parts: [{ type: "image", attachment_id: "att_img", filename: "shot.png", content_type: "image/png" }],
  };

  function imageDataRoutes() {
    return {
      "GET /api/conversations/c_1": () => json({ ...CONVERSATION, messages: [IMAGE] }),
      "GET /api/conversations/c_1/tree": () => json({ ...CONVERSATION, messages: [IMAGE] }),
      "GET /api/conversations/c_1/context": () =>
        json({ model: "grt-small", context_window: 32768, used_tokens: 1234, compactable: true }),
      "GET /api/conversations/c_1/feedback": () => json({ data: [] }),
    };
  }

  it("fetches an image attachment's bytes and posts them as a data: URI", async () => {
    const { controller, webview } = await setup();
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const calls = manage(controller, {
      ...imageDataRoutes(),
      "GET /api/attachments/att_img/content": () =>
        new Response(bytes, { status: 200, headers: { "Content-Type": "image/png" } }),
    });
    await controller.refresh();
    await controller.openConversation("c_1");
    // The preview is fetched off to the side of the conversation load.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls.some((c) => c.url === "/api/attachments/att_img/content")).toBe(true);
    const posted = webview.posted.find((m) => (m as { type?: string }).type === "imageData");
    expect(posted).toEqual({
      type: "imageData",
      attachmentId: "att_img",
      dataUri: `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`,
    });
  });

  it("leaves an oversized image as its named chip, and does not fetch twice for one attachment", async () => {
    const { controller, webview } = await setup();
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
    const calls = manage(controller, {
      ...imageDataRoutes(),
      "GET /api/attachments/att_img/content": () =>
        new Response(big, { status: 200, headers: { "Content-Type": "image/png" } }),
    });
    await controller.refresh();
    await controller.openConversation("c_1");
    const posts = webview.posted.filter((m) => (m as { type?: string }).type === "imageData");
    expect(posts).toEqual([]);
    // A state that re-renders the transcript does not fetch the same bytes again.
    await controller.refresh();
    expect(calls.filter((c) => c.url === "/api/attachments/att_img/content")).toHaveLength(1);
  });

  it("does not fetch a type no img may show", async () => {
    const { controller, webview } = await setup();
    const svg = {
      ...IMAGE,
      parts: [{ type: "image", attachment_id: "att_svg", filename: "logo.svg", content_type: "image/svg+xml" }],
    };
    const calls = manage(controller, {
      "GET /api/conversations/c_1": () => json({ ...CONVERSATION, messages: [svg] }),
      "GET /api/conversations/c_1/tree": () => json({ ...CONVERSATION, messages: [svg] }),
      "GET /api/conversations/c_1/context": () =>
        json({ model: "grt-small", context_window: 32768, used_tokens: 1234, compactable: true }),
      "GET /api/conversations/c_1/feedback": () => json({ data: [] }),
    });
    await controller.refresh();
    await controller.openConversation("c_1");
    expect(calls.some((c) => c.url.includes("/content"))).toBe(false);
    expect(webview.posted.some((m) => (m as { type?: string }).type === "imageData")).toBe(false);
  });

  it("re-posts the previews after the view reloads", async () => {
    const { controller, webview } = await setup();
    const calls = manage(controller, {
      ...imageDataRoutes(),
      "GET /api/attachments/att_img/content": () =>
        new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "image/png" } }),
    });
    await controller.refresh();
    await controller.openConversation("c_1");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(webview.posted.some((m) => (m as { type?: string }).type === "imageData")).toBe(true);
    await controller.handle({ type: "ready" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls.filter((c) => c.url === "/api/attachments/att_img/content")).toHaveLength(2);
  });
});

describe("notification links", () => {
  it("opens a conversation link in the chat and any other link in the browser", async () => {
    const { controller, openLink } = await setup();
    await controller.refresh();
    await controller.handle({ type: "openNotification", id: "n_1", url: "https://mw.test/apps/chat?c=c_1" });
    expect(controller.snapshot().activeId).toBe("c_1");
    expect(openLink).not.toHaveBeenCalled();
    await controller.handle({ type: "openNotification", id: "n_1", url: "https://example.com/pricing" });
    expect(openLink).toHaveBeenCalledWith("https://example.com/pricing");
  });

  it("refuses a link that is not http(s) and repairs a relative one", async () => {
    const { controller, openLink } = await setup();
    await controller.refresh();
    await controller.handle({ type: "openNotification", id: "n_1", url: "javascript:alert(1)" });
    expect(openLink).not.toHaveBeenCalled();
    expect(controller.snapshot().activeId).toBeNull();
    await controller.handle({ type: "openNotification", id: "n_1", url: "/apps/chat?c=c_1" });
    expect(controller.snapshot().activeId).toBe("c_1");
  });
});

describe("temporary chats", () => {
  it("creates the conversation with temporary: true on a first send that asks for it, and keeps it out of the sidebar", async () => {
    const { webview, calls, fromWebview } = await setup();
    await fromWebview({ type: "ready" });
    await fromWebview({ type: "send", content: "Off the record", temporary: true });
    const create = calls.find((c) => c.method === "POST" && c.url === "/api/conversations");
    expect(JSON.parse(String(create?.body))).toEqual({ model: "grt-small", temporary: true });
    const state = lastState(webview.posted);
    expect(state.temporary).toBe(true);
    expect(state.conversations).toEqual([]);
    // The chat itself works as any other.
    expect(state.transcript.map((e) => e.message.id)).toEqual(["m_user", "m_asst"]);
  });

  it("omits the key for an ordinary first send", async () => {
    const { calls, fromWebview } = await setup();
    await fromWebview({ type: "ready" });
    await fromWebview({ type: "send", content: "On the record" });
    const create = calls.find((c) => c.method === "POST" && c.url === "/api/conversations");
    expect(JSON.parse(String(create?.body))).toEqual({ model: "grt-small" });
  });

  it("filters a temporary row out of the sidebar and the search on refresh", async () => {
    const { controller } = await setup();
    const temporary = { ...CONVERSATION, id: "c_temp", temporary: true };
    manage(controller, {
      "GET /api/conversations": () => json({ data: [temporary, CONVERSATION], filter: "default" }),
      "GET /api/search": () => json({ data: [{ ...temporary, snippet: "leaked", message_id: null }], query: "x", next_cursor: null }),
    });
    await controller.refresh();
    expect(controller.snapshot().conversations.map((c) => c.id)).toEqual(["c_1"]);
    await controller.handle({ type: "searchConversations", query: "x" });
    expect(controller.snapshot().searchResults).toEqual([]);
  });

  it("surfaces the API's 409 detail as a notice when a temporary conversation is pinned", async () => {
    const { controller } = await setup();
    const calls = manage(controller, {
      "GET /api/conversations": () => json({ data: [CONVERSATION], filter: "default" }),
      "PUT /api/conversations/c_1/pin": () =>
        json({ detail: "A temporary conversation is not kept, so it cannot be pinned." }, 409),
    });
    await controller.refresh();
    await controller.handle({ type: "pinConversation", id: "c_1", pinned: true });
    expect(calls.some((c) => c.method === "PUT")).toBe(true);
    expect(controller.snapshot().error).toBeNull();
    expect(controller.snapshot().notice).toBe("A temporary conversation is not kept, so it cannot be pinned.");
  });

  it("retries a failed first send as the same kind of temporary chat", async () => {
    const { webview, calls, fromWebview, network } = await setup();
    await fromWebview({ type: "ready" });
    network.dead = true;
    await fromWebview({ type: "send", content: "Off the record", temporary: true });
    network.dead = false;
    await fromWebview({ type: "retry" });
    const create = calls.find((c) => c.method === "POST" && c.url === "/api/conversations");
    expect(JSON.parse(String(create?.body))).toEqual({ model: "grt-small", temporary: true });
    expect(lastState(webview.posted).temporary).toBe(true);
  });
});

describe("a connector's conversation", () => {
  const SLACK = {
    connector: "slack",
    connection_id: "conn-1",
    channel_label: "#support",
    url: "https://acme.slack.com/archives/C01/p1700000000000100",
  };
  const SOURCED = { ...CONVERSATION, title: "Deploy question", source: SLACK };
  const REFUSAL = {
    detail: "This conversation is answered from slack in #support; reply there. Fork it to continue it here.",
    code: "connector_conversation",
    source: SLACK,
    request_id: "req-409",
  };

  it("carries the source on the row and on the open conversation, and sends no turn into it", async () => {
    const { controller, webview, calls } = await setup({
      "GET /api/conversations": () => json({ data: [SOURCED], filter: "default" }),
      "GET /api/conversations/c_1": () => json({ ...SOURCED, messages: [USER, DONE] }),
    });
    await controller.refresh();
    expect(controller.snapshot().conversations).toEqual([
      { id: "c_1", title: "Deploy question", pinned: false, archived: false, badge: null, source: SLACK },
    ]);
    await controller.openConversation("c_1");
    expect(controller.snapshot().source).toEqual(SLACK);

    await controller.send("Any news?");
    await controller.edit("m_user", "Any news at all?");
    await controller.regenerate("m_asst");
    expect(calls.filter((c) => c.method === "POST" && c.url.includes("/messages"))).toEqual([]);
    const state = lastState(webview.posted);
    expect(state.error).toBeNull();
    expect(state.notice).toBe("Answered in Slack #support — reply in the thread");
    // Leaving it clears the mark.
    controller.newChat();
    expect(controller.snapshot().source).toBeNull();
  });

  it("turns the API's 409 on a send into the same lock when the list was stale", async () => {
    // The row and the first read predate the source; the reload after the
    // refused turn is what brings it.
    let reads = 0;
    const { controller, webview, calls } = await setup({
      "GET /api/conversations": () => json({ data: [CONVERSATION], filter: "default" }),
      "POST /api/conversations/c_1/messages": () => json(REFUSAL, 409),
      "GET /api/conversations/c_1": () => json({ ...(reads++ === 0 ? CONVERSATION : SOURCED), messages: [USER, DONE] }),
    });
    await controller.refresh();
    await controller.openConversation("c_1");
    expect(controller.snapshot().source).toBeNull();
    await controller.send("Any news?");
    expect(calls.some((c) => c.method === "POST" && c.url === "/api/conversations/c_1/messages")).toBe(true);
    const state = lastState(webview.posted);
    expect(state.source).toEqual(SLACK);
    // Not a failed turn: no error, no Retry, and the optimistic line is gone with the reload.
    expect(state.error).toBeNull();
    expect(state.transcript.map((e) => e.message.id)).toEqual(["m_user", "m_asst"]);
    await controller.retry();
    expect(calls.filter((c) => c.method === "POST" && c.url === "/api/conversations/c_1/messages")).toHaveLength(1);
  });

  it("forks from the leaf into a conversation of the person's own, and opens it", async () => {
    const FORKED = { ...CONVERSATION, id: "c_2", title: "Fork of Deploy question", source: null };
    const { controller, calls, openLink } = await setup({
      "GET /api/conversations": () => json({ data: [SOURCED], filter: "default" }),
      "GET /api/conversations/c_1": () => json({ ...SOURCED, messages: [USER, DONE] }),
      "POST /api/conversations/c_1/fork": () => json(FORKED, 201),
      "GET /api/conversations/c_2": () => json({ ...FORKED, messages: [USER, DONE] }),
      "GET /api/conversations/c_2/tree": () => json({ ...FORKED, messages: [USER, DONE] }),
      "GET /api/conversations/c_2/context": () =>
        json({ model: "grt-small", context_window: 32768, used_tokens: 1234, compactable: true }),
      "GET /api/conversations/c_2/feedback": () => json({ data: [] }),
    });
    await controller.refresh();
    await controller.openConversation("c_1");
    await controller.handle({ type: "openLink", url: SLACK.url });
    expect(openLink).toHaveBeenCalledWith(SLACK.url);

    await controller.handle({ type: "forkConversation", messageId: "m_asst" });
    const fork = calls.find((c) => c.method === "POST" && c.url === "/api/conversations/c_1/fork");
    expect(JSON.parse(String(fork?.body))).toEqual({ message_id: "m_asst" });
    const state = controller.snapshot();
    expect(state.activeId).toBe("c_2");
    expect(state.source).toBeNull();
    expect(state.notice).toContain("Forked into “Fork of Deploy question”");
    expect(state.conversations.map((c) => [c.id, c.source])).toEqual([
      ["c_2", null],
      ["c_1", SLACK],
    ]);
  });
});

describe("custom instructions", () => {
  const EFFECTIVE = {
    org: "Be brief.",
    user: { about: "Ada", style: null },
    conversation: "Cite sources",
    user_overridden: true,
    effective: "Be brief. Cite sources",
  };

  it("reads the layers from the conversation detail and writes them over PUT", async () => {
    const { controller } = await setup();
    const calls = manage(controller, {
      "GET /api/conversations/c_1": () => json({ ...CONVERSATION, messages: [USER, DONE], instructions: EFFECTIVE }),
      "PUT /api/conversations/c_1/instructions": (call) => {
        // The answer carries the layers as they now stand, whatever text was set.
        const text = (JSON.parse(String(call.body)) as { text: string | null }).text;
        return json({ ...EFFECTIVE, conversation: text, effective: text === null ? "Be brief." : `Be brief. ${text}` });
      },
    });
    await controller.refresh();
    await controller.openConversation("c_1");
    expect(controller.snapshot().instructions).toEqual({
      conversation: "Cite sources",
      effective: "Be brief. Cite sources",
      overridden: true,
    });
    await controller.handle({ type: "setInstructions", text: "Answer in French" });
    expect(controller.snapshot().instructions).toEqual({
      conversation: "Answer in French",
      effective: "Be brief. Answer in French",
      overridden: true,
    });
    // "Use my instructions" sends the null that clears the conversation's own text.
    await controller.handle({ type: "setInstructions", text: null });
    expect(JSON.parse(String(calls.filter((c) => c.method === "PUT").at(-1)?.body))).toEqual({ text: null });
    expect(controller.snapshot().instructions?.conversation).toBeNull();
  });

  it("answers a plan-gated 402 with an upgrade notice, not an error banner", async () => {
    const { controller } = await setup();
    await controller.refresh();
    await controller.openConversation("c_1");
    manage(controller, { "PUT /api/conversations/c_1/instructions": () => json({ detail: "not on this plan" }, 402) });
    await controller.handle({ type: "setInstructions", text: "Be brief" });
    const state = controller.snapshot();
    expect(state.error).toBeNull();
    expect(state.notice).toContain("plan");
    expect(state.instructions).toBeNull();
  });

  it("shows no badge while the conversation carries no instructions", async () => {
    const { controller } = await setup();
    await controller.refresh();
    await controller.openConversation("c_1");
    expect(controller.snapshot().instructions).toBeNull();
  });
});

describe("the vision gate", () => {
  const image = { blob: new Blob(["x"], { type: "image/png" }), filename: "shot.png" };

  it("refuses an image for a model with supports_vision false, naming vision-capable models, and uploads nothing", async () => {
    const { controller, calls, webview } = await setup();
    await controller.refresh(); // grt-small is the default and cannot see.
    await controller.sendAttachment("What is this?", image);
    expect(calls.some((c) => c.url.startsWith("/api/attachments"))).toBe(false);
    const notice = lastState(webview.posted).notice ?? "";
    expect(notice).toContain("GRT Small cannot see images");
    expect(notice).toContain("Partner X");
  });

  it("passes for a vision-capable model and uploads", async () => {
    const { controller, calls } = await setup();
    await controller.refresh();
    const partner = MODELS.data.find((m) => m.id === "partner-x") as ModelInfo;
    expect(controller.setModel(partner)).toBe(true);
    await controller.sendAttachment("What is this?", image);
    expect(calls.some((c) => c.url.startsWith("/api/attachments"))).toBe(true);
  });

  it("passes when the list does not say, leaving the server's 422 as the backstop", async () => {
    const { controller, calls } = await setup();
    await controller.refresh();
    const unknown = { ...(MODELS.data[0] as ModelInfo), id: "mystery", label: "Mystery", supports_vision: null };
    expect(controller.setModel(unknown)).toBe(true);
    await controller.sendAttachment("What is this?", image);
    expect(calls.some((c) => c.url.startsWith("/api/attachments"))).toBe(true);
  });
});

describe("the API's wire shapes", () => {
  function withRoutes(controller: ChatController, extra: Record<string, (call: Call) => Response>) {
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

describe("slash commands", () => {
  it("runs the built-ins instead of sending a message", async () => {
    const { controller, calls, runCommands } = await setup({
      "POST /api/conversations/c_1/compact": () => json(USER, 200),
    });
    await controller.refresh();
    await controller.openConversation("c_1");

    await controller.send("/model");
    expect(runCommands).toContain("pickModel");

    await controller.send("/compact");
    expect(calls.some((c) => c.method === "POST" && c.url === "/api/conversations/c_1/compact")).toBe(true);

    await controller.send("/share");
    await controller.send("/export");
    expect(runCommands).toContain("shareConversation");
    expect(runCommands).toContain("exportConversation");

    expect(calls.some((c) => c.url === "/api/conversations/c_1/messages")).toBe(false);
  });

  it("clears the conversation with /clear", async () => {
    const { controller } = await setup();
    await controller.refresh();
    await controller.openConversation("c_1");
    expect(controller.hasConversation()).toBe(true);
    await controller.send("/clear");
    expect(controller.hasConversation()).toBe(false);
    expect(controller.snapshot().transcript).toEqual([]);
  });

  it("expands a saved prompt, appending arguments on a new line", async () => {
    const { controller, calls } = await setup(
      {},
      { prompts: { get: async (name) => (name === "review" ? "Review this diff for safety." : null) } },
    );
    await controller.refresh();
    await controller.send("/review focus on auth");

    const send = calls.find((c) => c.url === "/api/conversations/c_1/messages");
    expect(JSON.parse(String(send?.body)).content).toBe("Review this diff for safety.\n\nfocus on auth");
  });

  it("says so when no prompt by that name is saved, and sends nothing", async () => {
    const { controller, calls, webview } = await setup({}, { prompts: { get: async () => null } });
    await controller.refresh();
    await controller.send("/nosuch");

    expect(calls.some((c) => c.url === "/api/conversations/c_1/messages")).toBe(false);
    expect(lastState(webview.posted).notice).toContain("No prompt named “/nosuch”");
  });

  it("lets //esc carry a literal slash command as the message", async () => {
    const { controller, calls } = await setup();
    await controller.refresh();
    await controller.send("//clear");
    const send = calls.find((c) => c.url === "/api/conversations/c_1/messages");
    expect(JSON.parse(String(send?.body)).content).toBe("/clear");
  });
});

describe("apply code to a file", () => {
  const ANSWER = {
    ...USER,
    id: "a_code",
    role: "assistant",
    parts: [{ type: "text", text: "Use this:\n\n```python api/jobs.py\nprint(1)\n```\n" }],
    content: "",
  };

  const answerRoutes = {
    "GET /api/conversations/c_1": () => json({ ...CONVERSATION, messages: [USER, ANSWER] }),
    "GET /api/conversations/c_1/tree": () => json({ ...CONVERSATION, messages: [USER, ANSWER] }),
  };

  it("hands the named block to the host's apply flow", async () => {
    const applied: { messageId: string; block: unknown }[] = [];
    const { controller, fromWebview } = await setup(answerRoutes);
    controller["deps"].applyCode = async (request) => void applied.push(request);
    await controller.refresh();
    await controller.openConversation("c_1");
    await fromWebview({ type: "applyCodeBlock", messageId: "a_code", blockIndex: 0 });

    expect(applied).toEqual([
      { messageId: "a_code", block: { index: 0, language: "python", filename: "api/jobs.py", code: "print(1)" } },
    ]);
  });

  it("says so rather than applying when the block is gone", async () => {
    const applied: unknown[] = [];
    const { controller, webview, fromWebview } = await setup(answerRoutes);
    controller["deps"].applyCode = async (request) => void applied.push(request);
    await controller.refresh();
    await controller.openConversation("c_1");
    await fromWebview({ type: "applyCodeBlock", messageId: "a_code", blockIndex: 9 });

    expect(applied).toEqual([]);
    expect(lastState(webview.posted).notice).toContain("no longer in the conversation");
  });
});

describe("inline edit", () => {
  it("answers with the completed turn's text", async () => {
    const { controller } = await setup();
    await controller.refresh();
    expect(await controller.ask("Rewrite this.")).toBe("It is 10:00 UTC.");
  });

  it("answers null while a turn is already running, without disturbing it", async () => {
    const lines = fixture("turn.sse").split("\n");
    const enc = new TextEncoder();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { controller, calls } = await setup({
      "POST /api/conversations/c_1/messages": () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(c) {
              c.enqueue(enc.encode(lines.slice(0, 3).join("\n") + "\n"));
              await held;
              c.enqueue(enc.encode(lines.slice(3).join("\n")));
              c.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
    });
    await controller.refresh();
    const first = controller.send("A question");
    await vi.waitFor(() => expect(controller.snapshot().streaming).toBe(true));
    expect(await controller.ask("Too soon.")).toBeNull();
    release();
    await first;
    // The first turn went out untouched: exactly one send, with its own text.
    const messageCalls = calls.filter((c) => c.method === "POST" && c.url === "/api/conversations/c_1/messages");
    expect(messageCalls).toHaveLength(1);
    expect(JSON.parse(String(messageCalls[0]?.body)).content).toBe("A question");
  });

  it("answers null when the turn failed", async () => {
    const { controller } = await setup({ "POST /api/conversations/c_1/messages": () => json({ detail: "down" }, 503) });
    await controller.refresh();
    expect(await controller.ask("Rewrite this.")).toBeNull();
  });
});

describe("notifications and usage", () => {
  it("loads the bell and the allowance with the rest of the state", async () => {
    const { controller, statuses } = await setup();
    await controller.refresh();
    const state = controller.snapshot();
    expect(state.notifications).toEqual([
      { id: "n_1", kind: "budget", title: "Budget low", body: "80% of the allowance is used.", link: null, createdAt: NOTIFICATION.created_at, read: false },
    ]);
    expect(state.unreadNotifications).toBe(1);
    expect(state.usage).toEqual({
      used: 4_000_000,
      included: 5_000_000,
      percent: 80,
      state: "warn",
      resetsAt: USAGE.resets_at,
      planName: "Team",
      memberCap: null,
    });
    // The status bar learns both, for its badge and its tooltip line.
    expect(statuses.at(-1)).toMatchObject({ unreadNotifications: 1, usage: state.usage });
  });

  it("re-reads the bell on the webview's ask, without a full refresh", async () => {
    const { controller } = await setup();
    await controller.refresh();
    const calls = manage(controller, {});
    await controller.handle({ type: "refreshNotifications" });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET /api/me/notifications?limit=30"]);
    expect(controller.snapshot().unreadNotifications).toBe(1);
  });

  it("marks one read, then all, and the badge follows the answers", async () => {
    const { controller } = await setup();
    await controller.refresh();
    const calls = manage(controller, {
      "POST /api/me/notifications/n_1/read": (call) => {
        expect(JSON.parse(String(call.body))).toEqual({});
        return json({ ...NOTIFICATION, read_at: NOTIFICATION.created_at, unread_count: 0 });
      },
      "POST /api/me/notifications/read-all": () => json({ read: 1 }),
    });
    await controller.handle({ type: "readNotification", id: "n_1" });
    expect(calls.find((c) => c.url === "/api/me/notifications/n_1/read")?.method).toBe("POST");
    expect(controller.snapshot().unreadNotifications).toBe(0);
    expect(controller.snapshot().notifications?.every((n) => n.read)).toBe(true);

    // The rows reset with the next full refresh; mark-all clears whatever remains.
    await controller.refresh();
    expect(controller.snapshot().unreadNotifications).toBe(1);
    await controller.handle({ type: "readAllNotifications" });
    expect(calls.find((c) => c.url === "/api/me/notifications/read-all")?.method).toBe("POST");
    expect(controller.snapshot().unreadNotifications).toBe(0);
    expect(controller.snapshot().notifications?.every((n) => n.read)).toBe(true);
  });

  it("surfaces a refused mark-read through the error banner", async () => {
    const { controller } = await setup();
    await controller.refresh();
    manage(controller, { "POST /api/me/notifications/n_1/read": () => json({ detail: "No such notification" }, 404) });
    await controller.handle({ type: "readNotification", id: "n_1" });
    expect(controller.snapshot().error).not.toBeNull();
    // The row stays as it was: unread, since the API refused the mark.
    expect(controller.snapshot().notifications?.[0]?.read).toBe(false);
  });

  it("keeps a deployment without the routes quiet, not in the error banner", async () => {
    const { controller } = await setup();
    manage(controller, {
      "GET /api/me/notifications": () => json({ detail: "no such route" }, 404),
      "GET /api/me/usage": () => json({ detail: "no such route" }, 404),
    });
    await controller.refresh();
    const state = controller.snapshot();
    expect(state.notifications).toBeNull();
    expect(state.unreadNotifications).toBe(0);
    expect(state.notificationsComplete).toBe(true);
    expect(state.usage).toBeNull();
    expect(state.error).toBeNull();
  });
});

describe("notification pagination and the unread filter", () => {
  /** A listing of `n` unread rows, n_1 newest. */
  function page(n: number) {
    return {
      data: Array.from({ length: n }, (_, i) => ({ ...NOTIFICATION, id: `n_${i + 1}`, title: `Row ${i + 1}` })),
      unread_count: n,
    };
  }

  it("reads a first page with a limit, and Load more widens the window", async () => {
    const { controller } = await setup();
    const calls = manage(controller, {
      "GET /api/me/notifications": (call) => {
        const limit = Number(new URL(`https://mw.test${call.url}`).searchParams.get("limit"));
        return json(page(Math.min(limit, 45)));
      },
    });
    await controller.refresh();
    // The refresh reads me, models and the lists beside the bell; the bell's own asks are what these tests follow.
    const notes = () => calls.filter((c) => c.url.startsWith("/api/me/notifications"));
    expect(notes()[0]?.url).toBe("/api/me/notifications?limit=30");
    // A full page means older rows may exist.
    expect(controller.snapshot().notifications).toHaveLength(30);
    expect(controller.snapshot().notificationsComplete).toBe(false);

    await controller.handle({ type: "loadMoreNotifications" });
    expect(notes()[1]?.url).toBe("/api/me/notifications?limit=60");
    // The wider window replaces the panel's rows; a short answer is the whole selection.
    expect(controller.snapshot().notifications).toHaveLength(45);
    expect(controller.snapshot().notificationsComplete).toBe(true);

    // Nothing left to ask for: the intent goes nowhere near the API.
    await controller.handle({ type: "loadMoreNotifications" });
    expect(notes()).toHaveLength(2);
  });

  it("keeps the panel's rows when a wider window would not load, without the error banner", async () => {
    const { controller } = await setup();
    manage(controller, {
      "GET /api/me/notifications": (call) => {
        const limit = Number(new URL(`https://mw.test${call.url}`).searchParams.get("limit"));
        return json(page(Math.min(limit, 30)));
      },
    });
    await controller.refresh();
    expect(controller.snapshot().notificationsComplete).toBe(false);
    const failing = manage(controller, { "GET /api/me/notifications": () => json({ detail: "the page would not come" }, 404) });
    await controller.handle({ type: "loadMoreNotifications" });
    expect(failing).toHaveLength(1);
    expect(controller.snapshot().error).toBeNull();
    expect(controller.snapshot().notifications).toHaveLength(30);
    expect(controller.snapshot().notificationsComplete).toBe(false);
  });

  it("lists only the unread rows while the filter is on, and reads from the top when it turns off", async () => {
    const { controller } = await setup();
    await controller.refresh();
    const calls = manage(controller, {
      "GET /api/me/notifications": () => json(page(3)),
    });
    await controller.handle({ type: "setNotificationsUnreadOnly", on: true });
    expect(calls[0]?.url).toBe("/api/me/notifications?unread=1&limit=30");
    expect(controller.snapshot().notificationsUnreadOnly).toBe(true);
    expect(controller.snapshot().notifications).toHaveLength(3);

    // Off again: a fresh window, without the filter.
    await controller.handle({ type: "setNotificationsUnreadOnly", on: false });
    expect(calls[1]?.url).toBe("/api/me/notifications?limit=30");
    expect(controller.snapshot().notificationsUnreadOnly).toBe(false);
  });

  it("re-reads the filtered view after mark-all-read, so the panel shows the empty selection", async () => {
    const { controller } = await setup();
    await controller.refresh();
    let allRead = false;
    const calls = manage(controller, {
      "GET /api/me/notifications": () => json(allRead ? { data: [], unread_count: 0 } : page(2)),
      "POST /api/me/notifications/read-all": () => {
        allRead = true;
        return json({ read: 2 });
      },
    });
    await controller.handle({ type: "setNotificationsUnreadOnly", on: true });
    await controller.handle({ type: "readAllNotifications" });
    expect(calls.find((c) => c.url === "/api/me/notifications/read-all")?.method).toBe("POST");
    // The last read is the filtered listing, emptied by the mark-all.
    expect(calls.at(-1)?.url).toBe("/api/me/notifications?unread=1&limit=30");
    expect(controller.snapshot().notifications).toHaveLength(0);
    expect(controller.snapshot().unreadNotifications).toBe(0);
  });
});

describe("presets", () => {
  const PRESET_REVIEW = {
    id: "preset_review",
    name: "Code Review",
    description: "Careful diff review.",
    model: "grt-large",
    system_prompt: "Check edge cases.",
    temperature: 0.2,
    tools: [],
    knowledge_source_ids: [],
    welcome_message: "Paste a diff or name a file to review.",
    limits: {},
    created_at: "2026-10-18T10:00:00+00:00",
    updated_at: "2026-10-18T10:00:00+00:00",
  };

  it("picks and clears a preset on an open conversation, fixes the model, and exposes the welcome message", async () => {
    let activePresetId: string | null = null;
    const { controller, calls, fromWebview, runCommands } = await setup({
      "GET /api/org/presets": () => json({ data: [PRESET_REVIEW] }),
      "GET /api/conversations": () => json({ data: [{ ...CONVERSATION, default_model: "grt-small" }], filter: "default" }),
      "GET /api/conversations/c_1": () =>
        json({
          ...CONVERSATION,
          default_model: "grt-small",
          preset_id: activePresetId,
          preset: activePresetId ? { id: PRESET_REVIEW.id, name: PRESET_REVIEW.name } : null,
          messages: [],
        }),
      "GET /api/conversations/c_1/tree": () =>
        json({
          ...CONVERSATION,
          default_model: "grt-small",
          preset_id: activePresetId,
          preset: activePresetId ? { id: PRESET_REVIEW.id, name: PRESET_REVIEW.name } : null,
          messages: [],
        }),
      "PATCH /api/conversations/c_1": (call) => {
        const body = JSON.parse(String(call.body));
        if ("preset_id" in body) activePresetId = body.preset_id;
        return json({
          ...CONVERSATION,
          default_model: "grt-small",
          preset_id: activePresetId,
          preset: activePresetId ? { id: PRESET_REVIEW.id, name: PRESET_REVIEW.name } : null,
        });
      },
    });
    await fromWebview({ type: "ready" });
    await fromWebview({ type: "openConversation", id: "c_1" });
    expect(controller.snapshot().hasPresets).toBe(true);
    expect(controller.snapshot().preset).toBeNull();
    expect(controller.snapshot().model?.id).toBe("grt-small");

    await fromWebview({ type: "pickPreset" });
    expect(runCommands).toContain("choosePreset");

    await controller.setPreset("preset_review");
    const patchPick = calls.find((c) => c.method === "PATCH" && c.url === "/api/conversations/c_1");
    expect(JSON.parse(String(patchPick?.body))).toEqual({ preset_id: "preset_review" });
    expect(controller.snapshot().preset).toEqual({
      id: "preset_review",
      name: "Code Review",
      welcomeMessage: "Paste a diff or name a file to review.",
    });
    expect(controller.snapshot().model?.id).toBe("grt-large");

    // Attempting to change the model while a preset is active is refused with a one-line notice.
    const smallModel = MODELS.data.find((m) => m.id === "grt-small") as ModelInfo;
    controller.setModel(smallModel);
    expect(controller.snapshot().model?.id).toBe("grt-large");
    expect(controller.snapshot().notice).toBe("Model is fixed to GRT Large by the Code Review preset; choose No preset to change it.");

    // Clearing back to "No preset" sends preset_id: null and restores the conversation's own model.
    await controller.setPreset(null);
    const patches = calls.filter((c) => c.method === "PATCH" && c.url === "/api/conversations/c_1");
    expect(JSON.parse(String(patches.at(-1)?.body))).toEqual({ preset_id: null });
    expect(controller.snapshot().preset).toBeNull();
    expect(controller.snapshot().model?.id).toBe("grt-small");
  });

  it("passes preset_id on POST /api/conversations when picked before the first message", async () => {
    const { controller, calls, fromWebview } = await setup({
      "GET /api/org/presets": () => json({ data: [PRESET_REVIEW] }),
      "POST /api/conversations": () =>
        json(
          {
            ...CONVERSATION,
            preset_id: "preset_review",
            preset: { id: "preset_review", name: "Code Review" },
          },
          201,
        ),
    });
    await fromWebview({ type: "ready" });
    await controller.setPreset("preset_review");
    expect(controller.snapshot().preset).toEqual({
      id: "preset_review",
      name: "Code Review",
      welcomeMessage: "Paste a diff or name a file to review.",
    });
    expect(controller.snapshot().model?.id).toBe("grt-large");

    await fromWebview({ type: "send", content: "Review this." });
    const createCall = calls.find((c) => c.method === "POST" && c.url === "/api/conversations");
    expect(JSON.parse(String(createCall?.body))).toEqual({ model: "grt-small", preset_id: "preset_review" });
  });

  it("names a deleted preset on a conversation that uses it and never offers it to a new conversation", async () => {
    const retired = {
      ...PRESET_REVIEW,
      id: "preset_retired",
      name: "Retired Reviewer",
      welcome_message: "Legacy welcome.",
    };
    const { controller, calls, fromWebview } = await setup({
      "GET /api/org/presets": () => json({ data: [] }),
      "GET /api/org/presets/preset_retired": () => json(retired),
      "GET /api/conversations": () =>
        json({
          data: [{ ...CONVERSATION, preset_id: "preset_retired", preset: { id: "preset_retired", name: "Retired Reviewer" } }],
          filter: "default",
        }),
      "GET /api/conversations/c_1": () =>
        json({
          ...CONVERSATION,
          preset_id: "preset_retired",
          preset: { id: "preset_retired", name: "Retired Reviewer" },
          messages: [],
        }),
      "GET /api/conversations/c_1/tree": () =>
        json({
          ...CONVERSATION,
          preset_id: "preset_retired",
          preset: { id: "preset_retired", name: "Retired Reviewer" },
          messages: [],
        }),
    });
    await fromWebview({ type: "ready" });
    expect(controller.snapshot().hasPresets).toBe(false);
    expect(controller.snapshot().preset).toBeNull();

    await fromWebview({ type: "openConversation", id: "c_1" });
    expect(calls.some((c) => c.method === "GET" && c.url === "/api/org/presets/preset_retired")).toBe(true);
    expect(controller.snapshot().preset).toEqual({
      id: "preset_retired",
      name: "Retired Reviewer",
      welcomeMessage: "Legacy welcome.",
    });
    expect(controller.snapshot().model?.id).toBe("grt-large");

    // Starting a new chat clears the retired preset and never offers it in availablePresets().
    controller.newChat();
    expect(controller.snapshot().preset).toBeNull();
    expect(controller.availablePresets()).toEqual([]);
    expect(controller.retiredConversationPreset()).toBeNull();
  });
});

describe("the page itself", () => {
  it("allows images from data: URIs beside the extension's own, and scripts only with the nonce", () => {
    const html = chatHtml({ cspSource: "vscode-resource:", scriptUri: "vscode-resource:/webview.js", nonce: "abc123" });
    expect(html).toContain("img-src vscode-resource: data:");
    expect(html).toContain("script-src 'nonce-abc123'");
    expect(html).toContain("style-src 'nonce-abc123'");
    // No network at all: the page could not reach the API even with something to reach it with.
    expect(html).not.toContain("connect-src");
  });

  it("is a labelled main landmark with one polite status region, not an application", () => {
    const html = chatHtml({ cspSource: "vscode-resource:", scriptUri: "vscode-resource:/webview.js", nonce: "abc123" });
    expect(html).not.toContain('role="application"');
    expect(html).toContain('<main id="app" aria-label="MatterWave chat"></main>');
    expect(html).toContain('<div id="announcer" class="sr-only" role="status" aria-live="polite"></div>');
  });
});
