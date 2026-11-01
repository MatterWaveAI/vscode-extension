// The end-to-end tests: the built extension inside a real VS Code, in two
// suites under `./suite` (each runs inside the editor's extension host,
// under mocha).
//
// The editor suite always runs. It needs no deployment: it opens a
// two-folder workspace made for the run and checks what the vscode mock the
// unit tests use cannot show -- edits through the editor's buffer, undo,
// files created on the editor's file service, which folder a path lands in.
//
// The deployment suite runs against a real MatterWave deployment. For it
// this launcher does what the extension host cannot: it signs in as the
// standing e2e account the way the browser does, approves a device login
// for the run as that account, hands the key it minted to the suite, and
// revokes the key whatever the run did.
//
//   E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD   the account; without them the
//                                          deployment suite is skipped, not
//                                          failed
//   E2E_BASE_URL                           the deployment; without it the
//                                          deployment suite is skipped
//   E2E_CA_FILE                            the deployment's CA, for a private one,
//                                          trusted by both this process and the
//                                          extension host (optional)
//   E2E_MODEL                              the model the suite picks and asks
//                                          (grt-nano)
//   E2E_AUTH=none                          an API started with MW_AUTH_MODE=none
//                                          (a laptop run): no account, no
//                                          sign-in, the dev principal approves
//
// A device key, not the session, signs the extension in: that is how a
// person signs it in, it works on every plan, and the session is the
// browser's.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { runTests } from "@vscode/test-electron";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const email = process.env.E2E_ADMIN_EMAIL;
const password = process.env.E2E_ADMIN_PASSWORD;
const noAuth = process.env.E2E_AUTH === "none";
const baseUrl = (process.env.E2E_BASE_URL || "").replace(/\/+$/, "");
const model = process.env.E2E_MODEL || "grt-nano";
const caFile = process.env.E2E_CA_FILE ? path.resolve(process.env.E2E_CA_FILE) : "";

/** Why the deployment suite cannot run, or null when it can. */
const deploymentSkipped =
  !noAuth && (!email || !password)
    ? "E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD are not set"
    : !baseUrl
      ? "E2E_BASE_URL is not set"
      : null;

if (caFile && !existsSync(caFile)) {
  console.error(`vscode e2e: the CA file ${caFile} does not exist (E2E_CA_FILE).`);
  process.exit(1);
}

// Node reads NODE_EXTRA_CA_CERTS once, at start-up, and `fetch` has no
// per-call trust store: the launcher runs itself again under it.
if (caFile && process.env.NODE_EXTRA_CA_CERTS !== caFile) {
  const child = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: "inherit",
    env: { ...process.env, NODE_EXTRA_CA_CERTS: caFile },
  });
  process.exit(child.status ?? 1);
}

/** Cookies per host, as a browser keeps them across the sign-in's hops. */
class CookieJar {
  byHost = new Map();

