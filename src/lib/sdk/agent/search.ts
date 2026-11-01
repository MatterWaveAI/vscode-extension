/**
 * The read tools over a real workspace, Node only: the walker glob and grep
 * share, and read_file, list_dir, glob and grep themselves, each returning
 * the text the contract's `outputs` spell or throwing `PathRefusedError` or
 * `ToolError` (return its `message` as the result, with the error flag).
 *
 * The walk is depth first, a directory's files before its subdirectories,
 * each in code-point order; it leaves out what the deny list refuses and what
 * the .gitignore and .matterwaveignore files from the root down ignore
 * (`SearchIgnore`), follows a link to a file only when it leads inside the
 * root to a path that is not denied, and never follows a link to a
 * directory. The `path` a search is given is searched even when it is
 * ignored itself.
 */

import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import * as nodePath from "node:path";
import { confine, loadDenyList, relativeTo, resolveLinks, within } from "./confine.js";
import type { DenyList } from "./deny.js";
import { SearchIgnore } from "./ignore.js";
import {
  ToolError,
  checkLines,
  compareCodePoints,
  decodeText,
  formatGlob,
  formatGrep,
  formatListDir,
  formatReadFile,
  globMatches,
  isBinary,
  limit,
  textLines,
  type Limits,
} from "./output.js";

/** The rules of the workspace at `root`, its ignore files read from disk; `deny` defaults to `loadDenyList(root)`. */
export function loadSearchIgnore(root: string, options: { deny?: DenyList } = {}): SearchIgnore {
  const base = nodePath.resolve(root);
  return new SearchIgnore(
    (relative) => {
      try {
        const file = nodePath.join(base, relative);
        return statSync(file).isFile() ? readFileSync(file, "utf-8") : null;
      } catch {
        return null;
      }
    },
    { deny: options.deny ?? loadDenyList(base) },
  );
}

