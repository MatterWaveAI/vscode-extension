import { describe, expect, it } from "vitest";
import type { DeviceAuthorization, DevicePoll } from "../src/api/types";
import { DeviceLoginError, pollForDeviceToken, SLOW_DOWN_STEP_S } from "../src/auth/deviceLogin";

const authorization: DeviceAuthorization = {
  device_code: "dev-123",
  user_code: "WXYZ-1234",
  verification_uri: "https://mw.test/device",
  verification_uri_complete: "https://mw.test/device?user_code=WXYZ-1234",
  expires_in: 600,
  interval: 5,
};

function scripted(answers: DevicePoll[]) {
  let clock = 0;
  const sleeps: number[] = [];
  const polled: string[] = [];
  return {
    sleeps,
    polled,
    options: {
      authorization,
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
      poll: async (code: string) => {
        polled.push(code);
        const next = answers.shift();
        if (!next) throw new Error("polled past the script");
        return next;
      },
    },
  };
}

describe("pollForDeviceToken", () => {
  it("waits out pending, slows down when told, and returns the token", async () => {
    const run = scripted([
      { ok: false, error: "authorization_pending" },
      { ok: false, error: "slow_down" },
      { ok: false, error: "authorization_pending" },
      { ok: true, token: { token_type: "Bearer", access_token: "mw_abcdefgh_minted", scopes: ["chat"] } },
    ]);
    const token = await pollForDeviceToken(run.options);
    expect(token.access_token).toBe("mw_abcdefgh_minted");
    expect(run.polled).toEqual(["dev-123", "dev-123", "dev-123", "dev-123"]);
    // interval, interval, then interval + 5 for every poll after slow_down.
    const slowed = (5 + SLOW_DOWN_STEP_S) * 1000;
    expect(run.sleeps).toEqual([5000, 5000, slowed, slowed]);
  });

  it("stops on access_denied", async () => {
    const run = scripted([{ ok: false, error: "access_denied" }]);
    await expect(pollForDeviceToken(run.options)).rejects.toMatchObject({ reason: "access_denied" });
  });

  it("stops on expired_token from the server", async () => {
    const run = scripted([{ ok: false, error: "expired_token" }]);
    await expect(pollForDeviceToken(run.options)).rejects.toBeInstanceOf(DeviceLoginError);
  });

  it("stops by itself when expires_in runs out", async () => {
    const pending: DevicePoll[] = Array.from({ length: 200 }, () => ({ ok: false, error: "authorization_pending" }));
    const run = scripted(pending);
    await expect(pollForDeviceToken(run.options)).rejects.toMatchObject({ reason: "expired_token" });
    // 600 s at a 5 s interval: polls at 5, 10, ... 595; the sleep to 600 hits the deadline.
    expect(run.polled.length).toBe(119);
  });

  it("stops when cancelled", async () => {
    const run = scripted([{ ok: false, error: "authorization_pending" }]);
    await expect(pollForDeviceToken({ ...run.options, isCancelled: () => true })).rejects.toMatchObject({
      reason: "cancelled",
    });
    expect(run.polled).toEqual([]);
  });
});