  store(url, response) {
    const host = new URL(url).host;
    const cookies = this.byHost.get(host) ?? new Map();
    this.byHost.set(host, cookies);
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  header(url) {
    const cookies = this.byHost.get(new URL(url).host);
    return cookies && cookies.size ? [...cookies].map(([name, value]) => `${name}=${value}`).join("; ") : "";
  }

  get(url, name) {
    return this.byHost.get(new URL(url).host)?.get(name) ?? null;
  }
}

/** One request, then its redirects, each with that host's cookies; stops early at a Location `until` accepts. */
async function follow(jar, url, init = {}, until = () => false) {
  for (let hop = 0; hop < 20; hop++) {
    const headers = { ...init.headers, cookie: jar.header(url) };
    const response = await fetch(url, { ...init, headers, redirect: "manual" });
    jar.store(url, response);
    const location = response.headers.get("location");
    if (!location || response.status < 300 || response.status >= 400) return { response, url };
    const next = new URL(location, url).toString();
    if (until(next)) return { response, url: next };
    url = next;
    init = {};
  }
  throw new Error(`sign-in: more than 20 redirects from ${url}`);
}

/** The browser's sign-in, by hand: the OIDC hops to the password step, the password, the callback. */
async function signIn(jar) {
  const { url: loginUrl } = await follow(jar, `${baseUrl}/api/auth/login`, {}, (next) => next.includes("authRequest="));
  const authRequest = new URL(loginUrl).searchParams.get("authRequest");
  if (!authRequest) throw new Error(`sign-in did not reach the password step (ended at ${new URL(loginUrl).pathname})`);
  const response = await fetch(`${baseUrl}/api/auth/password`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", cookie: jar.header(baseUrl) },
    body: JSON.stringify({ email, password, auth_request: authRequest }),
  });
  jar.store(baseUrl, response);
  if (response.status !== 200) throw new Error(`POST /api/auth/password answered ${response.status}: ${await response.text()}`);
  const { redirect } = await response.json();
  await follow(jar, redirect);
  const csrf = jar.get(baseUrl, "mw_csrf");
  if (!jar.get(baseUrl, "mw_session") || !csrf) throw new Error("sign-in finished without the mw_session and mw_csrf cookies");
  return csrf;
}

/** One `/api` call as the signed-in account (cookies and the CSRF header), or as nobody under E2E_AUTH=none. */
async function call(jar, csrf, method, path, body) {
  const headers = { "content-type": "application/json" };
  if (jar) Object.assign(headers, { cookie: jar.header(baseUrl), "x-csrf-token": csrf });
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: response.status === 204 ? null : await response.json().catch(() => null) };
}

/**
 * The device login a person does, with the browser's part played by the
 * signed-in account: start the flow, approve the code, poll the key. The
 * approval answers with the key's row (its id, for the revoke), the poll
 * with its value.
 */
async function mintDeviceKey(jar, csrf) {
  const started = await call(null, null, "POST", "/api/auth/device", { client_name: `vscode e2e ${new Date().toISOString()}` });
  if (started.status !== 200) throw new Error(`POST /api/auth/device answered ${started.status}: ${JSON.stringify(started.body)}`);
  const approved = await call(jar, csrf, "POST", "/api/auth/device/approve", { user_code: started.body.user_code });
  if (approved.status !== 200) throw new Error(`POST /api/auth/device/approve answered ${approved.status}: ${JSON.stringify(approved.body)}`);
  const polled = await call(null, null, "POST", "/api/auth/device/token", { device_code: started.body.device_code });
  if (polled.status !== 200) throw new Error(`POST /api/auth/device/token answered ${polled.status}: ${JSON.stringify(polled.body)}`);
  return { id: approved.body.key.id, key: polled.body.access_token };
}

async function buildSuite() {
  await esbuild.build({
    absWorkingDir: root,
    entryPoints: ["e2e/suite/index.ts", "e2e/suite/chat.test.ts", "e2e/suite/editor.test.ts"],
    outdir: "dist/e2e",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    sourcemap: true,
    logLevel: "warning",
    // `vscode` is the editor's; mocha is required from node_modules at run
    // time, as the editor's own extension tests do.
    external: ["vscode", "mocha", "mocha/*"],
  });
}

/** The editor's flags for every suite. */
const LAUNCH_ARGS = [
  "--disable-extensions",
  "--disable-workspace-trust",
  "--skip-welcome",
  "--skip-release-notes",
  // On a Linux runner: the key goes into SecretStorage, and without a
  // keyring the basic store is the one that works; under xvfb in a
  // container there is no GPU and /dev/shm is small.
  ...(process.platform === "linux" ? ["--password-store=basic", "--disable-gpu", "--disable-dev-shm-usage"] : []),
];

/**
 * A two-folder workspace for the editor suite, made fresh for the run: two
 * roots so a path that names neither can be told from one that names the
 * second, and LF endings so what a test writes is what it reads back on
 * every platform.
 */
