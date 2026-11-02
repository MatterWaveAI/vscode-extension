/**
 * `@matterwave/sdk/agent`: the agent tool contract, its pure helpers, and
 * path confinement, which reads the filesystem and so needs Node (the
 * VS Code extension host, a CLI). Browser code imports the `agent`
 * namespace from `@matterwave/sdk` instead, which is everything here but
 * `confine`, `loadDenyList`, `resolveLinks` and the search: `walk`,
 * `loadSearchIgnore`, `runReadFile`, `runListDir`, `runGlob` and `runGrep`,
 * and their async forms `walkAsync`, `runGlobAsync` and `runGrepAsync`, which
 * yield to the event loop and stop on a `signal` (`runGrepAsync` reads and
 * matches on worker threads, ended at its `timeoutS` of matching or its
 * `maxDurationS` in all).
 *
 *     import { confine, applyEdit, unifiedDiff, PathRefusedError } from "@matterwave/sdk/agent";
 *
 *     const target = confine(root, "src/app.ts");       // or PathRefusedError
 *     const next = applyEdit(text, oldString, newString); // or EditError
 *     const diff = unifiedDiff(text, next, target.relative);
 *     const hits = runGrep(root, "TODO", { glob: "*.ts" });  // grep's text, as every client prints it
 *
 * @module @matterwave/sdk/agent
 */

export * from "./index.js";
export { confine, loadDenyList, resolveLinks } from "./confine.js";
export type { ConfinedPath } from "./confine.js";
export {
  loadSearchIgnore,
  runGlob,
  runGlobAsync,
  runGrep,
  runGrepAsync,
  runListDir,
  runReadFile,
  walk,
  walkAsync,
} from "./search.js";
export type { GlobOptions, GrepAsyncOptions, GrepOptions } from "./search.js";
