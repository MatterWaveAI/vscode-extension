// Two bundles: the extension host (Node, CommonJS, `vscode` provided by the
// editor at runtime) and the webview script (a browser IIFE loaded under a
// nonce-only CSP, so it must be one self-contained file).
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

// The TypeScript SDK is bundled from its source in this repository, the way
// the terminal client depends on the Python SDK by path: no publish and no
// build of the SDK stands between a change there and the extension. The same
// alias is in tsconfig.json (types) and vitest.config.mts (tests).
const sdk = fileURLToPath(new URL("../../sdk/typescript/src/index.ts", import.meta.url));

const common = { bundle: true, sourcemap: true, minify: !watch, logLevel: "info", alias: { "@matterwave/sdk": sdk } };

const builds = [
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

if (watch) {
  for (const options of builds) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  }
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
