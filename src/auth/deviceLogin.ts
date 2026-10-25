import type { DeviceAuthorization, DevicePoll, DeviceToken } from "../api/types";

/**
 * The RFC 8628 polling loop, with no editor in it so it can be tested with a
 * fake clock.
 *
 * The rules the server holds us to: wait `interval` seconds between polls;
 * on `slow_down` add five seconds to it for every later poll; stop on
 * `expired_token` or `access_denied`, and when `expires_in` runs out.
 */

export class DeviceLoginError extends Error {
  constructor(
    readonly reason: "expired_token" | "access_denied" | "cancelled" | "unexpected",
    message: string,
  ) {
    super(message);
    this.name = "DeviceLoginError";
  }
}

export interface PollOptions {
  authorization: DeviceAuthorization;
  poll: (deviceCode: string) => Promise<DevicePoll>;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
  isCancelled?: () => boolean;
}

/** RFC 8628 section 3.5: the increment on `slow_down`. */
export const SLOW_DOWN_STEP_S = 5;
/** When the server sends no interval, the RFC's default. */
const DEFAULT_INTERVAL_S = 5;

export async function pollForDeviceToken(options: PollOptions): Promise<DeviceToken> {
  const now = options.now ?? Date.now;
  const { authorization } = options;
  let intervalS = authorization.interval > 0 ? authorization.interval : DEFAULT_INTERVAL_S;
  const deadline = now() + authorization.expires_in * 1000;
  for (;;) {
    await options.sleep(intervalS * 1000);
    if (options.isCancelled?.()) throw new DeviceLoginError("cancelled", "Sign-in was cancelled.");
    if (now() >= deadline) {
      throw new DeviceLoginError("expired_token", "The sign-in code expired. Start the sign-in again.");
    }
    const answer = await options.poll(authorization.device_code);
    if (answer.ok) return answer.token;
    switch (answer.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        intervalS += SLOW_DOWN_STEP_S;
        continue;
      case "expired_token":
        throw new DeviceLoginError("expired_token", "The sign-in code expired. Start the sign-in again.");
      case "access_denied":
        throw new DeviceLoginError("access_denied", "Sign-in was declined in the browser.");
      default:
        throw new DeviceLoginError("unexpected", "The sign-in could not be completed. Try again.");
    }
  }
}
