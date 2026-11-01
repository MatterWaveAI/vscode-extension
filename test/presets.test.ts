import { describe, expect, it } from "vitest";
import { MatterWave, MatterWaveConfigError, NotFoundError } from "../src/lib/matterwaveClient";
import { CONVERSATION, fakeFetch, json } from "./fakeApi";

// The vendored SDK's presets, as `routes_presets.py` answers them: the list a
// composer's picker offers, one preset by id, and a conversation started on one.

const PRESET = {
  id: "p_1",
  name: "Support",
  description: "Answers in the support channel",
  model: "grt-small",
  instructions: "Be brief.",
  tools: null,
  welcome_message: "How can I help?",
  created_by: "u1",
  created_at: "2026-11-01T09:00:00+00:00",
  updated_at: "2026-11-01T09:00:00+00:00",
  deleted_at: null,
};

const LISTING = {
  data: [PRESET],
  tools: [{ name: "web_search", description: "Search the web." }],
  limits: { max_presets: 50, name_max_len: 80, description_max_len: 500, instructions_max_len: 4000, welcome_max_len: 2000 },
  can_manage: false,
};

function sdk(routes: Parameters<typeof fakeFetch>[0]) {
  const fake = fakeFetch(routes);
  const client = new MatterWave({ apiKey: "mw_abcdefgh_secret", baseUrl: "https://mw.test", maxRetries: 0, fetch: fake.fetch });
  return { client, calls: fake.calls };
}

describe("the vendored client's presets", () => {
  it("lists the org's presets with the tools, the limits and can_manage", async () => {
    const { client, calls } = sdk({ "GET /api/org/presets": () => json(LISTING) });
    const listing = await client.presets.list();
    expect(calls[0]?.url).toBe("/api/org/presets");
    expect(calls[0]?.headers.Authorization).toBe("Bearer mw_abcdefgh_secret");
    expect(listing.data.map((p) => p.name)).toEqual(["Support"]);
    expect(listing.data[0]?.welcome_message).toBe("How can I help?");
    expect(listing.tools[0]?.name).toBe("web_search");
    expect(listing.limits.max_presets).toBe(50);
    expect(listing.can_manage).toBe(false);
    expect(listing.requestId).toBe("req-test");
  });

  it("gets one, a deleted one included, and a missing one is a NotFoundError", async () => {
    const { client, calls } = sdk({
      "GET /api/org/presets/p_1": () => json({ ...PRESET, deleted_at: "2026-11-01T10:00:00+00:00" }),
      "GET /api/org/presets/p_9": () => json({ detail: "No such preset." }, 404),
    });
    expect((await client.presets.get("p_1")).deleted_at).toBe("2026-11-01T10:00:00+00:00");
    await expect(client.presets.get("p_9")).rejects.toBeInstanceOf(NotFoundError);
    expect(calls.map((c) => c.url)).toEqual(["/api/org/presets/p_1", "/api/org/presets/p_9"]);
  });

  it("starts a conversation on a preset, and leaves a null preset out", async () => {
    const answer = { ...CONVERSATION, preset_id: "p_1", preset: { id: "p_1", name: "Support" } };
    const { client, calls } = sdk({ "POST /api/conversations": () => json(answer, 201) });
    const created = await client.conversations.create({ preset_id: "p_1" });
    await client.conversations.create({ title: "Plain", preset_id: null });
    expect(calls.map((c) => JSON.parse(String(c.body)))).toEqual([{ preset_id: "p_1" }, { title: "Plain" }]);
    expect(created.preset).toEqual({ id: "p_1", name: "Support" });
    expect(() => client.conversations.create({ preset_id: "" })).toThrow(MatterWaveConfigError);
  });
});
