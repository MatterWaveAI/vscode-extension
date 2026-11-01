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
 * yield to the event loop every few milliseconds and stop when their
 * `signal` aborts. `runGrepAsync` reads and matches on worker threads, ended
 * at `timeoutS` of matching or `maxDurationS` in all, so even a pattern that
 * takes exponential time cannot hold the host up.
 */

import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync, type Dirent } from "node:fs";
import * as nodePath from "node:path";
import { Worker } from "node:worker_threads";
import { confine, loadDenyList, relativeTo, resolveLinks, within } from "./confine.js";
import type { DenyList } from "./deny.js";
import { SearchIgnore } from "./ignore.js";
import { OUTPUTS } from "./types.js";
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

/**
 * How an async search ends early: the caller's `signal`, `maxDurationS`, a
 * worker thread that failed, or a pattern past `timeoutS`. The first reason
 * wins, and whatever the search is waiting on through `race` rejects with
 * it at once.
 */
class Stop {
  private reason: { error: unknown } | null = null;
  private waiting: ((error: unknown) => void) | null = null;
  private readonly onAbort: (() => void) | null = null;

  constructor(
    private readonly signal: AbortSignal | undefined,
    why: (signal: AbortSignal) => unknown,
  ) {
    if (!signal) return;
    this.onAbort = () => this.stop(why(signal));
    if (signal.aborted) this.onAbort();
    else signal.addEventListener("abort", this.onAbort, { once: true });
  }

  stop(error: unknown): void {
    if (this.reason) return;
    this.reason = { error };
    this.waiting?.(error);
  }

  /** Throws the reason the search stopped, if it has. */
  check(): void {
    if (this.reason) throw this.reason.error;
  }

  /** `promise`'s outcome, or the reason the search stopped as soon as it does; one wait at a time. */
  race<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.reason) return reject(this.reason.error);
      this.waiting = reject;
      promise.then(
        (value) => {
          this.waiting = null;
          resolve(value);
        },
        (error: unknown) => {
          this.waiting = null;
          reject(error);
        },
      );
    });
  }

  dispose(): void {
    if (this.onAbort) this.signal?.removeEventListener("abort", this.onAbort);
  }
}

/** A number of seconds as the contract's messages print it: whole, or to a tenth. */
function seconds(ms: number): string {
  return String(Math.round(ms / 100) / 10);
}

/**
 * Why a glob or grep stops on its `signal`: the contract's `timeout` when the
 * signal timed out (`AbortSignal.timeout`, the seconds counted from the
 * search's start), the signal's own reason otherwise (an `AbortError` for a
 * plain `abort()`), which a client answers as it answers any stop.
 */
function stoppedSearch(pattern: string, started: number): (signal: AbortSignal) => unknown {
  return (signal) => {
    const reason: unknown = signal.reason;
    const timedOut = typeof reason === "object" && reason !== null && (reason as { name?: unknown }).name === "TimeoutError";
    return timedOut ? new ToolError("timeout", { pattern, timeout_s: seconds(Date.now() - started) }, { cause: reason }) : reason;
  };
}

/**
 * A function to await between steps of a long job: it yields to the event
 * loop once `SLICE_MS` have passed since it last did, and throws once `stop`
 * has stopped.
 */
