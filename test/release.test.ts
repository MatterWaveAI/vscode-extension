import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * scripts/release.mjs and scripts/sbom.mjs, run the way the release
 * workflow runs them: the tag gate, the CHANGELOG section that becomes the
 * GitHub release's notes, and the SBOM attached beside the .vsix.
 */

const script = (name: string) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  name: string;
  publisher: string;
  version: string;
};

function run(name: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [script(name), ...args], { encoding: "utf8" });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

describe("the release script", () => {
  it("passes the tag that names the manifest version", () => {
    expect(run("release.mjs", "check-tag", `v${pkg.version}`).status).toBe(0);
  });

  it("refuses any other tag, saying which it expected", () => {
    const result = run("release.mjs", "check-tag", "v0.0.0-not-it");
    expect(result.status).toBe(1);
    expect(result.err).toContain(`expected v${pkg.version}`);
  });

  it("prints a version's CHANGELOG section and nothing after it", () => {
    const result = run("release.mjs", "notes", "0.2.1");
    expect(result.status).toBe(0);
    expect(result.out).toContain("### Added");
    expect(result.out).not.toMatch(/^## \[/m);
  });

  it("refuses a version with no section", () => {
    const result = run("release.mjs", "notes", "0.0.0");
    expect(result.status).toBe(1);
    expect(result.err).toContain("no section for 0.0.0");
  });
});

describe("the SBOM script", () => {
  it("writes CycloneDX naming the extension and every package its bundles hold, the vendored SDK included", () => {
    const result = run("sbom.mjs");
    expect(result.status, result.err).toBe(0);
    const bom = JSON.parse(result.out);
    expect(bom).toMatchObject({ bomFormat: "CycloneDX", specVersion: "1.5", version: 1 });
    expect(bom.metadata.component).toMatchObject({
      type: "application",
      name: `${pkg.publisher}.${pkg.name}`,
      version: pkg.version,
      licenses: [{ license: { id: "Apache-2.0" } }],
    });
    const sdk = bom.components.find((c: { name: string }) => c.name === "@matterwave/sdk");
    expect(sdk).toMatchObject({ purl: expect.stringMatching(/^pkg:npm\/%40matterwave\/sdk@\d+\.\d+\.\d+$/) });
    for (const component of bom.components) {
      expect(component.purl).toMatch(/^pkg:npm\//);
      expect(component.version).toMatch(/^\d+\.\d+\.\d+/);
    }
    // Nothing the tests or the build use is in it: only what ships.
    const names = bom.components.map((c: { name: string }) => c.name);
    for (const devOnly of ["vitest", "esbuild", "typescript", "@vscode/vsce"]) expect(names).not.toContain(devOnly);
    expect(bom.dependencies[0].dependsOn).toHaveLength(bom.components.length);
  }, 60_000);
});
