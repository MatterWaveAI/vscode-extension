/**
 * Path confinement: the check every tool runs before it touches a path.
 * Node only (it reads the filesystem), so it ships in the
 * `@matterwave/sdk/agent` entry and not in the browser-safe main one.
 *
 * `confine(root, path)` resolves `path` against the workspace root, follows
 * its links (symbolic links, and junctions on Windows) and returns where it
 * really leads, or throws `PathRefusedError` before anything is read or
 * written: for a `..` segment, an absolute path outside the root, a link
 * that leads out of it or loops, a name Windows would read as another file or
 * a device (a `:` stream, a trailing dot or space, `NUL` and the other
 * reserved names, a verbatim or UNC path; only the names below the root
 * count), a path on the deny list (by its own name or its target's), or, for
 * a write, a protected path the user has not approved. Nothing else escapes
 * it: whatever the OS makes of a path, the error is a `PathRefusedError`.
 *
 * Confinement is not a sandbox. It keeps the file tools inside the root;
 * `run_shell` can reach anything the user can, which is why commands ask.
 */

import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import * as nodePath from "node:path";
import { DenyList, PROTECTED_LIST, PathRefusedError, isAbsolute, windowsAlias } from "./deny.js";
import { DENY_FILE } from "./types.js";

const MAX_LINK_HOPS = 40;

/**
 * Where a tool's path really leads: `absolute`, with every link followed,
 * and `relative`, the same place relative to the resolved root with `/`
 * separators (`.` for the root itself).
 */
export interface ConfinedPath {
  absolute: string;
  relative: string;
}

function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function stripVerbatim(path: string): string {
  for (const prefix of ["\\\\?\\", "\\??\\"]) {
    if (path.startsWith(prefix)) return path.slice(prefix.length);
  }
  return path;
}

/**
 * `path` with every link in it followed, whether or not its target exists:
 * the deepest part that exists is resolved by the OS, and a dangling link is
 * read and followed by hand, so a write through it is caught as well as a
 * read. An error with `code` `ELOOP` when the links loop, or take more than
 * 40 hops.
 */
export function resolveLinks(path: string): string {
  let current = nodePath.resolve(path);
  for (let hop = 0; hop < MAX_LINK_HOPS; hop++) {
    let head = current;
    let rest = "";
    while (!lexists(head)) {
      const parent = nodePath.dirname(head);
      if (parent === head) break;
      const name = nodePath.basename(head);
      rest = rest ? nodePath.join(name, rest) : name;
      head = parent;
    }
    if (isLink(head) && !existsSync(head)) {
      const target = stripVerbatim(readlinkSync(head));
      const base = nodePath.isAbsolute(target) ? target : nodePath.join(nodePath.dirname(head), target);
      current = nodePath.resolve(rest ? nodePath.join(base, rest) : base);
      continue;
    }
    let real = head;
    try {
      real = realpathSync.native(head);
    } catch {
      // Nothing of the path exists (a missing drive): it is its own answer.
    }
    return rest ? nodePath.join(real, rest) : real;
  }
  throw Object.assign(new Error(`ELOOP: too many levels of links, ${path}`), { code: "ELOOP", path });
}

function normcase(path: string): string {
  const normal = nodePath.normalize(path);
  return process.platform === "win32" ? normal.toLowerCase() : normal;
}

/** @internal Whether `child` is `parent` or under it, with the platform's case rules. */
export function within(child: string, parent: string): boolean {
  const c = normcase(child);
  const p = normcase(parent);
  return c === p || c.startsWith(p.replace(/[\\/]+$/, "") + nodePath.sep);
}

/** @internal `child` relative to `parent` with `/` separators, `""` for `parent` itself. */
export function relativeTo(child: string, parent: string): string {
  const rel = nodePath.relative(parent, child);
  return rel === "" || rel === "." ? "" : rel.split(nodePath.sep).join("/");
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The contract's defaults plus every pattern line of `<root>/.matterwaveignore`. */
export function loadDenyList(root: string): DenyList {
  const file = nodePath.join(root, DENY_FILE);
  try {
    if (statSync(file).isFile()) return DenyList.withIgnoreFile(readFileSync(file, "utf-8"));
  } catch {
    // No deny file: the defaults alone.
  }
  return new DenyList();
}

/**
 * Where `path` leads inside `root`, or `PathRefusedError`. `deny` defaults to
 * the root's `loadDenyList`; `write: true` also refuses the protected paths
 * unless `approved: true` says the user approved this write, since a change
 * to one always asks first.
 */
export function confine(
  root: string,
  path: string,
  options: { deny?: DenyList; write?: boolean; approved?: boolean } = {},
): ConfinedPath {
  if (!path || path.trim() === "") throw new PathRefusedError("empty", path ?? "");
  if (path.includes("\0")) throw new PathRefusedError("outside", path.split("\0").join(""));
  if (path.split(/[\\/]/).includes("..")) throw new PathRefusedError("parent", path);
  try {
    return confineResolved(root, path, options);
  } catch (error) {
    if (error instanceof PathRefusedError) throw error;
    const code = (error as { code?: unknown } | null)?.code;
    throw new PathRefusedError(code === "ELOOP" ? "loop" : "outside", path);
  }
}

function confineResolved(
  root: string,
  path: string,
  options: { deny?: DenyList; write?: boolean; approved?: boolean },
): ConfinedPath {
  const givenRoot = nodePath.resolve(root);
  const realRoot = resolveLinks(givenRoot);
  // Only the names below the root are the agent's; the folders above it are
  // the user's, whatever they are called.
  let alias = windowsAlias(path, givenRoot);
  if (alias !== null && realRoot !== givenRoot) alias = windowsAlias(path, realRoot);
  if (alias !== null) throw new PathRefusedError(alias, path);

  let lexical: string;
  let lexicalRel: string;
  if (isAbsolute(path)) {
    lexical = nodePath.normalize(nodePath.resolve(path));
    if (within(lexical, realRoot)) lexicalRel = relativeTo(lexical, realRoot);
    else if (within(lexical, givenRoot)) lexicalRel = relativeTo(lexical, givenRoot);
    else throw new PathRefusedError("outside", path);
  } else {
    lexical = nodePath.normalize(nodePath.join(realRoot, path));
    lexicalRel = relativeTo(lexical, realRoot);
  }

  const real = resolveLinks(lexical);
  if (!within(real, realRoot)) throw new PathRefusedError("symlink", path);
  const realRel = relativeTo(real, realRoot);

  const deny = options.deny ?? loadDenyList(realRoot);
  const isDir = isDirectory(real);
  for (const rel of [lexicalRel, realRel]) {
    if (rel && deny.matches(rel, { isDir })) throw new PathRefusedError("denied", path);
  }
  if (options.write && !options.approved) {
    for (const rel of [lexicalRel, realRel]) {
      if (rel && PROTECTED_LIST.matches(rel, { isDir })) throw new PathRefusedError("protected", path);
    }
  }
  return { absolute: real, relative: realRel || "." };
}