function pacer(stop?: Stop): () => Promise<void> {
  let last = Date.now();
  return async () => {
    stop?.check();
    if (Date.now() - last < SLICE_MS) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    last = Date.now();
    stop?.check();
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
      if (!entry.isDir) {
        yield entry.relative;
        await pace();
      } else if (!entry.isLink) subdirs.push(entry.relative);
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

/**
 * `walk`, yielding to the event loop every few milliseconds. Aborting
 * `signal` ends the walk at the next path asked for, which throws the
 * signal's reason.
 */
export async function* walkAsync(
  root: string,
  path = ".",
  options: { deny?: DenyList; ignore?: SearchIgnore; signal?: AbortSignal } = {},
): AsyncGenerator<string> {
  const stop = new Stop(options.signal, (signal) => signal.reason);
  try {
    stop.check();
    const { realRoot, deny, rules } = setup(root, options);
    const target = confine(root, path, { deny });
    const kind = targetKind(target.absolute, target.relative);
    yield* walkFromAsync(realRoot, target.relative, kind === "file", rules, pacer(stop));
  } finally {
    stop.dispose();
  }
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

/**
 * `runGlob`, yielding to the event loop every few milliseconds. Aborting
 * `signal` stops the walk and rejects within a few milliseconds: with
 * `ToolError` (`timeout`) when the signal timed out (`AbortSignal.timeout`),
 * with the signal's reason otherwise.
 */
export async function runGlobAsync(
  root: string,
  pattern: string,
  options: GlobOptions & { signal?: AbortSignal } = {},
): Promise<string> {
  const stop = new Stop(options.signal, stoppedSearch(pattern, Date.now()));
  try {
    stop.check();
    const { realRoot, rules, target, base, cap } = prepareGlob(root, pattern, options);
    const found: string[] = [];
    let truncated = false;
    for await (const relative of walkFromAsync(realRoot, target.relative, false, rules, pacer(stop))) {
      if (!globMatches(pattern, under(relative, base))) continue;
      if (found.length === cap) {
        truncated = true;
        break;
      }
      found.push(relative);
    }
    return formatGlob(pattern, found, { truncated, limits: options.limits });
  } finally {
    stop.dispose();
  }
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

/** `runGrepAsync` hands its worker threads the files to search in batches of this many paths. */
const BATCH_FILES = 256;
/** How many worker threads read and match: a file's open is slow on Windows, and two threads halve it there. */
const GREP_THREADS = 2;
/** How many batches may wait on each thread, so it always has the next one. */
const QUEUED_PER_THREAD = 2;

/** A matching line as a worker hands it back: the file's index in its batch, the line number, the text cut to TEXT_BOUND after its trailing whitespace is dropped, and whether there was more. */
type Hit = [file: number, line: number, text: string, more: boolean];

/** Code units that always hold the `line_max_chars` code points `grepLine` keeps, and one more. */
const TEXT_BOUND = 2 * OUTPUTS.grep.line_max_chars + 2;

// A worker's whole program, kept to a string so it runs in any bundle (the
// SDK's own, or a client's that vendors this file); it imports what it needs,
// so it runs as a script or as a module (an eval worker takes the parent's
// --input-type). For each batch of paths it reads the files as runGrep does
// -- no more than the cap + 1 bytes, opened without waiting, skipped when
// unreadable, not a regular file, over the cap or binary; decoded as UTF-8
// and split into lines as textLines splits them -- and hands back the lines
// the regex matches. Their text is cut to `bound` after the trailing
// whitespace grepLine drops, so a huge line is not copied back whole; a cut
// line ends in "." when shown, so grepLine cuts it in the same place.
// `clock` (with a deadline) holds, for this thread, since when it has been
// matching (0 when not) and how long it has matched in all, in milliseconds
// after `base`. The same rules are runGrep's above: change them together.
const WORKER_SOURCE = `
Promise.all([import("node:worker_threads"), import("node:fs"), import("node:path")]).then(([{ parentPort, workerData }, fs, nodePath]) => {
const { root, pattern, flags, maxFile, sniff, bound, chunk: chunkMax, clock: shared, slot, base } = workerData;
const regex = new RegExp(pattern, flags);
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const OPEN = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0);
const clock = shared ? new Int32Array(shared) : null;
const now = () => performance.timeOrigin + performance.now() - base;
const space = (c) => c === 32 || c === 9 || c === 13 || c === 12 || c === 11;
let matched = 0;

function text(relative) {
  try {
    return read(relative);
  } catch {
    return null;
  }
}

function read(relative) {
  const fd = fs.openSync(nodePath.join(root, relative), OPEN);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size > maxFile) return null;
    const chunks = [];
    let size = 0;
    while (size <= maxFile) {
      const chunk = Buffer.allocUnsafe(Math.min(maxFile + 1 - size, chunkMax, Math.max(info.size - size + 1, 8192)));
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (n > 0) {
        chunks.push(chunk.subarray(0, n));
        size += n;
      }
      if (n < chunk.length) break;
    }
    if (size > maxFile) return null;
    const data = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size);
    const end = Math.min(data.length, sniff);
    for (let i = 0; i < end; i++) if (data[i] === 0) return null;
    return decoder.decode(data);
  } finally {
    fs.closeSync(fd);
  }
}

parentPort.on("message", ({ files, limit }) => {
  const hits = [];
  for (let f = 0; f < files.length && hits.length < limit; f++) {
    const content = text(files[f]);
    if (!content) continue;
    const lines = content.split("\\n");
    if (lines[lines.length - 1] === "") lines.pop();
    const started = now();
    if (clock) Atomics.store(clock, slot, Math.max(Math.floor(started), 0) + 1);
    for (let i = 0; i < lines.length && hits.length < limit; i++) {
      let line = lines[i];
      if (line.endsWith("\\r")) line = line.slice(0, -1);
      if (!regex.test(line)) continue;
      let end = line.length;
      while (end > 0 && space(line.charCodeAt(end - 1))) end--;
      hits.push([f, i + 1, line.slice(0, Math.min(end, bound)), end > bound]);
    }
    matched += now() - started;
    if (clock) {
      Atomics.store(clock, slot + 1, Math.floor(matched));
      Atomics.store(clock, slot, 0);
    }
  }
  parentPort.postMessage(hits);
});
});
`;

/** A batch handed to a worker thread, waiting for its matches. */
type Waiting = { resolve: (hits: Hit[]) => void; reject: (error: unknown) => void };

/** The worker threads of one search: each kept for the whole search and handed batches in turn. */
interface GrepThreads {
  /** The matching lines of `files` (relative to the root), no more than `limit` of them, in file and line order. */
  match(files: string[], limit: number): Promise<Hit[]>;
  close(): Promise<void>;
}

/**
 * GREP_THREADS workers, each started when it is first handed a batch.
 * With `timeoutS`, each may spend that long matching, summed over its
 * files: past it every worker is ended, mid-line or not, and the search
 * stops with `timeout`. A worker that fails to start or exits on its own
 * stops the search at once (`timeout`, what happened as the `cause`); none
 * is started again.
 */
function grepThreads(
  setup: { realRoot: string; pattern: string; flags: string; maxFile: number; sniff: number; timeoutS?: number },
  stop: Stop,
  started: number,
): GrepThreads {
  const { realRoot, pattern, flags, maxFile, sniff, timeoutS } = setup;
  const base = performance.timeOrigin + performance.now();
  const clock = timeoutS === undefined ? null : new Int32Array(new SharedArrayBuffer(4 * 2 * GREP_THREADS));
  const threads: { worker: Worker; waiting: Waiting[] }[] = [];
  let handed = 0;
  let ended = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;

  const failed = (cause: unknown) => new ToolError("timeout", { pattern, timeout_s: seconds(Date.now() - started) }, { cause });
  const end = (error: unknown) => {
    if (ended) return;
    ended = true;
    clearTimeout(watchdog);
    for (const thread of threads) {
      void thread.worker.terminate();
      for (const waiting of thread.waiting.splice(0)) waiting.reject(error);
    }
    stop.stop(error);
  };
  // Wakes when the busiest thread could first have used up the budget, and
  // again for what is left of it if that thread was reading meanwhile.
  const watch = () => {
    const budget = timeoutS! * 1000;
    const now = performance.timeOrigin + performance.now() - base;
    let most = 0;
    for (let i = 0; i < threads.length; i++) {
      const since = Atomics.load(clock!, 2 * i);
      most = Math.max(most, Atomics.load(clock!, 2 * i + 1) + (since > 0 ? now - (since - 1) : 0));
    }
    if (most >= budget) end(new ToolError("timeout", { pattern, timeout_s: String(timeoutS) }));
    else watchdog = setTimeout(watch, budget - most);
  };
  const start = (slot: number) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { root: realRoot, pattern, flags, maxFile, sniff, bound: TEXT_BOUND, chunk: CHUNK, clock: clock?.buffer ?? null, slot: 2 * slot, base },
    });
    const thread = { worker, waiting: [] as Waiting[] };
    worker.on("message", (hits: Hit[]) => thread.waiting.shift()?.resolve(hits));
    worker.on("error", (error) => end(failed(error)));
    worker.on("messageerror", (error) => end(failed(error)));
    worker.on("exit", (code) => end(failed(new Error(`grep's worker thread exited with code ${code} before the search finished`))));
    return thread;
  };

  return {
    match(files, limit) {
      return new Promise<Hit[]>((resolve, reject) => {
        if (ended) return reject(new Error("grep's worker threads have ended"));
        const slot = handed++ % GREP_THREADS;
        let thread = threads[slot];
        if (!thread) {
          try {
            thread = threads[slot] = start(slot);
          } catch (error) {
            const failure = failed(error);
            end(failure);
            return reject(failure);
          }
          if (clock && watchdog === undefined) watchdog = setTimeout(watch, timeoutS! * 1000);
        }
        thread.waiting.push({ resolve, reject });
        thread.worker.postMessage({ files, limit });
      });
    },
    async close() {
      ended = true;
      clearTimeout(watchdog);
      await Promise.all(threads.map((thread) => thread.worker.terminate()));
    },
  };
}

type GrepAsyncOptions = GrepOptions & {
  /** The regex's deadline: the most seconds it may spend matching on each of the search's threads, the reads not counted. */
  timeoutS?: number;
  /** The most seconds the whole search may take, walk and reads included. */
  maxDurationS?: number;
  /** Aborting it stops the search. */
  signal?: AbortSignal;
};

/**
 * `runGrep` off the caller's thread, with the same text: files in walk
 * order, lines in order, and the same cut at `search_max_results`. The
 * caller's thread walks the tree, yielding to the event loop every few
 * milliseconds, and hands the paths in batches to two worker threads, which
 * read the files and run the regex; the model's pattern never runs on the
 * caller's thread.
 *
 * `timeoutS` is the regex's deadline: the most seconds it may spend
 * matching on each worker thread, summed over the files that thread
 * matches (the walk and the reads do not count). Past it the workers are
 * ended, whatever line they are on, and the promise rejects with
 * `ToolError` (`timeout`). It is what a pattern that takes exponential time
 * on one line runs into; give it for any pattern a model wrote. A worker
 * that fails to start or exits on its own rejects the search at once, also
 * with `timeout` (what happened is the error's `cause`), and is not started
 * again.
 *
 * `maxDurationS` bounds the whole search, walk and reads included: past it
 * the workers are ended and the promise rejects with `timeout` for that
 * many seconds.
 *
 * Aborting `signal` stops the walk, ends the workers and rejects within a
 * few milliseconds: with `timeout` when the signal timed out
 * (`AbortSignal.timeout`), with the signal's own reason otherwise.
 */
export async function runGrepAsync(root: string, pattern: string, options: GrepAsyncOptions = {}): Promise<string> {
  const started = Date.now();
  const { timeoutS, maxDurationS } = options;
  if (timeoutS !== undefined && !(timeoutS > 0)) throw new RangeError("timeoutS must be more than 0");
  if (maxDurationS !== undefined && !(maxDurationS > 0)) throw new RangeError("maxDurationS must be more than 0");
  const stop = new Stop(options.signal, stoppedSearch(pattern, started));
  const budget =
    maxDurationS === undefined
      ? undefined
      : setTimeout(() => stop.stop(new ToolError("timeout", { pattern, timeout_s: String(maxDurationS) })), maxDurationS * 1000);
  let threads: GrepThreads | undefined;
  try {
    stop.check();
    const { flags, realRoot, rules, target, startIsFile, base, cap, maxFile } = prepareGrep(root, pattern, options);
    const sniff = limit("binary_sniff_bytes", options.limits);
    threads = grepThreads({ realRoot, pattern, flags, maxFile, sniff, timeoutS }, stop, started);
    const found: [string, number, string][] = [];
    let truncated = false;

    // Batches go out in walk order and their matches are taken in the same
    // order, so the text is runGrep's whichever thread finished first.
    const queue: { files: string[]; hits: Promise<Hit[]> }[] = [];
    let batch: string[] = [];
    const send = () => {
      const hits = threads!.match(batch, cap + 1 - found.length);
      // A failure has stopped the search already; this keeps it from going unhandled until it is taken.
      hits.catch(() => {});
      queue.push({ files: batch, hits });
      batch = [];
    };
    const take = async () => {
      const { files, hits } = queue.shift()!;
      for (const [file, line, text, more] of await stop.race(hits)) {
        if (found.length === cap) {
          truncated = true;
          return;
        }
        found.push([files[file]!, line, more ? `${text}.` : text]);
      }
    };

    for await (const relative of walkFromAsync(realRoot, target.relative, startIsFile, rules, pacer(stop))) {
      if (options.glob && !globMatches(options.glob, under(relative, base))) continue;
      batch.push(relative);
      if (batch.length < BATCH_FILES) continue;
      send();
      while (queue.length > GREP_THREADS * QUEUED_PER_THREAD && !truncated) await take();
      if (truncated) break;
    }
    if (!truncated && batch.length > 0) send();
    while (queue.length > 0 && !truncated) await take();
    return formatGrep(pattern, found, { truncated, limits: options.limits });
  } finally {
    clearTimeout(budget);
    stop.dispose();
    await threads?.close();
  }
}