interface Entry {
  relative: string;
  isDir: boolean;
  isLink: boolean;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function kindOf(entry: Dirent, absolute: string, realRoot: string, deny: DenyList): { isDir: boolean; isLink: boolean } | null {
  if (entry.isSymbolicLink()) {
    const target = resolveLinks(absolute);
    if (!within(target, realRoot) || !existsSync(target)) return null;
    const rel = relativeTo(target, realRoot);
    const isDir = isDirectory(target);
    if (rel && deny.matches(rel, { isDir })) return null;
    return { isDir, isLink: true };
  }
  if (entry.isDirectory()) return { isDir: true, isLink: false };
  if (entry.isFile()) return { isDir: false, isLink: false };
  return null;
}

function entries(realRoot: string, directory: string, rules: SearchIgnore): Entry[] {
  const absolute = directory ? nodePath.join(realRoot, directory) : realRoot;
  let found: Dirent[];
  try {
    found = readdirSync(absolute, { withFileTypes: true });
  } catch {
    return [];
  }
  found.sort((a, b) => compareCodePoints(a.name, b.name));
  const shown: Entry[] = [];
  for (const entry of found) {
    const kind = kindOf(entry, nodePath.join(absolute, entry.name), realRoot, rules.deny);
    if (kind === null) continue;
    const relative = directory ? `${directory}/${entry.name}` : entry.name;
    if (rules.ignored(relative, { isDir: kind.isDir, ancestors: false })) continue;
    shown.push({ relative, ...kind });
  }
  return shown;
}

function setup(root: string, options: { deny?: DenyList; ignore?: SearchIgnore }): {
  realRoot: string;
  deny: DenyList;
  rules: SearchIgnore;
} {
  const realRoot = resolveLinks(nodePath.resolve(root));
  const deny = options.deny ?? loadDenyList(realRoot);
  const rules = options.ignore ?? loadSearchIgnore(realRoot, { deny });
  return { realRoot, deny, rules };
}

function* walkFrom(realRoot: string, start: string, startIsFile: boolean, rules: SearchIgnore): Generator<string> {
  if (startIsFile) {
    yield start;
    return;
  }
  const stack = [start === "." ? "" : start];
  while (stack.length > 0) {
    const directory = stack.pop()!;
    const subdirs: string[] = [];
    for (const entry of entries(realRoot, directory, rules)) {
      if (!entry.isDir) yield entry.relative;
      else if (!entry.isLink) subdirs.push(entry.relative);
    }
    stack.push(...subdirs.reverse());
  }
}

/**
 * The files a search under `path` sees, relative to the root with `/`
 * separators, in walk order. `path` itself is confined (`PathRefusedError`)
 * and must exist (`ToolError`); a file is its own one result.
 */
export function* walk(
  root: string,
  path = ".",
  options: { deny?: DenyList; ignore?: SearchIgnore } = {},
): Generator<string> {
  const { realRoot, deny, rules } = setup(root, options);
  const target = confine(root, path, { deny });
  if (!existsSync(target.absolute)) throw new ToolError("not_found", { path: target.relative });
  yield* walkFrom(realRoot, target.relative, isFile(target.absolute), rules);
}

/** read_file: the numbered lines of `path`, as `formatReadFile`. */
export function runReadFile(
  root: string,
  path: string,
  options: { startLine?: number; endLine?: number; deny?: DenyList; limits?: Limits } = {},
): string {
  checkLines(options.startLine, options.endLine);
  const target = confine(root, path, { deny: options.deny });
  if (isDirectory(target.absolute)) throw new ToolError("is_directory", { path: target.relative });
  if (!isFile(target.absolute)) throw new ToolError("not_found", { path: target.relative });
  const size = statSync(target.absolute).size;
  const cap = limit("read_max_file_bytes", options.limits);
  if (size > cap) throw new ToolError("too_large", { path: target.relative, size, limit: cap });
  const data = readFileSync(target.absolute);
  if (isBinary(data, options.limits)) throw new ToolError("binary", { path: target.relative });
  return formatReadFile(decodeText(data), target.relative, options);
}

/** list_dir: the entries of `path`, as `formatListDir`. */
export function runListDir(
  root: string,
  path = ".",
  options: { deny?: DenyList; ignore?: SearchIgnore; limits?: Limits } = {},
): string {
  const { realRoot, deny, rules } = setup(root, options);
  const target = confine(root, path, { deny });
  if (isFile(target.absolute)) throw new ToolError("not_directory", { path: target.relative });
  if (!isDirectory(target.absolute)) throw new ToolError("not_found", { path: target.relative });
  const directory = target.relative === "." ? "" : target.relative;
  const listed = entries(realRoot, directory, rules).map(
    (e) => [e.relative.slice(e.relative.lastIndexOf("/") + 1), e.isDir] as const,
  );
  return formatListDir(target.relative, listed, options);
}

function under(relative: string, base: string): string {
  return base ? relative.slice(base.length + 1) : relative;
}

/** glob: the files under `path` that `pattern` matches, as `formatGlob`. */
export function runGlob(
  root: string,
  pattern: string,
  options: { path?: string; deny?: DenyList; ignore?: SearchIgnore; limits?: Limits } = {},
): string {
  if (pattern.trim() === "") throw new ToolError("empty_pattern");
  const { realRoot, deny, rules } = setup(root, options);
  const target = confine(root, options.path ?? ".", { deny });
  if (isFile(target.absolute)) throw new ToolError("not_directory", { path: target.relative });
  if (!isDirectory(target.absolute)) throw new ToolError("not_found", { path: target.relative });
  const base = target.relative === "." ? "" : target.relative;
  const cap = limit("search_max_results", options.limits);
  const found: string[] = [];
  let truncated = false;
  for (const relative of walkFrom(realRoot, target.relative, false, rules)) {
    if (!globMatches(pattern, under(relative, base))) continue;
    if (found.length === cap) {
      truncated = true;
      break;
    }
    found.push(relative);
  }
  return formatGlob(pattern, found, { truncated, limits: options.limits });
}

/** grep: the lines matching `pattern` in the files under `path` (only those `glob` matches, when given), as `formatGrep`. */
export function runGrep(
  root: string,
  pattern: string,
  options: {
    path?: string;
    glob?: string;
    ignoreCase?: boolean;
    deny?: DenyList;
    ignore?: SearchIgnore;
    limits?: Limits;
  } = {},
): string {
  if (pattern === "") throw new ToolError("empty_pattern");
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, options.ignoreCase ? "i" : "");
  } catch (error) {
    throw new ToolError("invalid_regex", { pattern, error: error instanceof Error ? error.message : String(error) });
  }
  const { realRoot, deny, rules } = setup(root, options);
  const target = confine(root, options.path ?? ".", { deny });
  const startIsFile = isFile(target.absolute);
  if (!startIsFile && !isDirectory(target.absolute)) throw new ToolError("not_found", { path: target.relative });
  const base = startIsFile
    ? target.relative.includes("/")
      ? target.relative.slice(0, target.relative.lastIndexOf("/"))
      : ""
    : target.relative === "."
      ? ""
      : target.relative;
  const cap = limit("search_max_results", options.limits);
  const maxFile = limit("grep_max_file_bytes", options.limits);
  const found: [string, number, string][] = [];
  for (const relative of walkFrom(realRoot, target.relative, startIsFile, rules)) {
    if (options.glob && !globMatches(options.glob, under(relative, base))) continue;
    const file = nodePath.join(realRoot, relative);
    let data: Buffer;
    try {
      if (statSync(file).size > maxFile) continue;
      data = readFileSync(file);
    } catch {
      continue;
    }
    if (isBinary(data, options.limits)) continue;
    const lines = textLines(decodeText(data));
    for (let i = 0; i < lines.length; i++) {
      if (!regex.test(lines[i]!)) continue;
      if (found.length === cap) return formatGrep(pattern, found, { truncated: true, limits: options.limits });
      found.push([relative, i + 1, lines[i]!]);
    }
  }
  return formatGrep(pattern, found, { limits: options.limits });
}
