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
 * directory. Only regular files and directories are walked: a pipe, socket or
 * device (or a link to one) is left out, a tool given one as its `path`
 * answers `special_file`, and no tool ever waits on one. The `path` a search
 * is given is searched even when it is ignored itself.
 *
 * `walk`, `runGlob` and `runGrep` run to the end on the caller's thread.
 * `walkAsync`, `runGlobAsync` and `runGrepAsync` give the same results but
 * yield to the event loop every few milliseconds, and `runGrepAsync` with
 * `timeoutS` runs the model's regex on a worker thread it ends at the
 * deadline, so even a pattern that takes exponential time cannot hold the
 * host up.
 */

import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync, type Dirent } from "node:fs";
import { open as openAsync } from "node:fs/promises";
import * as nodePath from "node:path";
import { Worker } from "node:worker_threads";
import { confine, loadDenyList, relativeTo, resolveLinks, within } from "./confine.js";
import type { DenyList } from "./deny.js";
import { SearchIgnore } from "./ignore.js";
import {
  ToolError,
  checkLines,
  compareCodePoints,
  compileGlob,
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

type Kind = "file" | "dir" | "special";

/** What is at `path`, its links followed: a regular file, a directory, something else (a pipe, a socket, a device), or null for nothing. */
function kindAt(path: string): Kind | null {
  try {
    const info = statSync(path);
    return info.isDirectory() ? "dir" : info.isFile() ? "file" : "special";
  } catch {
    return null;
  }
}

/** A tool's `path` as a file or a directory, or the ToolError for nothing there (`not_found`) or a pipe, socket or device (`special_file`). */
function targetKind(absolute: string, relative: string): "file" | "dir" {
  const kind = kindAt(absolute);
  if (kind === null) throw new ToolError("not_found", { path: relative });
  if (kind === "special") throw new ToolError("special_file", { path: relative });
  return kind;
}

// Non-blocking, so a pipe swapped in after its kind was checked is never
// waited on (Windows has no such flag, nor pipes in the filesystem).
const OPEN_FLAGS = constants.O_RDONLY | ((constants as Partial<Record<string, number>>).O_NONBLOCK ?? 0);
const CHUNK = 1 << 20;

interface Read {
  data: Buffer;
  size: number;
}

function chunkSize(cap: number, size: number, statSize: number): number {
  return Math.min(cap + 1 - size, CHUNK, Math.max(statSize - size + 1, 8192));
}

/**
 * The bytes of the regular file at `path`, no more than `cap` + 1 of them,
 * and its size (at least the bytes read, so a file that grew past `cap` still
 * counts as over it); nothing is read when its size is already over `cap`.
 * Null when it is not a regular file.
 */
function readCapped(path: string, cap: number): Read | null {
  const fd = openSync(path, OPEN_FLAGS);
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) return null;
    if (info.size > cap) return { data: Buffer.alloc(0), size: info.size };
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= cap) {
      const chunk = Buffer.allocUnsafe(chunkSize(cap, size, info.size));
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      chunks.push(chunk.subarray(0, n));
      size += n;
    }
    return { data: Buffer.concat(chunks, size), size: Math.max(info.size, size) };
  } finally {
    closeSync(fd);
  }
}

async function readCappedAsync(path: string, cap: number): Promise<Read | null> {
  const handle = await openAsync(path, OPEN_FLAGS);
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    if (info.size > cap) return { data: Buffer.alloc(0), size: info.size };
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= cap) {
      const chunk = Buffer.allocUnsafe(chunkSize(cap, size, info.size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      size += bytesRead;
    }
    return { data: Buffer.concat(chunks, size), size: Math.max(info.size, size) };
  } finally {
    await handle.close();
  }
}

/**
 * Whether an entry is one the tools may show, and how: null for a link that
 * leads out of the root, dangles, loops or lands on a denied path, and for
 * anything that is neither a regular file nor a directory, a link's target
 * included.
 */
