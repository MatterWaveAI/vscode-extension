import {
  APIError,
  AuthenticationError,
  errorFromResponse,
  GRT_HF_MODELS,
  GRT_HF_ORG,
  GRT_HF_ORG_URL,
  IDEMPOTENCY_HEADER,
  MATTERWAVE_PROVIDER_NAME,
  MatterWave,
  MatterWaveConfigError,
  MatterWaveError,
  ORG_HEADER,
  PRESET_HEADER,
  RateLimitError,
  setSleep,
  TEMPORARY_HEADER,
  UnprocessableEntityError,
  VERSION,
} from "../src/lib/matterwaveClient";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MatterWaveClient, requestLogLine, type RequestLogEntry } from "../src/api/client";
import { ApiError, parseRetryAfter } from "../src/api/errors";
import { CONVERSATION, fakeFetch, fixture, json, sse } from "./fakeApi";

// The SDK pauses before a resume and between its own retries; the tests
// measure what it asked for, not the clock.
const sdkSleeps: number[] = [];
let restoreSleep: (ms: number) => Promise<void>;
beforeAll(() => {
  restoreSleep = setSleep(async (ms) => void sdkSleeps.push(ms));
});
afterAll(() => setSleep(restoreSleep));

function client(routes: Parameters<typeof fakeFetch>[0], extra: { sleeps?: number[]; ids?: string[] } = {}) {
  const fake = fakeFetch(routes);
  const api = new MatterWaveClient({
    baseUrl: "https://mw.test/",
    getToken: async () => "mw_abcdefgh_secret",
    fetch: fake.fetch,
    sleep: async (ms) => void extra.sleeps?.push(ms),
    onRequestId: (id) => void extra.ids?.push(id),
  });
  return { api, calls: fake.calls };
}

