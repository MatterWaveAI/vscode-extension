/**
 * A non-2xx answer from the API, or a request that never got one.
 *
 * `requestId` is the `X-Request-Id` the API stamped on the response: the one
 * string that lets an operator find this request in the logs, so every error
 * surface keeps it (the "Copy request id" command reads it from here).
 * `status` is 0 when the network failed before any answer arrived.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly requestId: string | null,
    readonly retryAfterS: number | null = null,
    /** The body's machine-readable `error` or `code`, where it has one. */
    readonly code: string | null = null,
  ) {
    super(detail);
    this.name = "ApiError";
  }
}

/** FastAPI's `detail` is a string, or a list of validation errors. */
export function detailOf(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "detail" in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      const messages = detail
        .map((item) => (item && typeof item === "object" && "msg" in item ? String(item.msg) : ""))
        .filter(Boolean);
      if (messages.length > 0) return messages.join("; ");
    }
  }
  return fallback;
}

/**
 * `Retry-After` in seconds. The header may be delta-seconds or an HTTP date;
 * anything unparseable reads as absent rather than as "retry now".
 */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null || value.trim() === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.max(0, (at - now) / 1000);
}
