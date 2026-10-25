import { describe, expect, it } from "vitest";
import type * as vscode from "vscode";
import { MatterWaveClient } from "../src/api/client";
import { TokenStore } from "../src/auth/session";
import { signOut } from "../src/auth/signOut";
import { fakeFetch, json } from "./fakeApi";
import { MemorySecrets } from "./vscode-mock";

const MINTED = "mw_abcdefgh_minted-by-device-login";
const KEYS = {
  data: [
    { id: "key_other", prefix: "mw_zzzzzzzz", previous_prefix: null, revoked_at: null },
    { id: "key_dev", prefix: "mw_abcdefgh", previous_prefix: null, revoked_at: null },
  ],
};

function setup(routes: Parameters<typeof fakeFetch>[0]) {
  const secrets = new MemorySecrets();
  const tokens = new TokenStore(secrets as unknown as vscode.SecretStorage, () => "https://mw.test");
  const fake = fakeFetch(routes);
  const client = new MatterWaveClient({
    baseUrl: "https://mw.test",
    getToken: () => tokens.get(),
    fetch: fake.fetch,
    sleep: async () => undefined,
  });
  return { secrets, tokens, client, calls: fake.calls };
}

describe("TokenStore", () => {
  it("remembers which sign-in filled the slot, and reads an older bare key as pasted", async () => {
    const { secrets, tokens } = setup({});
    await tokens.set(MINTED, true);
    expect(await tokens.session()).toEqual({ token: MINTED, minted: true });
    expect(await tokens.get()).toBe(MINTED);
    secrets.values.set("matterwave.token:https://mw.test", "mw_abcdefgh_bare");
    expect(await tokens.session()).toEqual({ token: "mw_abcdefgh_bare", minted: false });
  });
});

describe("sign-out", () => {
  it("revokes a device-minted key on the server by its prefix, then clears the slot", async () => {
    const revoked: string[] = [];
    const { tokens, client, calls } = setup({
      "GET /api/keys": () => json(KEYS),
      "DELETE /api/keys/key_dev": (call) => {
        revoked.push(call.headers.Authorization ?? "");
        return new Response(null, { status: 204 });
      },
    });
    await tokens.set(MINTED, true);
    expect(await signOut(client, tokens)).toBe("revoked");
    // The revoke went out under the key itself, before it was forgotten.
    expect(revoked).toEqual([`Bearer ${MINTED}`]);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET /api/keys", "DELETE /api/keys/key_dev"]);
    expect(await tokens.get()).toBeNull();
  });

  it("leaves a pasted key alone", async () => {
    const { tokens, client, calls } = setup({});
    await tokens.set("mw_abcdefgh_pasted");
    expect(await signOut(client, tokens)).toBe("kept");
    expect(calls).toEqual([]);
    expect(await tokens.get()).toBeNull();
  });

  it("forgets a key stored before the slot said who minted it, without touching the server", async () => {
    const { secrets, tokens, client, calls } = setup({ "GET /api/keys": () => json(KEYS) });
    secrets.values.set("matterwave.token:https://mw.test", MINTED);
    expect(await signOut(client, tokens)).toBe("kept");
    expect(calls).toEqual([]);
    expect(await tokens.get()).toBeNull();
  });

  it("finds a key Settings rotated meanwhile by its retired prefix, and skips one already revoked", async () => {
    const rotated = { id: "key_dev", prefix: "mw_newnewne", previous_prefix: "mw_abcdefgh", revoked_at: null };
    const { tokens, client, calls } = setup({
      "GET /api/keys": () => json({ data: [{ ...rotated, id: "key_old", revoked_at: "2026-10-18T10:00:00+00:00" }, rotated] }),
      "DELETE /api/keys/key_dev": () => new Response(null, { status: 204 }),
    });
    await tokens.set(MINTED, true);
    expect(await signOut(client, tokens)).toBe("revoked");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET /api/keys", "DELETE /api/keys/key_dev"]);
  });

  it("still clears the slot when the revoke fails", async () => {
    const { tokens, client } = setup({ "GET /api/keys": () => json({ detail: "down" }, 503) });
    await tokens.set(MINTED, true);
    expect(await signOut(client, tokens)).toBe("revoke_failed");
    expect(await tokens.get()).toBeNull();
  });

  it("treats a key the listing no longer has as already revoked", async () => {
    const { tokens, client, calls } = setup({ "GET /api/keys": () => json({ data: [] }) });
    await tokens.set(MINTED, true);
    expect(await signOut(client, tokens)).toBe("revoked");
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });
});