function editorWorkspace(dir) {
  for (const folder of ["alpha", "beta"]) {
    mkdirSync(path.join(dir, folder, "src"), { recursive: true });
    writeFileSync(path.join(dir, folder, "src", "shared.ts"), `export const where = "${folder}";\n`);
  }
  // More files than any one list of them holds, so a picker that stops at
  // a fixed count would lose some.
  mkdirSync(path.join(dir, "alpha", "many"));
  for (let i = 0; i < 600; i++) {
    const name = `file-${String(i).padStart(4, "0")}.ts`;
    writeFileSync(path.join(dir, "alpha", "many", name), `export const n = ${i};\n`);
  }
  // beta is a git repository with one change staged: what a commit
  // message is written for.
  const git = (...args) => {
    const result = spawnSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", ...args], {
      cwd: path.join(dir, "beta"),
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  };
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "Start");
  writeFileSync(path.join(dir, "beta", "src", "staged.ts"), "export const staged = true;\n");
  git("add", "src/staged.ts");
  const file = path.join(dir, "e2e.code-workspace");
  writeFileSync(
    file,
    JSON.stringify({ folders: [{ path: "alpha" }, { path: "beta" }], settings: { "files.eol": "\n", "files.autoSave": "off" } }, null, 2),
  );
  return file;
}

/** openssl from PATH, $OPENSSL, or Git for Windows' copy; null when there is none. */
function findOpenssl() {
  const candidates = [process.env.OPENSSL, "openssl", "C:\\Program Files\\Git\\usr\\bin\\openssl.exe"].filter(Boolean);
  return candidates.find((bin) => spawnSync(bin, ["version"], { stdio: "ignore" }).status === 0) ?? null;
}

/**
 * The deployment's name: one no resolver knows, so only the proxy can reach
 * it (the editor sends loopback addresses direct, never through a proxy).
 */
const TARGET_HOST = "mw-e2e.test";

/**
 * A throwaway certificate authority and a server certificate it signed for
 * TARGET_HOST: the private CA a deployment behind a corporate root
 * presents, which no system store trusts.
 */