describe("MatterWaveClient", () => {
  it("sends the bearer and strips a trailing slash from the base URL", async () => {
    const { api, calls } = client({ "GET /api/me": () => json({ subject: "u1" }) });
    await api.me();
    expect(calls[0]?.url).toBe("/api/me");
    expect(calls[0]?.headers.Authorization).toBe("Bearer mw_abcdefgh_secret");
  });

  it("sends no bearer to the device endpoints", async () => {
    const { api, calls } = client({ "POST /api/auth/device": () => json({ device_code: "d" }) });
    await api.startDeviceLogin("VS Code");
    expect(calls[0]?.headers.Authorization).toBeUndefined();
    expect(JSON.parse(String(calls[0]?.body))).toEqual({ client_name: "VS Code" });
  });

  it("captures X-Request-Id and the detail from an error", async () => {
    const ids: string[] = [];
    const { api } = client(
      { "POST /api/conversations/c_1/compact": () => json({ detail: "Nothing to fold" }, 409, { "X-Request-Id": "req-409" }) },
      { ids },
    );
    const error = await api.compact("c_1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, detail: "Nothing to fold", requestId: "req-409" });
    expect(ids).toContain("req-409");
  });

  it("honours Retry-After on a 429 and then succeeds", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const { api } = client(
      { "GET /api/models": () => (n++ === 0 ? json({ detail: "slow" }, 429, { "Retry-After": "3" }) : json({ data: [], default_model: null })) },
      { sleeps },
    );
    await expect(api.models()).resolves.toEqual({ data: [], default_model: null });
    expect(sleeps).toEqual([3000]);
  });

  it("does not wait out a Retry-After longer than it is willing to", async () => {
    const sleeps: number[] = [];
    const { api } = client({ "GET /api/me": () => json({ detail: "later" }, 429, { "Retry-After": "600" }) }, { sleeps });
    await expect(api.me()).rejects.toMatchObject({ status: 429, retryAfterS: 600 });
    expect(sleeps).toEqual([]);
  });

  it("parses Retry-After as seconds or an HTTP date", () => {
    expect(parseRetryAfter("5")).toBe(5);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6);
    expect(parseRetryAfter("soon")).toBeNull();
  });

  it("returns device-token errors as values", async () => {
    const { api } = client({ "POST /api/auth/device/token": () => json({ error: "slow_down" }, 400) });
    await expect(api.pollDeviceToken("d")).resolves.toEqual({ ok: false, error: "slow_down" });
  });

  it("uploads a file as multipart with its filename", async () => {
    const { api, calls } = client({ "POST /api/attachments": () => json({ id: "att_1", filename: "src/a.ts" }, 201) });
    await api.uploadAttachment(new Blob(["x"], { type: "text/plain" }), "src/a.ts", "c_1");
    expect(calls[0]?.url).toBe("/api/attachments?conversation_id=c_1");
    const form = calls[0]?.body as FormData;
    const file = form.get("file") as File;
    expect(file.name).toBe("src/a.ts");
    expect(file.type).toBe("text/plain");
    expect(calls[0]?.headers["Content-Type"]).toBeUndefined();
  });

  it("resumes a cut stream with Last-Event-ID instead of sending the prompt again", async () => {
    let posts = 0;
    const { api, calls } = client({
      "POST /api/conversations/c_1/messages": () => (posts++ === 0 ? sse(fixture("cut.sse")) : sse(fixture("resume.sse"))),
    });
    const frames = [];
    for await (const frame of api.sendMessage("c_1", { content: "What time is it?" })) frames.push(frame);
    expect(frames.map((f) => f.event)).toEqual(["message", "part_start", "delta", "delta", "part_end", "done"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers["Last-Event-ID"]).toBeUndefined();
    expect(calls[1]?.headers["Last-Event-ID"]).toBe("gen_7f3a:1");
  });

  it("ends a cut stream with nothing to resume from as a truncated error", async () => {
    const { api } = client({ "POST /api/conversations/c_1/messages/m_1/regenerate": () => sse('event: message\ndata: {"id": "m_0"}\n\n') });
    const frames = [];
    for await (const frame of api.regenerate("c_1", "m_1", {})) frames.push(frame);
    expect(frames.map((f) => f.event)).toEqual(["message", "error"]);
    expect(frames.at(-1)).toMatchObject({ event: "error", code: "truncated" });
  });

  it("does not retry or resume a refused turn", async () => {
    const { api, calls } = client({ "POST /api/conversations/c_1/messages": () => json({ detail: "budget exhausted" }, 402) });
    const run = async () => {
      for await (const frame of api.sendMessage("c_1", { content: "hi" })) void frame;
    };
    await expect(run()).rejects.toMatchObject({ status: 402, detail: "budget exhausted", requestId: "req-test" });
    expect(calls).toHaveLength(1);
  });

  it("never retries a turn the API may have applied, even on a 5xx", async () => {
    const { api, calls } = client({ "POST /api/conversations/c_1/messages": () => json({ detail: "boom" }, 503) });
    const run = async () => {
      for await (const frame of api.sendMessage("c_1", { content: "hi" })) void frame;
    };
    await expect(run()).rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(1);
  });

  it("reports a dead network as status 0 and tells the reachability callback", async () => {
    const online: boolean[] = [];
    const api = new MatterWaveClient({
      baseUrl: "https://mw.test",
      getToken: async () => "mw_abcdefgh_secret",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
      onReachability: (value) => void online.push(value),
    });
    await expect(api.listConversations()).rejects.toMatchObject({ status: 0 });
    expect(online).toContain(false);
  });

  it("renames and sets the conversation's default model through PATCH", async () => {
    const { api, calls } = client({ "PATCH /api/conversations/c_1": () => json(CONVERSATION) });
    await api.updateConversation("c_1", { title: "New name" });
    expect(calls[0]?.url).toBe("/api/conversations/c_1");
    expect(JSON.parse(String(calls[0]?.body))).toEqual({ title: "New name" });
    // `default_model: null` clears back to the deployment's default, so the key is sent even when null.
    await api.updateConversation("c_1", { default_model: null });
    expect(JSON.parse(String(calls[1]?.body))).toEqual({ default_model: null });
  });

  it("toggles pin, archive and delete over the sidebar's routes", async () => {
    const { api, calls } = client({
      "PUT /api/conversations/c_1/pin": () => json({ ...CONVERSATION, pinned_at: CONVERSATION.created_at }),
      "DELETE /api/conversations/c_1/pin": () => json(CONVERSATION),
      "PUT /api/conversations/c_1/archive": () => json({ ...CONVERSATION, archived_at: CONVERSATION.created_at }),
      "DELETE /api/conversations/c_1/archive": () => json(CONVERSATION),
      "DELETE /api/conversations/c_1": () => json({ status: "deleted" }),
    });
    await api.pinConversation("c_1", true);
    await api.pinConversation("c_1", false);
    await api.archiveConversation("c_1", true);
    await api.archiveConversation("c_1", false);
    await api.deleteConversation("c_1");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "PUT /api/conversations/c_1/pin",
      "DELETE /api/conversations/c_1/pin",
      "PUT /api/conversations/c_1/archive",
      "DELETE /api/conversations/c_1/archive",
      "DELETE /api/conversations/c_1",
    ]);
    expect(calls.every((c) => c.body === undefined)).toBe(true);
  });

  it("searches, shares and rates over the same routes the web app uses", async () => {
    const { api, calls } = client({
      "GET /api/conversations/search": () => json({ data: [{ ...CONVERSATION, snippet: "the clock" }], query: "clock" }),
      "POST /api/conversations/c_1/share": () => json({ share: { id: "s_1" }, token: "tok", path: "/share/tok" }, 201),
      "PUT /api/messages/m_1/feedback": () => json({ message_id: "m_1", rating: 1 }),
      "DELETE /api/messages/m_1/feedback": () => json({ status: "removed" }),
    });
    const hits = await api.searchConversations("clock");
    expect(calls[0]?.url).toBe("/api/conversations/search?q=clock");
    expect(hits).toEqual([{ ...CONVERSATION, snippet: "the clock" }]);
    const share = await api.createShare("c_1");
    expect(JSON.parse(String(calls[1]?.body))).toEqual({});
    expect(share).toMatchObject({ token: "tok", path: "/share/tok" });
    await api.setFeedback("m_1", { rating: -1 });
    expect(JSON.parse(String(calls[2]?.body))).toEqual({ rating: -1 });
    await api.deleteFeedback("m_1");
    expect(calls[3]?.method).toBe("DELETE");
  });

  it("creates a temporary conversation only when asked, with the key omitted otherwise", async () => {
    const { api, calls } = client({ "POST /api/conversations": () => json(CONVERSATION, 201) });
    await api.createConversation({ model: "grt-small" });
    expect(JSON.parse(String(calls[0]?.body))).toEqual({ model: "grt-small" });
    await api.createConversation({ model: "grt-small", temporary: true });
    expect(JSON.parse(String(calls[1]?.body))).toEqual({ model: "grt-small", temporary: true });
    await api.createConversation({ temporary: false });
    expect(JSON.parse(String(calls[2]?.body))).toEqual({});
  });

  it("reads and writes instructions over the three routes", async () => {
    const effective = {
      org: "Be brief.",
      user: { about: "Ada", style: "Terser" },
      conversation: null,
      user_overridden: false,
      effective: "Be brief.",
    };
    const { api, calls } = client({
      "GET /api/me/instructions": () => json({ about: "Ada", style: "Terser" }),
      "PUT /api/me/instructions": (call) => {
        expect(JSON.parse(String(call.body))).toEqual({ about: "About Ada", style: null });
        return json({ about: "About Ada", style: null });
      },
      "GET /api/org/instructions": () => json({ about: "Be brief.", style: null }),
      "PUT /api/conversations/c_1/instructions": (call) => {
        // The answer carries the layers as they now stand: the text rides back
        // as `conversation`, and clearing it falls back to the person's own.
        const text = (JSON.parse(String(call.body)) as { text: string | null }).text;
        return json({
          ...effective,
          conversation: text,
          user_overridden: text !== null,
          effective: text === null ? effective.effective : `${effective.effective} ${text}`,
        });
      },
    });
    await expect(api.myInstructions()).resolves.toEqual({ about: "Ada", style: "Terser" });
    await api.updateMyInstructions({ about: "About Ada", style: null });
    await expect(api.orgInstructions()).resolves.toEqual({ about: "Be brief.", style: null });
    const saved = await api.setConversationInstructions("c_1", "Cite sources");
    expect(saved).toEqual({ ...effective, conversation: "Cite sources", user_overridden: true, effective: "Be brief. Cite sources" });
    // `null` clears the conversation's own text: the key is sent, not dropped.
    await api.setConversationInstructions("c_1", null);
    expect(JSON.parse(String(calls.at(-1)?.body))).toEqual({ text: null });
  });

  it("sends the full feedback contract and reads a conversation's rows back", async () => {
    const { api, calls } = client({
      "PUT /api/messages/m_1/feedback": () => json({ message_id: "m_1", rating: -1, reasons: ["wrong"], comment: "no" }),
      "GET /api/conversations/c_1/feedback": () =>
        json({ data: [{ message_id: "m_1", rating: -1, reasons: ["wrong"], comment: "no" }] }),
    });
    await api.setFeedback("m_1", { rating: -1, reasons: ["wrong", "unhelpful"], comment: "no" });
    expect(JSON.parse(String(calls[0]?.body))).toEqual({ rating: -1, reasons: ["wrong", "unhelpful"], comment: "no" });
    await api.setFeedback("m_1", { rating: 1 });
    expect(JSON.parse(String(calls[1]?.body))).toEqual({ rating: 1 });
    await api.setFeedback("m_1", { rating: -1, comment: null });
    expect(JSON.parse(String(calls[2]?.body))).toEqual({ rating: -1, comment: null });
    const rows = await api.conversationFeedback("c_1");
    expect(rows.data).toHaveLength(1);
    expect(rows.data[0]).toMatchObject({ message_id: "m_1", rating: -1 });
    expect(calls[3]?.url).toBe("/api/conversations/c_1/feedback");
  });

  it("lists the archive with the filter the sidebar folds away", async () => {
    const { api, calls } = client({ "GET /api/conversations": () => json({ data: [], filter: "archived" }) });
    await api.listConversations({ archived: true });
    expect(calls[0]?.url).toBe("/api/conversations?filter=archived");
  });

  it("hands back a page's cursor and resumes from one", async () => {
    const { api, calls } = client({
      "GET /api/conversations": (call) =>
        call.url.includes("cursor=")
          ? json({ data: [{ ...CONVERSATION, id: "c_2" }], filter: "default", next_cursor: null })
          : json({ data: [CONVERSATION], filter: "default", next_cursor: "page-2" }),
    });
    const first = await api.listConversations();
    expect(first).toMatchObject({ nextCursor: "page-2" });
    const second = await api.listConversations({ cursor: first.nextCursor });
    expect(second.data.map((c) => c.id)).toEqual(["c_2"]);
    expect(second.nextCursor).toBeNull();
    expect(calls[1]?.url).toBe("/api/conversations?cursor=page-2");
  });

  it("walks every page at the widest page for a picker that offers them all", async () => {
    const pages: Record<string, { id: string; next: string | null }> = {
      "": { id: "c_1", next: "b" },
      b: { id: "c_2", next: "c" },
      c: { id: "c_3", next: null },
    };
    const { api, calls } = client({
      "GET /api/conversations": (call) => {
        const cursor = new URL(`https://x${call.url}`).searchParams.get("cursor") ?? "";
        const page = pages[cursor];
        return json({ data: [{ ...CONVERSATION, id: page?.id }], filter: "default", next_cursor: page?.next ?? null });
      },
    });
    expect((await api.allConversations()).map((c) => c.id)).toEqual(["c_1", "c_2", "c_3"]);
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.url.includes("limit=200"))).toBe(true);
  });

  it("lists notifications with the unread count, filtered and sized only when asked", async () => {
    const row = { id: "n_1", kind: "budget", title: "Budget low", body: "80% used", link: null, created_at: "2026-10-29T10:00:00+00:00", read_at: null };
    const { api, calls } = client({
      "GET /api/me/notifications": () => json({ data: [row], unread_count: 1 }),
      "POST /api/me/notifications/n_1/read": () => json({ ...row, read_at: row.created_at, unread_count: 0 }),
      "POST /api/me/notifications/read-all": () => json({ read: 4 }),
    });
    await expect(api.notifications()).resolves.toEqual({ data: [row], unread_count: 1 });
    expect(calls[0]?.url).toBe("/api/me/notifications");
    await api.notifications({ unreadOnly: true });
    expect(calls[1]?.url).toBe("/api/me/notifications?unread=1");
    await api.notifications({ unreadOnly: true, limit: 10 });
    expect(calls[2]?.url).toBe("/api/me/notifications?unread=1&limit=10");
    await expect(api.readNotification("n_1")).resolves.toMatchObject({ id: "n_1", unread_count: 0 });
    expect(calls[3]?.url).toBe("/api/me/notifications/n_1/read");
    expect(JSON.parse(String(calls[3]?.body))).toEqual({});
    await expect(api.readAllNotifications()).resolves.toEqual({ read: 4 });
    expect(calls[4]?.url).toBe("/api/me/notifications/read-all");
  });

  it("reads the usage report and the budget over their two routes", async () => {
    const usage = {
      unit: "weighted_tokens",
      used: 1_200_000,
      included: 5_000_000,
      remaining: 3_800_000,
      percent: 24.0,
      warn: false,
      in_overage: false,
      exhausted: false,
      period_start: "2026-10-01",
      resets_at: "2026-11-01T00:00:00+00:00",
      plan: { code: "team", name: "Team" },
    };
    const budget = {
      period_start: "2026-10-01",
      included_tokens: 5_000_000,
      tokens_used: 1_200_000,
      remaining_tokens: 3_800_000,
      overage_enabled: true,
      overage_cap_micros: 10_000_000,
      overage_micros: 0,
      member_default_cap_micros: null,
      member_cap: null,
      member_spent: 0,
      member_exhausted: false,
    };
    const { api, calls } = client({
      "GET /api/me/usage": () => json(usage),
      "GET /api/budget": () => json(budget),
    });
    await expect(api.usage()).resolves.toEqual(usage);
    expect(calls[0]?.url).toBe("/api/me/usage");
    await expect(api.budget()).resolves.toEqual(budget);
    expect(calls[1]?.url).toBe("/api/budget");
  });

  it("lists my shares and a conversation's shares, and revokes", async () => {
    const row = {
      id: "s_1",
      conversation_id: "c_1",
      title: "Clock",
      message_count: 4,
      include_attachments: false,
      created_at: "2026-10-29T10:00:00+00:00",
      expires_at: null,
      revoked_at: null,
      view_count: 2,
      status: "live",
    };
    const { api, calls } = client({
      "GET /api/me/shares": () => json({ data: [row] }),
      "GET /api/conversations/c_1/shares": () => json({ data: [row] }),
      "DELETE /api/shares/s_1": () => json({ status: "revoked" }),
    });
    await expect(api.myShares()).resolves.toEqual({ data: [row] });
    expect(calls[0]?.url).toBe("/api/me/shares");
    await expect(api.conversationShares("c_1")).resolves.toEqual({ data: [row] });
    expect(calls[1]?.url).toBe("/api/conversations/c_1/shares");
    await api.revokeShare("s_1");
    expect(calls[2]).toMatchObject({ method: "DELETE", url: "/api/shares/s_1" });
    await expect(api.revokeShare("s_gone")).rejects.toMatchObject({ status: 404 });
  });

  it("reads the library and files and tags a conversation over its routes", async () => {
    const folder = { id: "f_1", name: "Work", position: 0, created_at: "2026-10-29T10:00:00+00:00", updated_at: "2026-10-29T10:00:00+00:00" };
    const tag = { id: "t_1", name: "bug", created_at: "2026-10-29T10:00:00+00:00" };
    const { api, calls } = client({
      "GET /api/library": () => json({ folders: [folder], tags: [tag], assignments: { c_1: ["t_1"] } }),
      "POST /api/library/folders": () => json({ ...folder, id: "f_2", name: "Reading" }, 201),
      "POST /api/library/tags": () => json({ id: "t_2", name: "api", created_at: "2026-10-29T10:00:00+00:00" }, 201),
      "PUT /api/library/conversations/c_1/folder": () => json({ ...CONVERSATION, folder_id: "f_1" }),
      "PUT /api/library/conversations/c_1/tags": () => json({ conversation_id: "c_1", tag_ids: ["t_1", "t_2"] }),
      "DELETE /api/library/tags/t_2": () => json({ status: "deleted" }),
    });
    // The one read the sidebar badge draws from: folders, tags, and the tags each conversation carries.
    await expect(api.listLibrary()).resolves.toEqual({ folders: [folder], tags: [tag], assignments: { c_1: ["t_1"] } });
    expect(calls[0]?.url).toBe("/api/library");
    await api.createFolder("Reading");
    expect(JSON.parse(String(calls[1]?.body))).toEqual({ name: "Reading" });
    await api.createTag("api");
    expect(JSON.parse(String(calls[2]?.body))).toEqual({ name: "api" });
    await api.moveToFolder("c_1", "f_1");
    expect(JSON.parse(String(calls[3]?.body))).toEqual({ folder_id: "f_1" });
    // Unfiling sends the null: an omitted field would be no answer, not a move out.
    await api.moveToFolder("c_1", null);
    expect(JSON.parse(String(calls[4]?.body))).toEqual({ folder_id: null });
    await api.setTags("c_1", ["t_1", "t_2"]);
    expect(JSON.parse(String(calls[5]?.body))).toEqual({ tag_ids: ["t_1", "t_2"] });
    await api.deleteTag("t_2");
    expect(calls[6]).toMatchObject({ method: "DELETE", url: "/api/library/tags/t_2" });
    // A tag that is gone or was never the caller's is one 404.
    await expect(api.deleteTag("t_gone")).rejects.toMatchObject({ status: 404 });
  });

  it("reads an attachment's bytes as the body, not as JSON", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const { api, calls } = client({
      "GET /api/attachments/att_1/content": () =>
        new Response(bytes, { status: 200, headers: { "Content-Type": "image/png", "X-Request-Id": "req-img" } }),
    });
    const content = await api.attachmentContent("att_1");
    expect(new Uint8Array(content)).toEqual(bytes);
    expect(calls[0]).toMatchObject({ method: "GET", url: "/api/attachments/att_1/content" });
    // A refusal keeps the error contract the JSON paths have.
    await expect(
      client({ "GET /api/attachments/att_x/content": () => json({ detail: "No such attachment" }, 404) }).api.attachmentContent("att_x"),
    ).rejects.toMatchObject({ status: 404, detail: "No such attachment" });
  });

  it("creates, rotates and revokes keys over the keys routes", async () => {
    const row = {
      id: "key_1",
      prefix: "mw_newkeyne",
      name: "CI",
      scopes: ["chat:read", "chat:write"],
      created_at: "2026-10-30T00:00:00+00:00",
      previous_prefix: null,
      previous_valid_until: null,
      rotated_at: null,
      last_used_at: null,
      expires_at: null,
      revoked_at: null,
    };
    const { api, calls } = client({
      "GET /api/keys": () => json({ data: [row] }),
      "POST /api/keys": () => json({ ...row, id: "key_2", name: "VS Code", key: "mw_secret_value" }, 201),
      "POST /api/keys/key_1/rotate": () => json({ ...row, prefix: "mw_rotated1", key: "mw_new_secret" }),
      "DELETE /api/keys/key_1": () => new Response(null, { status: 204 }),
    });
    await expect(api.listKeys()).resolves.toEqual({ data: [row] });
    await expect(api.createKey("VS Code")).resolves.toMatchObject({ key: "mw_secret_value" });
    expect(JSON.parse(String(calls[1]?.body))).toEqual({ name: "VS Code" });
    await expect(api.rotateKey("key_1")).resolves.toMatchObject({ key: "mw_new_secret" });
    expect(calls[2]?.url).toBe("/api/keys/key_1/rotate");
    await api.revokeKeyById("key_1");
    expect(calls[3]).toMatchObject({ method: "DELETE", url: "/api/keys/key_1" });
  });

  it("reads the entitlements and the org instructions over their routes", async () => {
    const entitlements = { plan: "team", plan_name: "Team", limits: { features: { custom_instructions: true } } };
    const { api, calls } = client({
      "GET /api/entitlements": () => json(entitlements),
      "GET /api/org/instructions": () => json({ text: "Be brief." }),
      "PUT /api/org/instructions": (call) => {
        expect(JSON.parse(String(call.body))).toEqual({ text: "Answer in British English." });
        return json({ text: "Answer in British English." });
      },
    });
    await expect(api.entitlements()).resolves.toEqual(entitlements);
    await expect(api.orgInstructions()).resolves.toEqual({ text: "Be brief." });
    await expect(api.setOrgInstructions("Answer in British English.")).resolves.toEqual({ text: "Answer in British English." });
    expect(calls[2]?.method).toBe("PUT");
  });

  it("starts an import as multipart and reads its status back", async () => {
    const record = {
      id: "imp_1",
      status: "running",
      source: "chatgpt",
      filename: "conversations.json",
      size_bytes: 10,
      conversations_total: 3,
      conversations_done: 1,
      conversations_created: 1,
      conversations_existing: 0,
      conversations_skipped: 0,
      messages_created: 4,
      attachments_skipped: 0,
      branches_dropped: 0,
      error: null,
      created_at: "2026-10-30T00:00:00+00:00",
      started_at: "2026-10-30T00:00:01+00:00",
      completed_at: null,
    };
    const { api, calls } = client({
      "POST /api/me/imports": () => json({ ...record, status: "pending" }, 202),
      "GET /api/me/imports/imp_1": () => json(record),
    });
    await expect(api.startImport(new Blob(["{}"], { type: "application/json" }), "conversations.json")).resolves.toMatchObject({
      id: "imp_1",
      status: "pending",
    });
    const form = calls[0]?.body as FormData;
    expect((form.get("file") as File).name).toBe("conversations.json");
    await expect(api.importStatus("imp_1")).resolves.toMatchObject({ status: "running" });
    expect(calls[1]?.url).toBe("/api/me/imports/imp_1");
  });
});

