import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as tls from "node:tls";
import { Agent, fetch as undiciFetch } from "undici";
import type { FetchLike } from "./client";

/**
 * The `fetch` every request goes through, and the trust it carries.
 *
 * The extension host's `fetch` is undici's, with no per-call trust store:
 * a deployment behind a private CA (a lab's Caddy root, a corporate
 * intermediate) is refused with a TLS error that names an OpenSSL code
 * and nothing a person can act on. `matterwave.caFile` names the PEM of
 * that authority; it is read once per path, added beside the system's
 * authorities, and carried by an undici `Agent` whose `connect.ca` is the
 * TLS option (`https.Agent`'s `ca`, by another route), so the SDK's
 * requests and this extension's own are both covered.
 *
 * A TLS refusal, with or without a CA file, comes out as one sentence
 * that names the setting; every other failure keeps its own message.
 */

export const UNTRUSTED_CERTIFICATE_MESSAGE =
  "The server's certificate is not trusted; set matterwave.caFile to the PEM file of the certificate authority that signed it.";

/** OpenSSL's and Node's codes for "the chain does not verify", none of which a retry fixes. */
const TLS_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_UNTRUSTED",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_SIGNATURE_FAILURE",
  "CERT_CHAIN_TOO_LONG",
  "CERT_REVOKED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "HOSTNAME_MISMATCH",
]);

/** Whether a failed request's message is the TLS refusal, for a surface that renders its own copy. */
export function isUntrustedCertificate(message: string): boolean {
  return message.includes(UNTRUSTED_CERTIFICATE_MESSAGE);
}

/** A request that never got an answer, said in words a person can act on; `cause` is what the runtime threw. */
export class TransportError extends Error {
  constructor(
    message: string,
    override readonly cause: unknown,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

/** The TLS verification code in `error` or its causes, or null for anything else. */
export function tlsCodeOf(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === "object" && depth < 8; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && TLS_CODES.has(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** The sentence for a failed request: the CA hint for a TLS refusal, the runtime's own words otherwise. */
export function describeTransportError(error: unknown): string {
  if (error instanceof TransportError) return error.message;
  const code = tlsCodeOf(error);
  if (code) return `${UNTRUSTED_CERTIFICATE_MESSAGE} (${code})`;
  if (error instanceof Error) {
    // undici says "fetch failed" and keeps the reason underneath.
    const cause = error.cause;
    if (error.message === "fetch failed" && cause instanceof Error && cause.message) return cause.message;
    return error.message;
  }
  return String(error);
}

/** The seams a test replaces: the file system, the trust store and the two fetches. */
export interface TransportDeps {
  readFile: (path: string) => string;
  rootCertificates: readonly string[];
  /** The request, with `dispatcher` on `init` when a CA file is in force. */
  fetch: (input: string, init: RequestInit & { dispatcher?: unknown }) => Promise<Response>;
  makeDispatcher: (ca: string[]) => unknown;
}

const defaultDeps: TransportDeps = {
  readFile: (path) => readFileSync(path, "utf8"),
  rootCertificates: tls.rootCertificates,
  fetch: (input, init) =>
    init.dispatcher
      ? (undiciFetch(input, init as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>)
      : fetch(input, init),
  makeDispatcher: (ca) => new Agent({ connect: { ca } }),
};

export function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") || path.startsWith("~\\") ? homedir() + path.slice(1) : path;
}

/**
 * A `fetch` that reads `caFile` on every call, so a change to the setting
 * applies to the next request, and that turns a refused certificate into
 * `UNTRUSTED_CERTIFICATE_MESSAGE`. The PEM is read and the dispatcher
 * built once per distinct path; an unreadable file fails the request with
 * the path and the reason, since a request sent without the CA the person
 * configured would fail less clearly.
 */
export function createFetch(caFile: () => string, overrides: Partial<TransportDeps> = {}): FetchLike {
  const deps = { ...defaultDeps, ...overrides };
  let cached: { path: string; dispatcher: unknown } | null = null;
  const dispatcherFor = (path: string): unknown => {
    if (cached?.path === path) return cached.dispatcher;
    let pem: string;
    try {
      pem = deps.readFile(expandHome(path));
    } catch (error) {
      throw new TransportError(
        `matterwave.caFile (${path}) could not be read: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
    if (!pem.includes("-----BEGIN CERTIFICATE-----")) {
      throw new TransportError(`matterwave.caFile (${path}) is not a PEM certificate file.`, null);
    }
    cached = { path, dispatcher: deps.makeDispatcher([...deps.rootCertificates, pem]) };
    return cached.dispatcher;
  };
  return async (input, init = {}) => {
    const path = caFile().trim();
    const request = path ? { ...init, dispatcher: dispatcherFor(path) } : init;
    try {
      return await deps.fetch(input, request);
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new TransportError(describeTransportError(error), error);
    }
  };
}
