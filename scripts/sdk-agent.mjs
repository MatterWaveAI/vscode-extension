// The SDK's agent contract and helpers, vendored into src/lib/sdk/agent.
//
// `@matterwave/sdk` is not on npm and this repository builds alone (CI, the
// .vsix), so the extension carries a byte-for-byte copy of the SDK's
// `src/agent/*.ts`: the tool contract generated from the Python SDK's
// contract.json, confinement, the deny list and the search rules, the read
// tools and their output, edit, diff and modes. Nothing in src/lib/sdk/agent
// is edited here; src/lib/sdk/types.ts is the one shim, for the `Tool` type
// modes.ts imports from the SDK's own types.
//
//   node scripts/sdk-agent.mjs --check   compare the copy with the SDK (the default)
//   node scripts/sdk-agent.mjs --sync    copy the SDK's files over and rewrite the manifest
//
// Where the SDK is, either way:
//
//   --sdk <dir>  or MATTERWAVE_SDK_DIR   a typescript-sdk checkout or worktree (relative
//                                        paths are fine); by default one beside this
//                                        repository
//   --ref <ref>  or MATTERWAVE_SDK_REF   the git ref read from it, so a working tree with
//                                        uncommitted changes is not what gets vendored;
//                                        --sync defaults to `develop`, --check to the ref
//                                        the manifest says was vendored
//
// Every `*.ts` in the ref's `src/agent` is copied, so a file the SDK adds
// comes with the next sync and --check names it until then. Without an SDK
// checkout --check says so and passes: the manifest test
// (test/sdkVendor.test.ts) still catches a hand edit of the copy.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "src", "lib", "sdk", "agent");
const manifestPath = path.join(root, "src", "lib", "sdk", "VENDORED.json");

function flag(name) {
  const at = process.argv.indexOf(name);
  if (at === -1) return undefined;
  const value = process.argv[at + 1];
  if (!value || value.startsWith("--")) {
    console.error(`sdk-agent: ${name} needs a value`);
    process.exit(2);
  }
  return value;
}

const mode = process.argv.includes("--sync") ? "sync" : "check";
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
const given = flag("--sdk") ?? process.env.MATTERWAVE_SDK_DIR;
const sdkDir = given
  ? path.resolve(given)
  : [path.join(root, "..", "typescript-sdk"), path.join(root, "..", "..", "matterwave-repos", "typescript-sdk")].find((dir) =>
      existsSync(path.join(dir, "package.json")),
    );
const ref = flag("--ref") ?? process.env.MATTERWAVE_SDK_REF ?? (mode === "check" && manifest?.ref ? manifest.ref : "develop");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (...args) => execFileSync("git", ["-C", sdkDir, ...args], { maxBuffer: 16 * 1024 * 1024 });

if (!sdkDir) {
  console.log("sdk-agent: no typescript-sdk checkout found (pass --sdk or set MATTERWAVE_SDK_DIR); nothing to compare.");
  process.exit(0);
}
if (!existsSync(path.join(sdkDir, "package.json"))) {
  console.error(`sdk-agent: ${sdkDir} is not a typescript-sdk checkout`);
  process.exit(2);
}

const commit = git("rev-parse", "--verify", `${ref}^{commit}`).toString("utf8").trim();
const upstreamFiles = git("ls-tree", "--name-only", `${commit}:src/agent`)
  .toString("utf8")
  .split("\n")
  .filter((name) => name.endsWith(".ts"))
  .sort();
const upstream = (file) => git("show", `${commit}:src/agent/${file}`);
const localFiles = existsSync(target) ? readdirSync(target).filter((name) => name.endsWith(".ts")).sort() : [];

if (mode === "sync") {
  mkdirSync(target, { recursive: true });
  for (const file of localFiles) if (!upstreamFiles.includes(file)) rmSync(path.join(target, file));
  const files = {};
  for (const file of upstreamFiles) {
    const bytes = upstream(file);
    writeFileSync(path.join(target, file), bytes);
    files[file] = sha256(bytes);
  }
  const contract = readFileSync(path.join(target, "contract.ts"), "utf8");
  const next = {
    about: "A byte-for-byte copy of @matterwave/sdk src/agent; scripts/sdk-agent.mjs --sync rewrites it, test/sdkVendor.test.ts holds it.",
    source: "MatterWaveAI/typescript-sdk",
    ref,
    commit,
    contract_version: /"contract_version":\s*"([^"]+)"/.exec(contract)?.[1] ?? null,
    contract_sha256: /CONTRACT_SHA256 = "([0-9a-f]{64})"/.exec(contract)?.[1] ?? null,
    files,
  };
  writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`sdk-agent: vendored ${upstreamFiles.length} files from ${ref} (${commit.slice(0, 12)})`);
  process.exit(0);
}

const drift = [];
for (const file of new Set([...upstreamFiles, ...localFiles])) {
  const local = localFiles.includes(file) ? readFileSync(path.join(target, file)) : null;
  if (local === null) drift.push(`${file} (not vendored)`);
  else if (!upstreamFiles.includes(file)) drift.push(`${file} (gone from the SDK)`);
  else if (sha256(local) !== sha256(upstream(file))) drift.push(file);
}
if (drift.length > 0) {
  console.error(`sdk-agent: the vendored copy differs from ${ref} (${commit.slice(0, 12)}): ${drift.join(", ")}`);
  console.error("sdk-agent: run `pnpm sdk:sync` (with the same --sdk and --ref) and commit the result.");
  process.exit(1);
}
console.log(`sdk-agent: the vendored copy matches ${ref} (${commit.slice(0, 12)})`);
