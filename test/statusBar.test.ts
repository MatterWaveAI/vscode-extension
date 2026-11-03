import { describe, expect, it } from "vitest";
import { formatAgentEngineStatus, statusText } from "../src/statusBar";
import type { UsageView } from "../src/chat/protocol";

describe("statusText", () => {
  const base = { signedIn: true, offline: false, identity: "Ada", model: "GRT Small", meterPercent: 42, unreadNotifications: 0, usage: null };

  it("shows the model, the meter and who is signed in", () => {
    const view = statusText(base);
    expect(view.text).toBe("$(comment-discussion) GRT Small · 42%");
    expect(view.tooltip).toContain("Signed in as Ada");
  });

  it("says offline, and asks for sign-in when signed out", () => {
    expect(statusText({ ...base, offline: true }).text).toContain("offline");
    expect(statusText({ ...base, signedIn: false }).command).toBe("matterwave.signInWithDeviceCode");
  });

  it("badges unread notifications on the face and in the tooltip", () => {
    const view = statusText({ ...base, unreadNotifications: 3 });
    expect(view.text).toBe("$(comment-discussion) GRT Small · 42% · $(bell) 3");
    expect(view.tooltip).toContain("Notifications: 3 unread");
    // Quiet is the ordinary case: no bell, no line.
    expect(statusText(base).text).not.toContain("$(bell)");
  });

  it("spells the allowance in the tooltip, with its overage state", () => {
    const usage = (state: UsageView["state"]): UsageView => ({
      used: 1_200_000,
      included: 5_000_000,
      percent: 24,
      state,
      resetsAt: "2026-11-01T00:00:00+00:00",
      planName: "Team",
      memberCap: null,
    });
    const view = statusText({ ...base, usage: usage("ok") });
    expect(view.tooltip).toContain("Allowance: 1,200,000 of 5,000,000 tokens (24%)");
    expect(view.tooltip).not.toMatch(/overage|exhausted|running low/);
    expect(statusText({ ...base, usage: usage("overage") }).tooltip).toContain("— in overage");
    expect(statusText({ ...base, usage: usage("warn") }).tooltip).toContain("— running low");
    expect(statusText({ ...base, usage: usage("exhausted") }).tooltip).toContain("— exhausted");
  });

  it("adds the person's own cap when one applies", () => {
    const usage: UsageView = {
      used: 10,
      included: 100,
      percent: 10,
      state: "ok",
      resetsAt: "2026-11-01T00:00:00+00:00",
      planName: "Team",
      memberCap: { spentUsd: 3.2, capUsd: 10, exhausted: false },
    };
    expect(statusText({ ...base, usage }).tooltip).toContain("Your cap: $3.20 of $10.00");
    expect(statusText({ ...base, usage: { ...usage, memberCap: { spentUsd: 10, capUsd: 10, exhausted: true } } }).tooltip).toContain(
      "Your cap: $10.00 of $10.00 — reached",
    );
  });

  it("formats agent engine status and includes it in the status bar tooltip", () => {
    expect(formatAgentEngineStatus("auto", true)).toBe("Pi 1.0 (auto)");
    expect(formatAgentEngineStatus("auto", false)).toBe("Built-in (auto fallback)");
    expect(formatAgentEngineStatus("pi", true)).toBe("Pi 1.0");
    expect(formatAgentEngineStatus("pi", false)).toBe("Pi 1.0 (unavailable)");
    expect(formatAgentEngineStatus("builtin", true)).toBe("Built-in");
    expect(formatAgentEngineStatus("builtin", false)).toBe("Built-in");

    expect(statusText({ ...base, agentEngine: "auto", piAvailable: true }).tooltip).toContain(
      "Agent engine: Pi 1.0 (auto)",
    );
    expect(statusText({ ...base, agentEngine: "pi", piAvailable: false }).tooltip).toContain(
      "Agent engine: Pi 1.0 (unavailable)",
    );
  });
});
