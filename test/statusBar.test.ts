import { describe, expect, it } from "vitest";
import { statusText } from "../src/statusBar";

describe("statusText", () => {
  const base = { signedIn: true, offline: false, identity: "Ada", model: "GRT Small", meterPercent: 42 };

  it("shows the model, the meter and who is signed in", () => {
    const view = statusText(base);
    expect(view.text).toBe("$(comment-discussion) GRT Small · 42%");
    expect(view.tooltip).toContain("Signed in as Ada");
  });

  it("says offline, and asks for sign-in when signed out", () => {
    expect(statusText({ ...base, offline: true }).text).toContain("offline");
    expect(statusText({ ...base, signedIn: false }).command).toBe("matterwave.signInWithDeviceCode");
  });
});