describe("the request log", () => {
  it("records each request's method, path, status, request id and time -- never its query, body or key", async () => {
    const entries: RequestLogEntry[] = [];
    const fake = fakeFetch({
      "GET /api/conversations/search": () => json({ data: [], query: "private words" }),
      "POST /api/conversations": () => json(CONVERSATION, 201),
    });
    const api = new MatterWaveClient({
      baseUrl: "https://mw.test",
      getToken: async () => "mw_abcdefgh_secret",
      fetch: fake.fetch,
      onRequest: (entry) => void entries.push(entry),
    });
    await api.searchConversations("private words");
    await api.createConversation({ title: "My secret plan" });
    expect(entries.map((e) => [e.method, e.path, e.status, e.requestId, e.error])).toEqual([
      ["GET", "/api/conversations/search", 200, "req-test", null],
      ["POST", "/api/conversations", 201, "req-test", null],
    ]);
    expect(entries.every((e) => typeof e.ms === "number" && e.ms >= 0)).toBe(true);
    const logged = entries.map(requestLogLine).join("\n");
    expect(logged).not.toMatch(/private|secret|plan/);
    expect(requestLogLine(entries[0] as RequestLogEntry)).toMatch(/^GET \/api\/conversations\/search -> 200 in \d+ ms \(request req-test\)$/);
  });

  it("records a request that got no answer, with what the runtime said", async () => {
    const entries: RequestLogEntry[] = [];
    const api = new MatterWaveClient({
      baseUrl: "https://mw.test",
      getToken: async () => null,
      fetch: async () => {
        throw new Error("connect ECONNREFUSED 10.0.0.1:443");
      },
      onRequest: (entry) => void entries.push(entry),
    });
    await expect(api.models()).rejects.toMatchObject({ status: 0 });
    expect(entries[0]).toMatchObject({ method: "GET", path: "/api/models", status: null, error: "connect ECONNREFUSED 10.0.0.1:443" });
    expect(requestLogLine(entries[0] as RequestLogEntry)).toMatch(/^GET \/api\/models -> failed: connect ECONNREFUSED 10\.0\.0\.1:443 in \d+ ms$/);
  });
});

