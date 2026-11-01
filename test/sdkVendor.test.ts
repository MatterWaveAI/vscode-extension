import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as agent from "../src/lib/sdk/agent/node";

/**
 * The vendored copy of @matterwave/sdk's agent module (src/lib/sdk/agent) is
 * the SDK's bytes, unedited: every file hashes to what the manifest recorded
 * when scripts/sdk-agent.mjs --sync copied it, and the contract hashes to the
 * value it was generated with. With an SDK checkout at hand
 * (MATTERWAVE_SDK_DIR, or `typescript-sdk` beside this repository) the copy
 * is also compared with the SDK's `develop`, byte for byte.
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

describe("the vendored SDK agent module", () => {
  it.each(Object.entries(manifest.files))("%s is the SDK's file, unedited", (file, digest) => {
    expect(sha256(readFileSync(join(vendored, file)))).toBe(digest);
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

  it.skipIf(!sdkDir)("matches the SDK's develop byte for byte (when a checkout is at hand)", () => {
    for (const file of Object.keys(manifest.files)) {
      const upstream = execFileSync("git", ["-C", sdkDir!, "show", `${manifest.ref}:src/agent/${file}`]);
      expect(sha256(upstream), `${file} drifted from the SDK's ${manifest.ref}; run node scripts/sdk-agent.mjs --sync`).toBe(
        manifest.files[file],
      );
    }
  });
});
