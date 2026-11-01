// The SDK's agent contract and helpers, vendored into src/lib/sdk/agent.
//
// `@matterwave/sdk` is not on npm and this repository builds alone (CI, the
// .vsix), so the extension carries a byte-for-byte copy of the SDK's
// `src/agent/*.ts`: the tool contract generated from the Python SDK's
// contract.json, confinement, the deny list, edit, diff and modes. Nothing in
// src/lib/sdk/agent is edited here; src/lib/sdk/types.ts is the one shim, for
// the `Tool` type modes.ts imports from the SDK's own types.
//
//   node scripts/sdk-agent.mjs --check   compare the copy with the SDK (the default)
//   node scripts/sdk-agent.mjs --sync    copy the SDK's files over and rewrite the manifest
//
// The SDK is read from MATTERWAVE_SDK_DIR, or a `typescript-sdk` checkout
// beside this one, at the git ref MATTERWAVE_SDK_REF (default `develop`), so
// a working tree with uncommitted changes is not what gets vendored. Without
// an SDK checkout --check says so and passes: the manifest test
// (test/sdkVendor.test.ts) still catches a hand edit of the copy.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "src", "lib", "sdk", "agent");
const manifestPath = path.join(root, "src", "lib", "sdk", "VENDORED.json");
const FILES = ["contract.ts", "types.ts", "modes.ts", "deny.ts", "confine.ts", "edit.ts", "diff.ts", "index.ts", "node.ts"];

const sdkDir = process.env.MATTERWAVE_SDK_DIR
  ? path.resolve(process.env.MATTERWAVE_SDK_DIR)
  : [path.join(root, "..", "typescript-sdk"), path.join(root, "..", "..", "matterwave-repos", "typescript-sdk")].find((dir) =>
      existsSync(path.join(dir, "package.json")),
    );
const ref = process.env.MATTERWAVE_SDK_REF || "develop";
const mode = process.argv.includes("--sync") ? "sync" : "check";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function upstream(file) {
  return execFileSync("git", ["-C", sdkDir, "show", `${ref}:src/agent/${file}`], { maxBuffer: 16 * 1024 * 1024 });
}

if (!sdkDir) {
  console.log("sdk-agent: no typescript-sdk checkout found (set MATTERWAVE_SDK_DIR); nothing to compare.");
  process.exit(0);
}

const commit = execFileSync("git", ["-C", sdkDir, "rev-parse", ref], { encoding: "utf8" }).trim();

if (mode === "sync") {
  mkdirSync(target, { recursive: true });
  const files = {};
  for (const file of FILES) {
    const bytes = upstream(file);
    writeFileSync(path.join(target, file), bytes);
    files[file] = sha256(bytes);
  }
  const contract = readFileSync(path.join(target, "contract.ts"), "utf8");
  const manifest = {
    about: "A byte-for-byte copy of @matterwave/sdk src/agent; scripts/sdk-agent.mjs --sync rewrites it, test/sdkVendor.test.ts holds it.",
    source: "MatterWaveAI/typescript-sdk",
    ref,
    commit,
    contract_version: /"contract_version":\s*"([^"]+)"/.exec(contract)?.[1] ?? null,
    contract_sha256: /CONTRACT_SHA256 = "([0-9a-f]{64})"/.exec(contract)?.[1] ?? null,
    files,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`sdk-agent: vendored ${FILES.length} files from ${ref} (${commit.slice(0, 12)})`);
  process.exit(0);
}

const drift = [];
for (const file of FILES) {
  const local = existsSync(path.join(target, file)) ? readFileSync(path.join(target, file)) : null;
  if (local === null || sha256(local) !== sha256(upstream(file))) drift.push(file);
}
if (drift.length > 0) {
  console.error(`sdk-agent: the vendored copy differs from ${ref} (${commit.slice(0, 12)}): ${drift.join(", ")}`);
  console.error("sdk-agent: run `node scripts/sdk-agent.mjs --sync` and commit the result.");
  process.exit(1);
}
console.log(`sdk-agent: the vendored copy matches ${ref} (${commit.slice(0, 12)})`);
