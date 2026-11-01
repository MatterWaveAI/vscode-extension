import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createFetch,
  describeTransportError,
  expandHome,
  requestFetch,
  tlsCodeOf,
  TransportError,
  UNTRUSTED_CERTIFICATE_MESSAGE,
} from "../src/api/transport";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";

/** What Node's fetch throws for a refused chain: "fetch failed" over the TLS error. */
function tlsFailure(code: string): Error {
  const inner = Object.assign(new Error("self-signed certificate in certificate chain"), { code });
  return new TypeError("fetch failed", { cause: inner });
}

function harness(options: { caFile?: string; files?: Record<string, string>; fail?: unknown } = {}) {
  /** Which way each request went: the host's fetch, or the one trusting a CA list. */
  const calls: { input: string; via: "host" | string[] }[] = [];
  const trusting: string[][] = [];
  const reads: string[] = [];
  const answer = async () => {
    if (options.fail) throw options.fail;
    return new Response("{}", { status: 200 });
  };
  const fetchImpl = createFetch(() => options.caFile ?? "", {
    readFile: (path) => {
      reads.push(path);
      const pem = options.files?.[path];
      if (pem === undefined) throw new Error("ENOENT: no such file");
      return pem;
    },
    rootCertificates: ["ROOT-A", "ROOT-B"],
    fetch: async (input) => {
      calls.push({ input, via: "host" });
      return answer();
    },
    fetchTrusting: (ca) => {
      trusting.push(ca);
      return async (input) => {
        calls.push({ input, via: ca });
        return answer();
      };
    },
  });
  return { fetchImpl, calls, trusting, reads };
}

describe("matterwave.caFile", () => {
  it("sends through the host's own fetch -- the editor's proxy and certificate store -- when no CA file is set", async () => {
    const { fetchImpl, calls, trusting } = harness();
    await fetchImpl("https://mw.test/api/me", { method: "GET" });
    expect(calls).toEqual([{ input: "https://mw.test/api/me", via: "host" }]);
    expect(trusting).toEqual([]);
  });

  it("adds the file's PEM to the bundled roots and sends through the fetch that trusts them", async () => {
    const { fetchImpl, calls, trusting, reads } = harness({ caFile: "/etc/mw/root.crt", files: { "/etc/mw/root.crt": PEM } });
    await fetchImpl("https://mw.test/api/me", { method: "GET" });
    await fetchImpl("https://mw.test/api/models", { method: "GET" });
    expect(trusting).toEqual([["ROOT-A", "ROOT-B", PEM]]);
    expect(calls.map((c) => c.via)).toEqual([
      ["ROOT-A", "ROOT-B", PEM],
      ["ROOT-A", "ROOT-B", PEM],
    ]);
    // Read once per path, not per request.
    expect(reads).toEqual(["/etc/mw/root.crt"]);
  });

  it("re-reads when the setting changes, and goes back to the host's fetch when it is cleared", async () => {
    let caFile = "/a.crt";
    const files = { "/a.crt": PEM, "/b.crt": PEM.replace("MIIB", "MIIC") };
    const trusting: string[][] = [];
    const via: string[] = [];
    const fetchImpl = createFetch(() => caFile, {
      readFile: (path) => files[path as keyof typeof files],
      rootCertificates: [],
      fetch: async () => (via.push("host"), new Response("{}")),
      fetchTrusting: (ca) => (trusting.push(ca), async () => (via.push("trusting"), new Response("{}"))),
    });
    await fetchImpl("https://mw.test/", {});
    caFile = "/b.crt";
    await fetchImpl("https://mw.test/", {});
    caFile = "";
    await fetchImpl("https://mw.test/", {});
    expect(trusting).toEqual([[PEM], [files["/b.crt"]]]);
    expect(via).toEqual(["trusting", "trusting", "host"]);
  });

  it("fails the request, naming the setting, when the file cannot be read", async () => {
    const { fetchImpl, calls } = harness({ caFile: "/missing.crt" });
    const error = await fetchImpl("https://mw.test/api/me", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as Error).message).toMatch(/^matterwave\.caFile \(\/missing\.crt\) could not be read: ENOENT/);
    expect(calls).toEqual([]);
  });

  it("refuses a file that is not a PEM certificate", async () => {
    const { fetchImpl } = harness({ caFile: "/key.pem", files: { "/key.pem": `-----BEGIN ${"PRIVATE"} KEY-----\n` } });
    await expect(fetchImpl("https://mw.test/api/me", {})).rejects.toThrow("matterwave.caFile (/key.pem) is not a PEM certificate file.");
  });

  it("expands a leading ~ to the home directory", () => {
    expect(expandHome("~/mw/root.crt")).toMatch(/[\\/]mw\/root\.crt$/);
    expect(expandHome("~/mw/root.crt")).not.toContain("~");
    expect(expandHome("/etc/root.crt")).toBe("/etc/root.crt");
    expect(expandHome("~user/root.crt")).toBe("~user/root.crt");
  });
});