describe("fork, report, search, folders and announcements", () => {
  it("sends each to its route with the body the API takes", async () => {
    const { api, calls } = client({
      "POST /api/conversations/c_1/fork": () => json(CONVERSATION, 201),
      "POST /api/conversations/c_1/report": () => json({ id: "r_1" }, 201),
      "GET /api/search": () => json({ data: [], query: "a b", next_cursor: "n2" }),
      "PATCH /api/library/folders/f_1": () => json({ id: "f_1", name: "Renamed", position: 0, created_at: "", updated_at: "" }),
      "DELETE /api/library/folders/f_1": () => new Response(null, { status: 204 }),
      "GET /api/announcements": () => json({ data: [] }),
    });
    await api.forkConversation("c_1", "m_9");
    await api.reportConversation("c_1", { kind: "unsafe", messageId: "m_9", note: "It told me to." });
    await api.reportConversation("c_1", { kind: "unhelpful" });
    expect(await api.search("a b", "n1")).toEqual({ data: [], nextCursor: "n2" });
    await api.renameFolder("f_1", "Renamed");
    await api.deleteFolder("f_1");
    await api.announcements();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST /api/conversations/c_1/fork",
      "POST /api/conversations/c_1/report",
      "POST /api/conversations/c_1/report",
      "GET /api/search?q=a+b&cursor=n1",
      "PATCH /api/library/folders/f_1",
      "DELETE /api/library/folders/f_1",
      "GET /api/announcements",
    ]);
    expect(JSON.parse(String(calls[0]?.body))).toEqual({ message_id: "m_9" });
    expect(JSON.parse(String(calls[1]?.body))).toEqual({ kind: "unsafe", message_id: "m_9", note: "It told me to." });
    expect(JSON.parse(String(calls[2]?.body))).toEqual({ kind: "unhelpful" });
    expect(JSON.parse(String(calls[4]?.body))).toEqual({ name: "Renamed" });
  });
});

