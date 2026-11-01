import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as agent from "../src/lib/sdk/agent/node";

/**
 * The vendored copy of @matterwave/sdk's agent module (src/lib/sdk/agent) is
 * the SDK's bytes, unedited: every file hashes to what the manifest recorded
 * when scripts/sdk-agent.mjs --sync copied it, and the contract hashes to the
 * value it was generated with, and nothing is there the manifest does not
 * name. With an SDK checkout at hand (MATTERWAVE_SDK_DIR, or `typescript-sdk`
 * beside this repository) that has the ref the copy was taken from, the copy
 * is also compared with that ref, byte for byte.
 */

const here = dirname(fileURLToPath(import.meta.url));
const vendored = resolve(here, "../src/lib/sdk/agent");
const manifest = JSON.parse(readFileSync(resolve(here, "../src/lib/sdk/VENDORED.json"), "utf8")) as {
  ref: string;
  commit: string;
  contract_version: string;
  contract_sha256: string;
  files: Record<string, string>;
};
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

const sdkDir = process.env.MATTERWAVE_SDK_DIR
  ? resolve(process.env.MATTERWAVE_SDK_DIR)
  : [resolve(here, "../../typescript-sdk"), resolve(here, "../../../matterwave-repos/typescript-sdk")].find((dir) =>
      existsSync(join(dir, "package.json")),
    );

/** The SDK checkout, when it has the ref the manifest names. */
const sdkRef = (() => {
  if (!sdkDir) return null;
  try {
    execFileSync("git", ["-C", sdkDir, "rev-parse", "--verify", `${manifest.ref}^{commit}`], { stdio: "ignore" });
    return sdkDir;
  } catch {
    return null;
  }
})();

describe("the vendored SDK agent module", () => {
  it.each(Object.entries(manifest.files))("%s is the SDK's file, unedited", (file, digest) => {
    expect(sha256(readFileSync(join(vendored, file)))).toBe(digest);
  });

  it("holds no file the manifest does not name", () => {
    expect(readdirSync(vendored).sort()).toEqual(Object.keys(manifest.files).sort());
  });

  it("carries the contract it was generated with", () => {
    expect(sha256(JSON.stringify(agent.CONTRACT))).toBe(agent.CONTRACT_SHA256);
    expect(agent.CONTRACT_SHA256).toBe(manifest.contract_sha256);
    expect(agent.CONTRACT_VERSION).toBe(manifest.contract_version);
  });

  it("names the seven tools and the four modes the clients share", () => {
    expect(agent.TOOL_NAMES).toEqual(["read_file", "list_dir", "glob", "grep", "edit", "write_file", "run_shell"]);
    expect(agent.MODE_NAMES).toEqual(["plan", "ask", "auto-edit", "yolo"]);
    expect(agent.DEFAULT_MODE).toBe("ask");
  });

  it.skipIf(!sdkRef)(`matches the SDK's ${manifest.ref} byte for byte (when a checkout that has it is at hand)`, () => {
    for (const file of Object.keys(manifest.files)) {
      const upstream = execFileSync("git", ["-C", sdkRef!, "show", `${manifest.ref}:src/agent/${file}`]);
      expect(sha256(upstream), `${file} drifted from the SDK's ${manifest.ref}; run pnpm sdk:sync --ref ${manifest.ref}`).toBe(
        manifest.files[file],
      );
    }
  });
});
