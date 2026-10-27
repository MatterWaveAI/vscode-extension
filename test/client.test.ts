import { setSleep } from "../src/lib/matterwaveClient";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MatterWaveClient } from "../src/api/client";
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
    await api.setFeedback("m_1", -1);
    expect(JSON.parse(String(calls[2]?.body))).toEqual({ rating: -1 });
    await api.deleteFeedback("m_1");
    expect(calls[3]?.method).toBe("DELETE");
  });

  it("lists the archive with the filter the sidebar folds away", async () => {
    const { api, calls } = client({ "GET /api/conversations": () => json({ data: [], filter: "archived" }) });
    await api.listArchivedConversations();
    expect(calls[0]?.url).toBe("/api/conversations?filter=archived");
  });
});
