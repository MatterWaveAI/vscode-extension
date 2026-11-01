import { readFileSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import { homedir } from "node:os";
import { Readable } from "node:stream";
import * as tls from "node:tls";
import type { FetchLike } from "./client";

/**
 * The `fetch` every request goes through, and the trust it carries.
 *
 * Without `matterwave.caFile` it is the extension host's own `fetch`,
 * which VS Code extends with the editor's network settings: `http.proxy`
 * (and the system proxy, with its authentication), `http.proxyStrictSSL`,
 * and the operating system's certificate store. Nothing is bundled for it.
 *
 * A deployment behind a private CA the operating system does not trust (a
 * lab's Caddy root, a corporate intermediate) needs `matterwave.caFile`,
 * the PEM of that authority. Node's `fetch` takes no per-call trust store,
 * so those requests go through Node's `https.request` with the PEM added
 * to the bundled roots; VS Code patches that module the same way --
 * the proxy, and the operating system's certificates added to every TLS
 * context -- so the CA file is trusted on top of everything else, not
 * instead of it.
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
    // Node's fetch says "fetch failed" and keeps the reason underneath.
    const cause = error.cause;
    if (error.message === "fetch failed" && cause instanceof Error && cause.message) return cause.message;
    return error.message;
  }
  return String(error);
}

/** The seams a test replaces: the file system, the bundled roots and the two ways of sending. */
export interface TransportDeps {
  readFile: (path: string) => string;
  rootCertificates: readonly string[];
  /** The extension host's fetch, for every request while no CA file is set. */
  fetch: FetchLike;
  /** A fetch that trusts `ca` (bundled roots and the file's PEM), for requests while one is. */
  fetchTrusting: (ca: string[]) => FetchLike;
}

const defaultDeps: TransportDeps = {
  readFile: (path) => readFileSync(path, "utf8"),
  rootCertificates: tls.rootCertificates,
  fetch: (input, init) => fetch(input, init),
  fetchTrusting: (ca) => requestFetch({ ca }),
};

export function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") || path.startsWith("~\\") ? homedir() + path.slice(1) : path;
}

/**
 * A `fetch` that reads `caFile` on every call, so a change to the setting
 * applies to the next request, and that turns a refused certificate into
 * `UNTRUSTED_CERTIFICATE_MESSAGE`. The PEM is read and the trusting fetch
 * built once per distinct path; an unreadable file fails the request with
 * the path and the reason, since a request sent without the CA the person
 * configured would fail less clearly.
 */
export function createFetch(caFile: () => string, overrides: Partial<TransportDeps> = {}): FetchLike {
  const deps = { ...defaultDeps, ...overrides };
  let cached: { path: string; fetch: FetchLike } | null = null;
  const trustingFetch = (path: string): FetchLike => {
    if (cached?.path === path) return cached.fetch;
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
    cached = { path, fetch: deps.fetchTrusting([...deps.rootCertificates, pem]) };
    return cached.fetch;
  };
  return async (input, init = {}) => {
    const path = caFile().trim();
    const send = path ? trustingFetch(path) : deps.fetch;
    try {
      return await send(input, init);
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new TransportError(describeTransportError(error), error);
    }
  };
}

/** Redirects a request follows before it gives up, as `fetch` does. */
const MAX_REDIRECTS = 5;

/** What `requestFetch` sends through: Node's `request` for each scheme, replaceable in tests. */
export interface RequestFns {
  http: typeof http.request;
  https: typeof https.request;
}

/**
 * The `fetch` contract over Node's `http.request` / `https.request`, with
 * `ca` as the TLS trust: the request body as `fetch` takes it (text, a
 * Blob, FormData), the answer as a streamed `Response`, an abort through
 * the signal, and redirects followed the way `fetch` follows them. Sent
 * through the modules the editor patches, so its proxy and certificate
 * settings apply.
 */
export function requestFetch(options: { ca: string[]; request?: RequestFns }): FetchLike {
  const request = options.request ?? { http: http.request, https: https.request };
  const send = async (input: string, init: RequestInit, hops: number): Promise<Response> => {
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    let body: Buffer | undefined;
    if (init.body !== undefined && init.body !== null) {
      // The Request does what fetch would: the bytes, and a multipart
      // boundary or text type in Content-Type when the body sets one.
      const encoded = new Request(input, { method, headers, body: init.body });
      body = Buffer.from(await encoded.arrayBuffer());
      const type = encoded.headers.get("content-type");
      if (type && !headers.has("content-type")) headers.set("content-type", type);
    }
    if (body) headers.set("content-length", String(body.byteLength));
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const open = url.protocol === "http:" ? request.http : request.https;
      const outgoing = open(
        url,
        {
          method,
          headers: Object.fromEntries(headers),
          ...(url.protocol === "https:" ? { ca: options.ca } : {}),
          ...(init.signal ? { signal: init.signal } : {}),
        },
        resolve,
      );
      outgoing.on("error", reject);
      outgoing.end(body);
    });
    const status = response.statusCode ?? 0;
    const location = response.headers.location;
    if (location && [301, 302, 303, 307, 308].includes(status) && init.redirect !== "manual") {
      response.resume();
      if (hops >= MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects from ${input}`);
      // 303, and a 301/302 after a POST, turn into a GET without the body, as fetch does.
      const asGet = status === 303 || ((status === 301 || status === 302) && method === "POST");
      const next: RequestInit = asGet ? { ...init, method: "GET", body: undefined } : init;
      return send(new URL(location, url).toString(), next, hops + 1);
    }
    const answer = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
      if (Array.isArray(value)) for (const one of value) answer.append(name, one);
      else if (value !== undefined) answer.set(name, value);
    }
    const empty = method === "HEAD" || status === 204 || status === 304;
    if (empty) response.resume();
    return new Response(empty ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>), {
      status,
      statusText: response.statusMessage ?? "",
      headers: answer,
    });
  };
  return (input, init = {}) => send(input, init, 0);
}
