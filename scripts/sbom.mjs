#!/usr/bin/env node
// A CycloneDX SBOM of what the .vsix ships, on stdout:
//
//     node scripts/sbom.mjs > matterwave-0.3.0.cdx.json
//
// The extension installs no npm dependencies -- everything it runs is
// bundled into dist/ by esbuild -- so `npm sbom` would list nothing. This
// asks esbuild which files each bundle is made of (the same build
// definitions as esbuild.mjs, nothing written) and lists every package
// those files come from, plus the SDK vendored at src/lib.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { builds } from "../esbuild.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VENDORED_SDK = "src/lib/matterwaveClient.ts";

/** pkg:npm purl, scope escaped as the spec asks. */
function purl(name, version) {
  return `pkg:npm/${name.replace(/^@/, "%40")}@${version}`;
}

function licenses(license) {
  if (!license || typeof license !== "string") return undefined;
  return /^[A-Za-z0-9.+-]+$/.test(license) ? [{ license: { id: license } }] : [{ expression: license }];
}

/** The package directory an input path sits in: up to `node_modules/<name>` (or `<@scope>/<name>`). */
export function packageDirOf(input) {
  const parts = input.replace(/\\/g, "/").split("/");
  const at = parts.lastIndexOf("node_modules");
  if (at < 0 || at + 1 >= parts.length) return null;
  const scoped = parts[at + 1]?.startsWith("@");
  const end = at + (scoped ? 3 : 2);
  return end <= parts.length ? parts.slice(0, end).join("/") : null;
}

async function bundledPackages() {
  const dirs = new Set();
  for (const options of builds) {
    const result = await esbuild.build({ ...options, absWorkingDir: ROOT, write: false, metafile: true, logLevel: "silent" });
    for (const input of Object.keys(result.metafile.inputs)) {
      const dir = packageDirOf(input);
      if (dir) dirs.add(dir);
    }
  }
  const packages = new Map();
  for (const dir of dirs) {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, dir, "package.json"), "utf8"));
    packages.set(`${pkg.name}@${pkg.version}`, { name: pkg.name, version: pkg.version, license: pkg.license });
  }
  return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function vendoredSdk() {
  const header = readFileSync(resolve(ROOT, VENDORED_SDK), "utf8").slice(0, 2000);
  const version = /version (\d+\.\d+\.\d+)/.exec(header)?.[1];
  if (!version) throw new Error(`${VENDORED_SDK} does not say which SDK version it was vendored from`);
  return { name: "@matterwave/sdk", version, license: "MIT", vendoredAt: VENDORED_SDK };
}

export async function sbom() {
  const manifest = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  // A VS Code extension is not an npm package, so the root is named by its
  // Marketplace identifier rather than given a purl.
  const name = `${manifest.publisher}.${manifest.name}`;
  const root = `${name}@${manifest.version}`;
  const components = [...(await bundledPackages()), vendoredSdk()].map((pkg) => ({
    type: "library",
    "bom-ref": purl(pkg.name, pkg.version),
    name: pkg.name,
    version: pkg.version,
    purl: purl(pkg.name, pkg.version),
    ...(licenses(pkg.license) ? { licenses: licenses(pkg.license) } : {}),
    ...(pkg.vendoredAt ? { properties: [{ name: "matterwave:vendored-at", value: pkg.vendoredAt }] } : {}),
  }));
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: { components: [{ type: "application", name: "scripts/sbom.mjs" }] },
      component: {
        type: "application",
        "bom-ref": root,
        name,
        version: manifest.version,
        licenses: licenses(manifest.license),
      },
    },
    components,
    dependencies: [{ ref: root, dependsOn: components.map((c) => c["bom-ref"]) }],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await sbom(), null, 2)}\n`);
}