function kindOf(entry: Dirent, absolute: string, realRoot: string, deny: DenyList): { isDir: boolean; isLink: boolean } | null {
  if (entry.isSymbolicLink()) {
    let target: string;
    try {
      target = resolveLinks(absolute);
    } catch {
      return null;
    }
    if (!within(target, realRoot)) return null;
    const kind = kindAt(target);
    if (kind !== "file" && kind !== "dir") return null;
    const isDir = kind === "dir";
    const rel = relativeTo(target, realRoot);
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

const SLICE_MS = 8;

/** A function to await between steps of a long job: it yields to the event loop once `SLICE_MS` have passed since it last did. */
function pacer(): () => Promise<void> {
  let last = Date.now();
  return async () => {
    if (Date.now() - last < SLICE_MS) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    last = Date.now();
  };
}

async function* walkFromAsync(
  realRoot: string,
  start: string,
  startIsFile: boolean,
  rules: SearchIgnore,
  pace: () => Promise<void>,
): AsyncGenerator<string> {
  if (startIsFile) {
    yield start;
    return;
  }
  const stack = [start === "." ? "" : start];
  while (stack.length > 0) {
    await pace();
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
 * and must be a file or a directory (`ToolError`); a file is its own one
 * result.
 */
export function* walk(
  root: string,
  path = ".",
  options: { deny?: DenyList; ignore?: SearchIgnore } = {},
): Generator<string> {
  const { realRoot, deny, rules } = setup(root, options);
  const target = confine(root, path, { deny });
  const kind = targetKind(target.absolute, target.relative);
  yield* walkFrom(realRoot, target.relative, kind === "file", rules);
}

/** `walk`, yielding to the event loop every few milliseconds. */
export async function* walkAsync(
  root: string,
  path = ".",
  options: { deny?: DenyList; ignore?: SearchIgnore } = {},
): AsyncGenerator<string> {
  const { realRoot, deny, rules } = setup(root, options);
  const target = confine(root, path, { deny });
  const kind = targetKind(target.absolute, target.relative);
  yield* walkFromAsync(realRoot, target.relative, kind === "file", rules, pacer());
}

/**
 * read_file: the numbered lines of `path`, as `formatReadFile`. No more than
 * `read_max_file_bytes` + 1 bytes are read, and a pipe or device is never
 * opened to wait on.
 */
export function runReadFile(
  root: string,
  path: string,
  options: { startLine?: number; endLine?: number; deny?: DenyList; limits?: Limits } = {},
): string {
  checkLines(options.startLine, options.endLine);
  const target = confine(root, path, { deny: options.deny });
  if (targetKind(target.absolute, target.relative) === "dir") {
    throw new ToolError("is_directory", { path: target.relative });
  }
  const cap = limit("read_max_file_bytes", options.limits);
  const read = readCapped(target.absolute, cap);
  if (read === null) throw new ToolError("special_file", { path: target.relative });
  if (read.size > cap) throw new ToolError("too_large", { path: target.relative, size: read.size, limit: cap });
  if (isBinary(read.data, options.limits)) throw new ToolError("binary", { path: target.relative });
  return formatReadFile(decodeText(read.data), target.relative, options);
}

/** list_dir: the entries of `path`, as `formatListDir`. */
export function runListDir(
  root: string,
  path = ".",
  options: { deny?: DenyList; ignore?: SearchIgnore; limits?: Limits } = {},
): string {
  const { realRoot, deny, rules } = setup(root, options);
  const target = confine(root, path, { deny });
  if (targetKind(target.absolute, target.relative) === "file") {
    throw new ToolError("not_directory", { path: target.relative });
  }
  const directory = target.relative === "." ? "" : target.relative;
  const listed = entries(realRoot, directory, rules).map(
    (e) => [e.relative.slice(e.relative.lastIndexOf("/") + 1), e.isDir] as const,
  );
  return formatListDir(target.relative, listed, options);
}

function under(relative: string, base: string): string {
  return base ? relative.slice(base.length + 1) : relative;
}

type GlobOptions = { path?: string; deny?: DenyList; ignore?: SearchIgnore; limits?: Limits };

function prepareGlob(root: string, pattern: string, options: GlobOptions) {
  if (pattern.trim() === "") throw new ToolError("empty_pattern");
  compileGlob(pattern);
  const { realRoot, deny, rules } = setup(root, options);
  const target = confine(root, options.path ?? ".", { deny });
  if (targetKind(target.absolute, target.relative) === "file") {
    throw new ToolError("not_directory", { path: target.relative });
  }
  const base = target.relative === "." ? "" : target.relative;
  return { realRoot, rules, target, base, cap: limit("search_max_results", options.limits) };
}

/** glob: the files under `path` that `pattern` matches, as `formatGlob`. */
export function runGlob(root: string, pattern: string, options: GlobOptions = {}): string {
  const { realRoot, rules, target, base, cap } = prepareGlob(root, pattern, options);
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

/** `runGlob`, yielding to the event loop every few milliseconds. */
export async function runGlobAsync(root: string, pattern: string, options: GlobOptions = {}): Promise<string> {
  const { realRoot, rules, target, base, cap } = prepareGlob(root, pattern, options);
  const found: string[] = [];
  let truncated = false;
  for await (const relative of walkFromAsync(realRoot, target.relative, false, rules, pacer())) {
    if (!globMatches(pattern, under(relative, base))) continue;
    if (found.length === cap) {
      truncated = true;
      break;
    }
    found.push(relative);
  }
  return formatGlob(pattern, found, { truncated, limits: options.limits });
}

type GrepOptions = {
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  deny?: DenyList;
  ignore?: SearchIgnore;
  limits?: Limits;
};

function prepareGrep(root: string, pattern: string, options: GrepOptions) {
  if (pattern === "") throw new ToolError("empty_pattern");
  const flags = options.ignoreCase ? "i" : "";
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, flags);
  } catch (error) {
    throw new ToolError("invalid_regex", { pattern, error: error instanceof Error ? error.message : String(error) });
  }
  if (options.glob) compileGlob(options.glob);
  const { realRoot, deny, rules } = setup(root, options);
  const target = confine(root, options.path ?? ".", { deny });
  const startIsFile = targetKind(target.absolute, target.relative) === "file";
  const base = startIsFile
    ? target.relative.includes("/")
      ? target.relative.slice(0, target.relative.lastIndexOf("/"))
      : ""
    : target.relative === "."
      ? ""
      : target.relative;
  return {
    regex,
    flags,
    realRoot,
    rules,
    target,
    startIsFile,
    base,
    cap: limit("search_max_results", options.limits),
    maxFile: limit("grep_max_file_bytes", options.limits),
  };
}

/** grep: the lines matching `pattern` in the files under `path` (only those `glob` matches, when given), as `formatGrep`. */
export function runGrep(root: string, pattern: string, options: GrepOptions = {}): string {
  const { regex, realRoot, rules, target, startIsFile, base, cap, maxFile } = prepareGrep(root, pattern, options);
  const found: [string, number, string][] = [];
  for (const relative of walkFrom(realRoot, target.relative, startIsFile, rules)) {
    if (options.glob && !globMatches(options.glob, under(relative, base))) continue;
    let read: Read | null;
    try {
      read = readCapped(nodePath.join(realRoot, relative), maxFile);
    } catch {
      continue;
    }
    if (read === null || read.size > maxFile || isBinary(read.data, options.limits)) continue;
    const lines = textLines(decodeText(read.data));
    for (let i = 0; i < lines.length; i++) {
      if (!regex.test(lines[i]!)) continue;
      if (found.length === cap) return formatGrep(pattern, found, { truncated: true, limits: options.limits });
      found.push([relative, i + 1, lines[i]!]);
    }
  }
  return formatGrep(pattern, found, { limits: options.limits });
}

/** What runs the model's regex over a file's lines for `runGrepAsync`: the indexes of the lines it matches. */
interface Matcher {
  match(lines: readonly string[]): Promise<number[]>;
  /** Throws the timeout ToolError once the deadline has passed. */
  check(): void;
  close(): Promise<void>;
}

function localMatcher(regex: RegExp, pace: () => Promise<void>): Matcher {
  return {
    async match(lines) {
      const hits: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        if ((i & 1023) === 0) await pace();
        if (regex.test(lines[i]!)) hits.push(i);
      }
      return hits;
    },
    check() {},
    async close() {},
  };
}

// The worker's whole program: the regex, and the indexes of the lines it
// matches for each batch it is sent. Kept to a string so it runs in any
// bundle, the SDK's own or a client's that vendors this file.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const regex = new RegExp(workerData.pattern, workerData.flags);
parentPort.on("message", (lines) => {
  const hits = [];
  for (let i = 0; i < lines.length; i++) if (regex.test(lines[i])) hits.push(i);
  parentPort.postMessage(hits);
});
`;

function workerMatcher(pattern: string, flags: string, timeoutS: number, started: number): Matcher {
  const deadline = started + timeoutS * 1000;
  const timeout = () => new ToolError("timeout", { pattern, timeout_s: String(timeoutS) });
  const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { pattern, flags } });
  let pending: { resolve: (hits: number[]) => void; reject: (error: unknown) => void } | null = null;
  worker.on("message", (hits: number[]) => pending?.resolve(hits));
  worker.on("error", (error) => pending?.reject(error));
  const check = () => {
    if (Date.now() >= deadline) throw timeout();
  };
  return {
    check,
    match(lines) {
      check();
      return new Promise<number[]>((resolve, reject) => {
        const timer = setTimeout(() => reject(timeout()), Math.max(deadline - Date.now(), 0));
        pending = {
          resolve: (hits) => {
            clearTimeout(timer);
            pending = null;
            resolve(hits);
          },
          reject: (error) => {
            clearTimeout(timer);
            pending = null;
            reject(error);
          },
        };
        worker.postMessage(lines);
      });
    },
    async close() {
      await worker.terminate();
    },
  };
}

/**
 * `runGrep`, yielding to the event loop every few milliseconds. With
 * `timeoutS`, the regex runs on a worker thread and the whole search has
 * that many seconds: past them the worker is ended, whatever line it is on,
 * and the promise rejects with `ToolError` (`timeout`).
 */
export async function runGrepAsync(
  root: string,
  pattern: string,
  options: GrepOptions & { timeoutS?: number } = {},
): Promise<string> {
  const started = Date.now();
  const { timeoutS } = options;
  if (timeoutS !== undefined && !(timeoutS > 0)) throw new RangeError("timeoutS must be more than 0");
  const { regex, flags, realRoot, rules, target, startIsFile, base, cap, maxFile } = prepareGrep(root, pattern, options);
  const pace = pacer();
  const matcher = timeoutS === undefined ? localMatcher(regex, pace) : workerMatcher(pattern, flags, timeoutS, started);
  try {
    const found: [string, number, string][] = [];
    for await (const relative of walkFromAsync(realRoot, target.relative, startIsFile, rules, pace)) {
      matcher.check();
      if (options.glob && !globMatches(options.glob, under(relative, base))) continue;
      let read: Read | null;
      try {
        read = await readCappedAsync(nodePath.join(realRoot, relative), maxFile);
      } catch {
        continue;
      }
      if (read === null || read.size > maxFile || isBinary(read.data, options.limits)) continue;
      const lines = textLines(decodeText(read.data));
      for (const i of await matcher.match(lines)) {
        if (found.length === cap) return formatGrep(pattern, found, { truncated: true, limits: options.limits });
        found.push([relative, i + 1, lines[i]!]);
      }
    }
    return formatGrep(pattern, found, { limits: options.limits });
  } finally {
    await matcher.close();
  }
}
