import { describe, expect, it } from "vitest";
import { DEFAULT_BASE_URL, normalizeServerUrl, serverUrlProblem, shouldPromptForServer } from "../src/settings";

describe("the first-activation server prompt", () => {
  it("asks when the default server is in force and it has not asked before", () => {
    expect(shouldPromptForServer({ configured: undefined, prompted: false })).toBe(true);
    expect(shouldPromptForServer({ configured: "", prompted: false })).toBe(true);
    expect(shouldPromptForServer({ configured: DEFAULT_BASE_URL, prompted: false })).toBe(true);
    expect(shouldPromptForServer({ configured: ` ${DEFAULT_BASE_URL} `, prompted: false })).toBe(true);
  });

  it("does not ask once a server is set, nor a second time", () => {
    expect(shouldPromptForServer({ configured: "https://matterwave.internal.example", prompted: false })).toBe(false);
    expect(shouldPromptForServer({ configured: undefined, prompted: true })).toBe(false);
    expect(shouldPromptForServer({ configured: DEFAULT_BASE_URL, prompted: true })).toBe(false);
  });
});

describe("a typed server URL", () => {
  it("is accepted as an origin, with any path kept and the trailing slash dropped", () => {
    expect(normalizeServerUrl("https://matterwave.internal.example")).toBe("https://matterwave.internal.example");
    expect(normalizeServerUrl(" https://matterwave.internal.example/ ")).toBe("https://matterwave.internal.example");
    expect(normalizeServerUrl("http://127.0.0.1:8000/")).toBe("http://127.0.0.1:8000");
    expect(normalizeServerUrl("https://corp.example/matterwave/")).toBe("https://corp.example/matterwave");
    expect(serverUrlProblem("https://matterwave.internal.example")).toBeNull();
  });

  it("is refused with a reason when it is not one", () => {
    expect(serverUrlProblem("")).toMatch(/Enter the URL/);
    expect(serverUrlProblem("matterwave.internal.example")).toMatch(/full URL/);
    expect(serverUrlProblem("ftp://matterwave.internal.example")).toMatch(/https:\/\/ or http:\/\//);
    expect(serverUrlProblem("https://matterwave.internal.example/?x=1")).toMatch(/query/);
    expect(serverUrlProblem("https://matterwave.internal.example/#top")).toMatch(/fragment/);
    expect(normalizeServerUrl("matterwave.internal.example")).toBeNull();
  });
});
