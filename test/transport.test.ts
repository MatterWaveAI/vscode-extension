import { describe, expect, it } from "vitest";
import {
  createFetch,
  describeTransportError,
  expandHome,
  tlsCodeOf,
  TransportError,
  UNTRUSTED_CERTIFICATE_MESSAGE,
} from "../src/api/transport";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";

/** What undici throws for a refused chain: "fetch failed" over the TLS error. */
function tlsFailure(code: string): Error {
  const inner = Object.assign(new Error("self-signed certificate in certificate chain"), { code });
  return new TypeError("fetch failed", { cause: inner });
}

function harness(options: { caFile?: string; files?: Record<string, string>; fail?: unknown } = {}) {
  const calls: { input: string; dispatcher: unknown }[] = [];
  const dispatchers: string[][] = [];
  const reads: string[] = [];
  const fetchImpl = createFetch(() => options.caFile ?? "", {
    readFile: (path) => {
      reads.push(path);
      const pem = options.files?.[path];
      if (pem === undefined) throw new Error("ENOENT: no such file");
      return pem;
    },
    rootCertificates: ["ROOT-A", "ROOT-B"],
    makeDispatcher: (ca) => {
      dispatchers.push(ca);
      return { ca };
    },
    fetch: async (input, init) => {
      calls.push({ input, dispatcher: init.dispatcher });
      if (options.fail) throw options.fail;
      return new Response("{}", { status: 200 });
    },
  });
  return { fetchImpl, calls, dispatchers, reads };
}

describe("matterwave.caFile", () => {
  it("sends without a dispatcher when no CA file is set", async () => {
    const { fetchImpl, calls, dispatchers } = harness();
    await fetchImpl("https://mw.test/api/me", { method: "GET" });
    expect(calls[0]?.dispatcher).toBeUndefined();
    expect(dispatchers).toEqual([]);
  });

  it("adds the file's PEM beside the system authorities and sends through that dispatcher", async () => {
    const { fetchImpl, calls, dispatchers, reads } = harness({ caFile: "/etc/mw/root.crt", files: { "/etc/mw/root.crt": PEM } });
    await fetchImpl("https://mw.test/api/me", { method: "GET" });
    await fetchImpl("https://mw.test/api/models", { method: "GET" });
    expect(dispatchers).toEqual([["ROOT-A", "ROOT-B", PEM]]);
    expect(calls.map((c) => c.dispatcher)).toEqual([{ ca: ["ROOT-A", "ROOT-B", PEM] }, { ca: ["ROOT-A", "ROOT-B", PEM] }]);
    // Read once per path, not per request.
    expect(reads).toEqual(["/etc/mw/root.crt"]);
  });

  it("re-reads when the setting changes", async () => {
    let caFile = "/a.crt";
    const files = { "/a.crt": PEM, "/b.crt": PEM.replace("MIIB", "MIIC") };
    const dispatchers: string[][] = [];
    const fetchImpl = createFetch(() => caFile, {
      readFile: (path) => files[path as keyof typeof files],
      rootCertificates: [],
      makeDispatcher: (ca) => (dispatchers.push(ca), {}),
      fetch: async () => new Response("{}"),
    });
    await fetchImpl("https://mw.test/", {});
    caFile = "/b.crt";
    await fetchImpl("https://mw.test/", {});
    expect(dispatchers).toEqual([[PEM], [files["/b.crt"]]]);
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

  it("finds the code however deep undici nested it", () => {
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
