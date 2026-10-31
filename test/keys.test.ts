import { describe, expect, it } from "vitest";
import type { ApiKeyListing } from "../src/api/types";
import { keyDetail } from "../src/keys";

function key(over: Partial<ApiKeyListing> = {}): ApiKeyListing {
  return {
    id: "k_1",
    prefix: "mw_display1",
    name: "Deploy",
    scopes: ["chat"],
    created_at: "2026-01-15T10:00:00+00:00",
    previous_prefix: null,
    previous_valid_until: null,
    rotated_at: null,
    last_used_at: null,
    expires_at: null,
    revoked_at: null,
    ...over,
  };
}

describe("keyDetail", () => {
  it("leads with what the key may do: its scopes, comma-joined", () => {
    const detail = keyDetail(key({ scopes: ["chat", "keys:manage"] }));
    expect(detail.startsWith("scopes chat, keys:manage · ")).toBe(true);
  });

  it("keeps a key with no scopes to the life lines alone", () => {
    const detail = keyDetail(key({ scopes: [] }));
    expect(detail).not.toContain("scopes");
    expect(detail).toContain("never used");
    // created, never used -- the dates render in the viewer's locale, so only the shape is pinned here.
    expect(detail.split(" · ")).toHaveLength(2);
  });

  it("tells a used key from an unused one, and names its expiry", () => {
    const detail = keyDetail(key({ last_used_at: "2026-02-01T09:00:00+00:00", expires_at: "2027-01-01T00:00:00+00:00" }));
    expect(detail).toContain("last used");
    expect(detail).toContain("expires");
    expect(detail).not.toContain("never used");
  });
});
