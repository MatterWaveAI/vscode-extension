// Two bundles: the extension host (Node, CommonJS, `vscode` provided by the
// editor at runtime) and the webview script (a browser IIFE loaded under a
// nonce-only CSP, so it must be one self-contained file). The definitions
// are exported for scripts/sbom.mjs, which lists what the bundles hold.
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const common = { bundle: true, sourcemap: true, minify: !watch, logLevel: "info" };

export const builds = [
  {
    ...common,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
  },
  {
    ...common,
    entryPoints: ["src/webview/main.ts"],
    outfile: "dist/webview.js",
    platform: "browser",
    format: "iife",
    target: "es2022",
  },
];

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invoked && watch) {
  for (const options of builds) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  }
} else if (invoked) {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
