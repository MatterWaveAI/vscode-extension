/**
 * `@matterwave/sdk/agent`: the agent tool contract, its pure helpers, and
 * path confinement, which reads the filesystem and so needs Node (the
 * VS Code extension host, a CLI). Browser code imports the `agent`
 * namespace from `@matterwave/sdk` instead, which is everything here but
 * `confine`, `loadDenyList` and `resolveLinks`.
 *
 *     import { confine, applyEdit, unifiedDiff, PathRefusedError } from "@matterwave/sdk/agent";
 *
 *     const target = confine(root, "src/app.ts");       // or PathRefusedError
 *     const next = applyEdit(text, oldString, newString); // or EditError
 *     const diff = unifiedDiff(text, next, target.relative);
 */

export * from "./index.js";
export { confine, loadDenyList, resolveLinks } from "./confine.js";
export type { ConfinedPath } from "./confine.js";
