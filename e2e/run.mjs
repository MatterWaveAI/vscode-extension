// The end-to-end test: the built extension inside a real VS Code, against a
// real MatterWave deployment. This launcher does what the extension host
// cannot: it signs in as the standing e2e account the way the browser does,
// approves a device login for the run as that account, hands the key it
// minted to the suite in `./suite` (which runs inside the editor's extension
// host, under mocha), and revokes the key whatever the run did.
//
//   E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD   the account; without them the
//                                          test is skipped, not failed
//   E2E_BASE_URL                           the deployment; without it the test
//                                          is skipped
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
import { existsSync } from "node:fs";
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

if (!noAuth && (!email || !password)) {
  console.log("vscode e2e: SKIPPED -- E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD are not set.");
  process.exit(0);
}
if (!baseUrl) {
  console.log("vscode e2e: SKIPPED -- E2E_BASE_URL is not set.");
  process.exit(0);
}
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
    entryPoints: ["e2e/suite/index.ts", "e2e/suite/chat.test.ts"],
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

async function main() {
  await buildSuite();
  const jar = noAuth ? null : new CookieJar();
  const csrf = jar ? await signIn(jar) : null;
  const key = await mintDeviceKey(jar, csrf);
  console.log(`vscode e2e: device login minted key ${key.id} for this run`);
  try {
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(root, "dist", "e2e", "index.js"),
      cachePath: path.join(root, ".vscode-test"),
      launchArgs: [
        "--disable-extensions",
        "--disable-workspace-trust",
        "--skip-welcome",
        "--skip-release-notes",
        // On a Linux runner: the key goes into SecretStorage, and without a
        // keyring the basic store is the one that works; under xvfb in a
        // container there is no GPU and /dev/shm is small.
        ...(process.platform === "linux" ? ["--password-store=basic", "--disable-gpu", "--disable-dev-shm-usage"] : []),
      ],
      extensionTestsEnv: {
        // Set in a terminal inside an editor; the editor under test must
        // start as an editor, not as a bare node.
        ELECTRON_RUN_AS_NODE: undefined,
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