describe("a failed request's message", () => {
  it.each([
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "CERT_HAS_EXPIRED",
    "ERR_TLS_CERT_ALTNAME_INVALID",
  ])("maps the TLS refusal %s to the caFile hint", (code) => {
    expect(tlsCodeOf(tlsFailure(code))).toBe(code);
    expect(describeTransportError(tlsFailure(code))).toBe(`${UNTRUSTED_CERTIFICATE_MESSAGE} (${code})`);
  });

  it("finds the code however deep the runtime nested it", () => {
    const deep = new Error("outer", { cause: new Error("middle", { cause: Object.assign(new Error("inner"), { code: "CERT_UNTRUSTED" }) }) });
    expect(tlsCodeOf(deep)).toBe("CERT_UNTRUSTED");
  });

  it("keeps the runtime's own words for anything else", () => {
    const refused = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" }) });
    expect(tlsCodeOf(refused)).toBeNull();
    expect(describeTransportError(refused)).toBe("connect ECONNREFUSED 127.0.0.1:443");
    expect(describeTransportError(new Error("boom"))).toBe("boom");
    expect(describeTransportError("odd")).toBe("odd");
  });

  it("is what the fetch throws, with the cause kept", async () => {
    const failure = tlsFailure("SELF_SIGNED_CERT_IN_CHAIN");
    const { fetchImpl } = harness({ fail: failure });
    const error = await fetchImpl("https://mw.test/api/me", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).message).toContain(UNTRUSTED_CERTIFICATE_MESSAGE);
    expect((error as TransportError).cause).toBe(failure);
  });

  it("lets an abort through untouched", async () => {
    const controller = new AbortController();
    controller.abort();
    const abort = new DOMException("The operation was aborted.", "AbortError");
    const { fetchImpl } = harness({ fail: abort });
    await expect(fetchImpl("https://mw.test/api/me", { signal: controller.signal })).rejects.toBe(abort);
  });
});

describe("requestFetch: fetch over Node's request, the way a CA file sends", () => {
  let server: Server;
  let base = "";
  const seen: { method: string; url: string; type: string; body: string }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", type: req.headers["content-type"] ?? "", body: Buffer.concat(chunks).toString() });
        if (req.url === "/json") {
          res.writeHead(201, { "content-type": "application/json", "x-request-id": "req-1" });
          res.end(JSON.stringify({ ok: true }));
        } else if (req.url === "/empty") {
          res.writeHead(204).end();
        } else if (req.url === "/moved") {
          res.writeHead(303, { location: "/json" }).end();
        } else if (req.url === "/stream") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write("data: one\n\n");
          setTimeout(() => res.end("data: two\n\n"), 20);
        } else if (req.url === "/forever") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write("data: first\n\n");
        } else {
          res.writeHead(404).end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const send = requestFetch({ ca: [] });

  it("sends a JSON body and reads the status, headers and body back", async () => {
    const response = await send(`${base}/json`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"a":1}' });
    expect(response.status).toBe(201);
    expect(response.headers.get("x-request-id")).toBe("req-1");
    expect(await response.json()).toEqual({ ok: true });
    expect(seen.at(-1)).toMatchObject({ method: "POST", type: "application/json", body: '{"a":1}' });
  });

  it("encodes FormData as multipart with its boundary, as fetch does", async () => {
    const form = new FormData();
    form.append("file", new Blob(["hello"], { type: "text/plain" }), "a.txt");
    await send(`${base}/json`, { method: "POST", body: form });
    const last = seen.at(-1);
    expect(last?.type).toMatch(/^multipart\/form-data; boundary=/);
    expect(last?.body).toContain('filename="a.txt"');
    expect(last?.body).toContain("hello");
  });

  it("has no body for a 204", async () => {
    const response = await send(`${base}/empty`, { method: "DELETE" });
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it("follows a 303 as a GET without the body", async () => {
    const response = await send(`${base}/moved`, { method: "POST", body: "x" });
    expect(response.status).toBe(201);
    expect(seen.at(-1)).toMatchObject({ method: "GET", url: "/json", body: "" });
  });

  it("streams the answer as it arrives", async () => {
    const response = await send(`${base}/stream`, {});
    expect(await response.text()).toBe("data: one\n\ndata: two\n\n");
  });

  it("stops a stream when the signal aborts", async () => {
    const controller = new AbortController();
    const response = await send(`${base}/forever`, { signal: controller.signal });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
    controller.abort();
    await expect(reader.read()).rejects.toThrow();
  });

  it("hands the CA list to an https request, and nothing to a plain one", async () => {
    const options: Record<string, unknown>[] = [];
    const spy = ((_url: URL, opts: Record<string, unknown>, callback: (res: unknown) => void) => {
      options.push(opts);
      return httpRequest(new URL(`${base}/json`), { method: opts.method as string }, callback);
    }) as unknown as typeof httpRequest;
    const trusting = requestFetch({ ca: ["ROOT", PEM], request: { http: spy, https: spy } });
    await trusting("https://mw.test/json", {});
    await trusting("http://mw.test/json", {});
    expect(options[0]?.ca).toEqual(["ROOT", PEM]);
    expect(options[1]?.ca).toBeUndefined();
  });
});