describe("key options and the account routes", () => {
  it("mints a key with its scopes and expiry, renames one, and reads the account's state", async () => {
    const { api, calls } = client({
      "POST /api/keys": () => json({ id: "k_1", name: "CI", prefix: "mw_abcdefgh", key: "mw_abcdefgh_example" }, 201),
      "PATCH /api/keys/k_1": () => json({ id: "k_1", name: "CI runner" }),
      "GET /api/me/enforcement": () => json({ state: "none" }),
      "POST /api/me/export": () => json({ id: "e_1", status: "pending" }, 202),
      "GET /api/me/export/e_1": () => json({ id: "e_1", status: "ready", download_url: "/api/me/export/e_1/download?expires=1&sig=x" }),
      "GET /api/attachments/limits/me": () => json({ max_upload_bytes: 1, quota_bytes: 2, quota_used_bytes: 0, quota_remaining_bytes: 2 }),
    });
    await api.createKey("CI", { scopes: ["chat:read"], expiresInDays: 90 });
    await api.createKey("Plain");
    await api.renameKey("k_1", "CI runner");
    expect(await api.enforcement()).toEqual({ state: "none" });
    expect((await api.startExport()).id).toBe("e_1");
    expect((await api.exportStatus("e_1")).download_url).toContain("/download");
    expect((await api.attachmentLimits()).max_upload_bytes).toBe(1);
    expect(JSON.parse(String(calls[0]?.body))).toEqual({ name: "CI", scopes: ["chat:read"], expires_in_days: 90 });
    expect(JSON.parse(String(calls[1]?.body))).toEqual({ name: "Plain" });
    expect(JSON.parse(String(calls[2]?.body))).toEqual({ name: "CI runner" });
    expect(calls.map((c) => `${c.method} ${c.url}`).slice(3)).toEqual([
      "GET /api/me/enforcement",
      "POST /api/me/export",
      "GET /api/me/export/e_1",
      "GET /api/attachments/limits/me",
    ]);
  });

  it("lists and fetches presets, and sends preset_id on conversation create and update", async () => {
    const preset = {
      id: "preset_review",
      name: "Code Review",
      description: "Careful diff review.",
      model: "grt-large",
      system_prompt: "Check edge cases.",
      temperature: 0.2,
      tools: [],
      knowledge_source_ids: [],
      welcome_message: "Paste a diff.",
      limits: {},
      created_at: "2026-10-18T10:00:00+00:00",
      updated_at: "2026-10-18T10:00:00+00:00",
    };
    const { api, calls } = client({
      "GET /api/org/presets": () => json({ data: [preset] }),
      "GET /api/org/presets/preset_old": () => json({ ...preset, id: "preset_old", name: "Legacy Preset" }),
      "POST /api/conversations": () => json({ ...CONVERSATION, preset_id: "preset_review" }, 201),
      "PATCH /api/conversations/c_1": () => json(CONVERSATION),
    });
    expect((await api.presets()).data).toEqual([preset]);
    expect((await api.preset("preset_old")).name).toBe("Legacy Preset");
    await api.createConversation({ preset_id: "preset_review" });
    await api.updateConversation("c_1", { preset_id: "preset_review" });
    await api.updateConversation("c_1", { preset_id: null });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /api/org/presets",
      "GET /api/org/presets/preset_old",
      "POST /api/conversations",
      "PATCH /api/conversations/c_1",
      "PATCH /api/conversations/c_1",
    ]);
    expect(JSON.parse(String(calls[2]?.body))).toEqual({ preset_id: "preset_review" });
    expect(JSON.parse(String(calls[3]?.body))).toEqual({ preset_id: "preset_review" });
    expect(JSON.parse(String(calls[4]?.body))).toEqual({ preset_id: null });
  });

  it("calls POST /v1/completions for FIM completions with Idempotency-Key and maps @matterwave/sdk 0.5.0 errors", async () => {
    const { api, calls } = client({
      "GET /api/me": () => json({ subject: "u1" }),
      "POST /v1/completions": () =>
        json({
          id: "cmpl_1",
          object: "text_completion",
          model: "grt-small",
          choices: [{ text: "n * n;", index: 0, finish_reason: "stop" }],
        }),
    });
    await api.me();
    expect(calls[0]?.headers[IDEMPOTENCY_HEADER]).toBeUndefined();

    const fim = await api.fimComplete({
      model: "grt-small",
      prompt: "return ",
      suffix: "\n}",
      max_tokens: 128,
      stop: ["\n\n", "<|fim_pad|>"],
    });
    expect(fim.choices[0]?.text).toBe("n * n;");
    expect(calls[1]?.method).toBe("POST");
    expect(calls[1]?.url).toBe("/v1/completions");
    expect(calls[1]?.headers[IDEMPOTENCY_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(String(calls[1]?.body))).toEqual({
      model: "grt-small",
      prompt: "return ",
      suffix: "\n}",
      max_tokens: 128,
      stop: ["\n\n", "<|fim_pad|>"],
    });

    expect(VERSION).toBe("0.5.0");
    expect(MATTERWAVE_PROVIDER_NAME).toBe("matterwave");
    expect(PRESET_HEADER).toBe("X-MatterWave-Preset-Id");
    expect(TEMPORARY_HEADER).toBe("X-MatterWave-Temporary");
    expect(ORG_HEADER).toBe("X-MatterWave-Org-Id");

    const authErr = errorFromResponse(
      new Response(JSON.stringify({ detail: "Invalid key" }), { status: 401, headers: { "x-request-id": "req-401" } }),
      JSON.stringify({ detail: "Invalid key" }),
    );
    expect(authErr).toBeInstanceOf(MatterWaveError);
    expect(authErr).toBeInstanceOf(APIError);
    expect(authErr).toBeInstanceOf(AuthenticationError);
    expect(authErr.describe()).toBe("Invalid key (status 401) request_id=req-401");

    const rateErr = errorFromResponse(
      new Response(JSON.stringify({ error: { message: "Rate limit", code: "rate_limit_exceeded" } }), {
        status: 429,
        headers: { "x-request-id": "req-429", "retry-after": "4" },
      }),
      JSON.stringify({ error: { message: "Rate limit", code: "rate_limit_exceeded" } }),
    );
    expect(rateErr).toBeInstanceOf(RateLimitError);
    expect(rateErr.retryAfter).toBe(4);
    expect(rateErr.describe()).toBe("Rate limit (status 429) [rate_limit_exceeded] request_id=req-429");

    const unprocessable = errorFromResponse(
      new Response(JSON.stringify({ detail: [{ msg: "field required" }] }), { status: 422 }),
      JSON.stringify({ detail: [{ msg: "field required" }] }),
    );
    expect(unprocessable).toBeInstanceOf(UnprocessableEntityError);
    expect(unprocessable.message).toBe("field required");

    expect(() => new MatterWave({ baseUrl: "" })).toThrow(MatterWaveConfigError);
    expect(() => new MatterWave({ baseUrl: "" })).toThrow(MatterWaveError);
  });

  it("wires connector catalog, OAuth proxy, decision trail, replay, checkpoints, reliability, guardrails, and tool planner routes", async () => {
    const { api, calls } = client({
      "GET /api/v1/oidc/config": () =>
        json({
          adapter: "zitadel",
          issuer_url: "https://idp.example.com",
          token_endpoint: "https://idp.example.com/oauth/v2/token",
          jwks_uri: "https://idp.example.com/jwks",
          admin_url: "https://idp.example.com/admin",
          project_id: "proj_1",
          connected: true,
          status: "ready",
        }),
      "POST /api/v1/agent-keys/key_1/oidc-sync": () =>
        json({
          key_id: "key_1",
          idp_client_id: "client_1",
          oidc_issuer: "https://idp.example.com",
          adapter: "zitadel",
          synced_at: "2026-11-01T00:00:00Z",
          scopes: ["chat:read", "chat:write"],
          resource_pattern: "*",
          a2a: {
            allowed_tools: ["*"],
            denied_tools: [],
            allowed_models: ["*"],
            cwd_scope: "/workspace",
            limits: { max_tokens: 100000, max_duration_seconds: 300, max_cost_usd: 25 },
          },
        }),
      "POST /api/v1/oidc/enforce-claims": () =>
        json({
          allowed: true,
          violation_claim: null,
          detail: "ok",
          effective_tools: ["read_file"],
          resolved_cwd: "/workspace",
          limits: { max_tokens: 100000, max_duration_seconds: 300, max_cost_usd: 25 },
        }),
      "GET /api/v1/connectors/catalog": () =>
        json({
          data: [
            {
              provider_id: "github",
              name: "GitHub",
              category: "developer",
              auth_types: ["oauth2"],
              authorize_url: "https://github.com/login/oauth/authorize",
              token_url: "https://github.com/login/oauth/access_token",
              api_base_url: "https://api.github.com",
              default_scopes: ["repo"],
              pkce_supported: true,
              refresh_supported: true,
              revoke_url: "",
              docs_url: "https://docs.github.com",
              icon: "github",
            },
          ],
          total: 1,
        }),
      "POST /api/v1/oauth/register": () =>
        json({
          authenticator_id: "auth_1",
          name: "GitHub Org",
          provider_id: "github",
          org_id: "org_1",
          client_id: "cid_1",
          client_secret_masked: "***",
          authorize_url: "https://github.com/login/oauth/authorize",
          token_url: "https://github.com/login/oauth/access_token",
          redirect_uri: "https://app.matterwave.ai/oauth/callback",
          scopes: ["repo"],
          api_base_url: "https://api.github.com",
          tenant_id: null,
          extra_authorize_params: {},
          created_at: "2026-11-01T00:00:00Z",
        }),
      "POST /api/v1/oauth/proxy/cred_1": () =>
        json({
          credential_id: "cred_1",
          provider_id: "github",
          method: "POST",
          target_url: "https://api.github.com/repos",
          status_code: 200,
          auto_refreshed: false,
          broker: "nango",
          headers_injected: ["Authorization"],
          data: { ok: true },
        }),
      "GET /api/v1/runs/run_1/decision-trail": () =>
        json({
          run_id: "run_1",
          org: "org_1",
          nodes: [
            {
              id: "n_1",
              type: "tool_call",
              label: "read_file",
              step_id: "s_1",
              timestamp: "2026-11-01T00:00:00Z",
              duration_ms: 10,
              confidence: 0.99,
              tokens_used: 50,
              cost_usd: 0.001,
              outcome: "success",
              rationale: "Read source",
              evidence: [],
              metadata: {},
            },
          ],
          edges: [{ from_node: "n_1", to_node: "n_2", edge_type: "next", label: "next" }],
          statistics: {
            total_nodes: 1,
            total_edges: 1,
            tool_calls_count: 1,
            total_tokens: 50,
            total_cost_usd: 0.001,
            duration_ms: 10,
            success: true,
          },
        }),
      "POST /api/v1/runs/run_1/replay": () =>
        json({
          replay_id: "replay_1",
          run_id: "run_1",
          mode: "counterfactual",
          success: true,
          original_outcome: {},
          replayed_outcome: {},
          differences: [{ step_id: "s_1", field: "output", original: "a", replayed: "b", significance: "low" }],
          duration_ms: 12,
          created_at: "2026-11-01T00:00:00Z",
        }),
      "GET /api/v1/runs/run_1/checkpoints": () =>
        json({
          run_id: "run_1",
          data: [
            {
              checkpoint_id: "cp_1",
              thread_id: "th_1",
              run_id: "run_1",
              step_id: "s_2",
              step_index: 2,
              timestamp: "2026-11-01T00:00:00Z",
              state: {},
              metadata: {},
              parent_checkpoint_id: null,
            },
          ],
        }),
      "POST /api/v1/runs/run_1/resume": () =>
        json({
          run_id: "run_2",
          source_run_id: "run_1",
          resumed_from_checkpoint_id: "cp_1",
          resumed_from_step: "s_2",
          state: "running",
          restored_state: { step: 2 },
          created_at: "2026-11-01T00:00:00Z",
        }),
      "GET /api/v1/reliability/metrics": () =>
        json({
          org: "org_1",
          agent_id: "agent_1",
          sr: 0.95,
          cr: 1.0,
          pc: 0.0125,
          hir: 0.05,
          ma: 0.98,
          tcl: 42,
          wct: 1200,
          total_runs: 20,
          window: "24h",
        }),
      "POST /api/v1/guardrails/evaluate": () =>
        json({
          rail_type: "input",
          action: "allow",
          allowed: true,
          modified_content: "hello world",
          refusal_message: null,
          triggered_rails: [],
          violations: [],
        }),
      "POST /api/v1/tools/plan": () =>
        json({
          plan_id: "plan_1",
          task: "Run unit tests and summarize failures",
          steps: [
            {
              step_id: "s_0",
              tool_name: "run_shell",
              description: "Execute test suite",
              arguments: { command: "npm test" },
              depends_on: [],
              estimated_cost_usd: 0.001,
              estimated_time_ms: 500,
              fallback_tool: null,
            },
          ],
          execution_order: [["s_0"]],
          total_estimated_cost_usd: 0.001,
          total_estimated_time_ms: 500,
          confidence: 0.95,
        }),
    });

    const oidc = await api.getOidcConfig();
    expect(oidc.connected).toBe(true);
    expect(calls[0]).toMatchObject({ method: "GET", url: "/api/v1/oidc/config" });

    const synced = await api.syncAgentKeyOidc("key_1");
    expect(synced.key_id).toBe("key_1");
    expect(calls[1]).toMatchObject({ method: "POST", url: "/api/v1/agent-keys/key_1/oidc-sync" });

    const enforced = await api.enforceOidcClaims({ key_id: "key_1", requested_tools: ["read_file"] });
    expect(enforced.allowed).toBe(true);
    expect(calls[2]).toMatchObject({ method: "POST", url: "/api/v1/oidc/enforce-claims" });

    const catalog = await api.listConnectorCatalog("developer", "git");
    expect(catalog.total).toBe(1);
    expect(calls[3]).toMatchObject({ method: "GET", url: "/api/v1/connectors/catalog?category=developer&q=git" });

    const auth = await api.registerOAuthAuthenticator({ provider_id: "github", name: "GitHub Org", client_id: "cid_1" });
    expect(auth.authenticator_id).toBe("auth_1");
    expect(calls[4]).toMatchObject({ method: "POST", url: "/api/v1/oauth/register" });

    const proxied = await api.proxyOAuthRequest("cred_1", {
      endpoint: "/repos",
      method: "POST",
      body: { name: "demo" },
      dry_run: true,
    });
    expect(proxied.status_code).toBe(200);
    expect(calls[5]).toMatchObject({ method: "POST", url: "/api/v1/oauth/proxy/cred_1" });
    expect(JSON.parse(String(calls[5]?.body))).toEqual({
      endpoint: "/repos",
      method: "POST",
      body: { name: "demo" },
      dry_run: true,
    });

    const trail = await api.getRunDecisionTrail("run_1");
    expect(trail.statistics.total_nodes).toBe(1);
    expect(calls[6]).toMatchObject({ method: "GET", url: "/api/v1/runs/run_1/decision-trail" });

    const replayed = await api.replayRun("run_1", "counterfactual", { temperature: 0 });
    expect(replayed.replay_id).toBe("replay_1");
    expect(calls[7]).toMatchObject({ method: "POST", url: "/api/v1/runs/run_1/replay" });
    expect(JSON.parse(String(calls[7]?.body))).toEqual({
      mode: "counterfactual",
      overrides: { temperature: 0 },
    });

    const checkpoints = await api.listRunCheckpoints("run_1");
    expect(checkpoints.data).toHaveLength(1);
    expect(calls[8]).toMatchObject({ method: "GET", url: "/api/v1/runs/run_1/checkpoints" });

    const resumed = await api.resumeRun("run_1", "cp_1");
    expect(resumed.run_id).toBe("run_2");
    expect(calls[9]).toMatchObject({ method: "POST", url: "/api/v1/runs/run_1/resume" });
    expect(JSON.parse(String(calls[9]?.body))).toEqual({ checkpoint_id: "cp_1" });

    const metrics = await api.getReliabilityMetrics("agent_1");
    expect(metrics.sr).toBe(0.95);
    expect(calls[10]).toMatchObject({ method: "GET", url: "/api/v1/reliability/metrics?agent_id=agent_1" });

    const guard = await api.evaluateGuardrails("input", "hello world");
    expect(guard.allowed).toBe(true);
    expect(calls[11]).toMatchObject({ method: "POST", url: "/api/v1/guardrails/evaluate" });
    expect(JSON.parse(String(calls[11]?.body))).toEqual({ rail_type: "input", content: "hello world" });

    const plan = await api.planTools("Run unit tests and summarize failures", ["run_shell"]);
    expect(plan.plan_id).toBe("plan_1");
    expect(calls[12]).toMatchObject({ method: "POST", url: "/api/v1/tools/plan" });
    expect(JSON.parse(String(calls[12]?.body))).toEqual({
      task: "Run unit tests and summarize failures",
      goal: "Run unit tests and summarize failures",
      available_tools: ["run_shell"],
    });
  });

  it("wires the 9-model MatterWaveAI GRT HF suite, POST /v1/rerank, and POST /v1/audio/speech", async () => {
    expect(GRT_HF_ORG).toBe("MatterWaveAI");
    expect(GRT_HF_ORG_URL).toBe("https://huggingface.co/MatterWaveAI");
    expect(GRT_HF_MODELS).toHaveLength(9);
    expect(GRT_HF_MODELS.map((m) => m.repo_id)).toEqual([
      "MatterWaveAI/grt-30m",
      "MatterWaveAI/grt-30m-chat",
      "MatterWaveAI/grt-30m-mor",
      "MatterWaveAI/grt-30m-embedding",
      "MatterWaveAI/grt-30m-reranker",
      "MatterWaveAI/grt-30m-vl",
      "MatterWaveAI/grt-30m-tts",
      "MatterWaveAI/grt-30m-omni",
      "MatterWaveAI/grt-30m-tokenizer",
    ]);

    const { api, calls } = client({
      "POST /v1/rerank": () =>
        json({
          model: "MatterWaveAI/grt-30m-reranker",
          results: [
            { index: 1, relevance_score: 0.96, document: { text: "Neural reranking pipeline" } },
            { index: 0, relevance_score: 0.42, document: { text: "Unrelated note" } },
          ],
        }),
      "POST /v1/audio/speech": () =>
        json({
          model: "MatterWaveAI/grt-30m-tts",
          voice: "aurora",
          format: "wav",
          sample_rate_hz: 24000,
          duration_ms: 520,
          audio_base64: "UklGRg==",
        }),
      "GET /api/v1/models/grt-suite": () =>
        json({
          organization: GRT_HF_ORG,
          hf_url: GRT_HF_ORG_URL,
          total: 9,
          models: [...GRT_HF_MODELS],
        }),
    });

    const reranked = await api.rerank("neural reranker", ["Unrelated note", "Neural reranking pipeline"]);
    expect(reranked.model).toBe("MatterWaveAI/grt-30m-reranker");
    expect(reranked.results[0]?.index).toBe(1);
    expect(calls[0]).toMatchObject({ method: "POST", url: "/v1/rerank" });
    expect(JSON.parse(String(calls[0]?.body))).toEqual({
      query: "neural reranker",
      documents: ["Unrelated note", "Neural reranking pipeline"],
      model: "MatterWaveAI/grt-30m-reranker",
    });

    const speech = await api.synthesizeSpeech("Hello MatterWave", "MatterWaveAI/grt-30m-tts", "aurora");
    expect(speech.model).toBe("MatterWaveAI/grt-30m-tts");
    expect(speech.voice).toBe("aurora");
    expect(calls[1]).toMatchObject({ method: "POST", url: "/v1/audio/speech" });
    expect(JSON.parse(String(calls[1]?.body))).toEqual({
      input: "Hello MatterWave",
      text: "Hello MatterWave",
      model: "MatterWaveAI/grt-30m-tts",
      voice: "aurora",
    });

    const suite = await api.getGrtSuite();
    expect(suite.total).toBe(9);
    expect(suite.models).toHaveLength(9);
    expect(calls[2]).toMatchObject({ method: "GET", url: "/api/v1/models/grt-suite" });
  });
});