function privateCa(dir) {
  const openssl = findOpenssl();
  if (!openssl) return null;
  const at = (name) => path.join(dir, name);
  const run = (args) => {
    const result = spawnSync(openssl, args, { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`openssl ${args[0]} failed: ${result.stderr}`);
  };
  writeFileSync(at("server.ext"), `subjectAltName=DNS:${TARGET_HOST}\nbasicConstraints=CA:FALSE\n`);
  run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", at("ca.key"), "-out", at("ca.crt"), "-days", "2", "-subj", "/CN=MatterWave e2e test CA"]);
  run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", at("server.key"), "-out", at("server.csr"), "-subj", `/CN=${TARGET_HOST}`]);
  run(["x509", "-req", "-in", at("server.csr"), "-CA", at("ca.crt"), "-CAkey", at("ca.key"), "-CAcreateserial", "-out", at("server.crt"), "-days", "2", "-extfile", at("server.ext")]);
  return { ca: at("ca.crt"), key: readFileSync(at("server.key")), cert: readFileSync(at("server.crt")) };
}

const PROXY_USER = "e2e";
const PROXY_PASSWORD = "e2e-test-pass";

/**
 * An HTTPS server behind the private CA, and an HTTP proxy in front of it
 * that refuses a tunnel without Basic credentials and tunnels to that one
 * server alone (the editor's own traffic stays off the network): the
 * network a person behind a corporate proxy has. The proxy counts what it
 * saw, and answers GET /__stats with the counts.
 */
async function proxiedDeployment(tls) {
  const stats = { tunnels: 0, refused: 0 };
  const target = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ through: "target", path: req.url }));
  });
  const expected = `Basic ${Buffer.from(`${PROXY_USER}:${PROXY_PASSWORD}`).toString("base64")}`;
  const proxy = http.createServer((req, res) => {
    if (req.url?.endsWith("/__stats")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(stats));
      return;
    }
    res.writeHead(404).end();
  });
  proxy.on("connect", (req, socket, head) => {
    if (req.headers["proxy-authorization"] !== expected) {
      stats.refused++;
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="e2e"\r\n\r\n');
      return;
    }
    const [host, port] = (req.url ?? "").split(":");
    if (host !== TARGET_HOST || Number(port) !== target.address().port) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    stats.tunnels++;
    const upstream = net.connect(Number(port), "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  await Promise.all([target, proxy].map((server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))));
  return {
    targetUrl: `https://${TARGET_HOST}:${target.address().port}`,
    proxyUrl: `http://${PROXY_USER}:${PROXY_PASSWORD}@127.0.0.1:${proxy.address().port}`,
    statsUrl: `http://127.0.0.1:${proxy.address().port}/__stats`,
    close: () => {
      for (const server of [target, proxy]) {
        server.closeAllConnections?.();
        server.close();
      }
    },
  };
}

async function runEditorSuite() {
  const dir = mkdtempSync(path.join(tmpdir(), "mw-vscode-e2e-"));
  const tls = privateCa(dir);
  if (!tls) console.log("vscode e2e: no openssl, so the proxy and private-CA test is skipped.");
  const network = tls ? await proxiedDeployment(tls) : null;
  // The editor's own network settings, as a person behind the proxy has
  // them: user settings, since a workspace cannot set http.proxy.
  const userData = path.join(dir, "user-data");
  mkdirSync(path.join(userData, "User"), { recursive: true });
  writeFileSync(path.join(userData, "User", "settings.json"), JSON.stringify(network ? { "http.proxy": network.proxyUrl } : {}, null, 2));
  try {
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(root, "dist", "e2e", "index.js"),
      cachePath: path.join(root, ".vscode-test"),
      launchArgs: [editorWorkspace(dir), `--user-data-dir=${userData}`, ...LAUNCH_ARGS],
      extensionTestsEnv: {
        ELECTRON_RUN_AS_NODE: undefined,
        E2E_SUITE: "editor",
        E2E_TLS_TARGET: network?.targetUrl,
        E2E_TLS_CA: tls?.ca,
        E2E_PROXY_STATS: network?.statsUrl,
      },
    });
  } finally {
    network?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  await buildSuite();
  await runEditorSuite();
  if (deploymentSkipped) {
    console.log(`vscode e2e: the deployment suite is SKIPPED -- ${deploymentSkipped}.`);
    return;
  }
  const jar = noAuth ? null : new CookieJar();
  const csrf = jar ? await signIn(jar) : null;
  const key = await mintDeviceKey(jar, csrf);
  console.log(`vscode e2e: device login minted key ${key.id} for this run`);
  try {
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(root, "dist", "e2e", "index.js"),
      cachePath: path.join(root, ".vscode-test"),
      launchArgs: LAUNCH_ARGS,
      extensionTestsEnv: {
        // Set in a terminal inside an editor; the editor under test must
        // start as an editor, not as a bare node.
        ELECTRON_RUN_AS_NODE: undefined,
        E2E_SUITE: "deployment",
        NODE_EXTRA_CA_CERTS: caFile || undefined,
        // The extension's fetch trusts its own matterwave.caFile, not the
        // host's NODE_EXTRA_CA_CERTS: the suite sets the setting from this.
        E2E_CA_FILE: caFile || undefined,
        E2E_BASE_URL: baseUrl,
        E2E_API_KEY: key.key,
        E2E_MODEL: model,
      },
    });
  } finally {
    const revoked = await call(jar, csrf, "DELETE", `/api/keys/${encodeURIComponent(key.id)}`);
    if (revoked.status === 204) console.log(`vscode e2e: revoked the run's key ${key.id}`);
    else console.error(`vscode e2e: DELETE /api/keys/${key.id} answered ${revoked.status}; revoke it under Settings -> API keys`);
  }
}

main().catch((error) => {
  console.error(`vscode e2e: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
