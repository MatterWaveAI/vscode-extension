import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import * as nodePath from "node:path";
import { PROTECTED_LIST, PathRefusedError } from "../lib/sdk/agent/deny";
import { EditError, applyEdit } from "../lib/sdk/agent/edit";
import { unifiedDiff } from "../lib/sdk/agent/diff";
import { allowed } from "../lib/sdk/agent/modes";
import { confine, loadDenyList } from "../lib/sdk/agent/confine";
import { LIMITS, TOOL_NAMES, type ModeName } from "../lib/sdk/agent/types";
import type { DenyList } from "../lib/sdk/agent/deny";
import { IgnoreRules, globMatcher } from "./ignore";
import { runShell as spawnShell, type ShellOptions, type ShellResult } from "./shell";
import {
  failure,
  intArg,
  isOutcome,
  ok,
  stringArg,
  type ToolContext,
  type ToolOutcome,
  type ToolSpec,
} from "./tools";

/**
 * The seven contract tools, run in the extension host against the
 * workspace root: `read_file`, `list_dir`, `glob`, `grep`, `edit`,
 * `write_file` and `run_shell`.
 *
 * Every path goes through the SDK's `confine` before anything is read or
 * written (`..`, an absolute path outside the root, a link out of it, the
 * deny list, protected paths for a write). Searches also skip what
 * `.gitignore` ignores. A write never touches the disk here: the change goes
 * to `approvals.change`, which shows the diff, waits for the person in `ask`
 * mode, and applies it through the editor. A command runs as a child process
 * in the root, with the contract's timeout and output cap.
 */

export interface HostOptions {
  /**
   * The text of a file as the editor holds it (an open, unsaved document),
   * or null to read the disk. The model then sees what the person sees, and
   * an edit is diffed against it.
   */
  readText?: (absolute: string) => Promise<string | null>;
  /** The command runner; the real one spawns a process, a test can stand in. */
  runShell?: (command: string, options: ShellOptions) => Promise<ShellResult>;
}

/** Past this a file is not read at all: a line range deep in it is not worth the memory. */
const MAX_FILE_BYTES = 16 * 1024 * 1024;
/** grep skips files larger than this, and stops walking after this many files. */
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024;
const MAX_WALKED = 100_000;
const MAX_MATCH_LINE_CHARS = 400;

const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

function isBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 8000);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true;
  return false;
}

function refused(error: unknown): ToolOutcome {
  if (error instanceof PathRefusedError) return failure(error.message);
  throw error;
}

async function kindOf(path: string): Promise<"file" | "dir" | null> {
  try {
    const info = await stat(path);
    return info.isDirectory() ? "dir" : info.isFile() ? "file" : null;
  } catch {
    return null;
  }
}

/** A file's text (the editor's copy when it has one), or the sentence to return when it is not text. */
async function readText(absolute: string, relative: string, options: HostOptions): Promise<string | ToolOutcome> {
  const open = await options.readText?.(absolute);
  if (typeof open === "string") return open;
  const info = await stat(absolute);
  if (info.size > MAX_FILE_BYTES) {
    return failure(`${relative} is ${info.size.toLocaleString("en-US")} bytes, too large to read.`);
  }
  const bytes = await readFile(absolute);
  if (isBinary(bytes)) return failure(`${relative} is a binary file; only text files are read.`);
  return decoder.decode(bytes);
}

/** The `.gitignore` rules in force at `dirRelative`: the root's and every directory's on the way down. */
async function rulesAt(root: string, dirRelative: string): Promise<IgnoreRules> {
  let rules = IgnoreRules.empty();
  const segments = dirRelative === "." || dirRelative === "" ? [] : dirRelative.split("/");
  for (let depth = 0; depth <= segments.length; depth++) {
    const base = segments.slice(0, depth).join("/");
    rules = await withGitignore(rules, nodePath.join(root, ...segments.slice(0, depth)), base);
  }
  return rules;
}

async function withGitignore(rules: IgnoreRules, dir: string, base: string): Promise<IgnoreRules> {
  try {
    return rules.with(await readFile(nodePath.join(dir, ".gitignore"), "utf8"), base);
  } catch {
    return rules;
  }
}

function join(base: string, name: string): string {
  return base === "" || base === "." ? name : `${base}/${name}`;
}

/** What a directory entry is, following a link only when it stays inside the root. */
async function entryKind(root: string, relative: string, entry: Dirent, deny: DenyList): Promise<"file" | "dir" | null> {
  if (entry.isDirectory()) return "dir";
  if (entry.isFile()) return "file";
  if (!entry.isSymbolicLink()) return null;
  try {
    const target = confine(root, relative, { deny });
    // A linked file inside the root is searched; a linked directory is not
    // walked into, so a link loop cannot trap a search.
    return (await kindOf(target.absolute)) === "file" ? "file" : null;
  } catch {
    return null;
  }
}

interface WalkOptions {
  root: string;
  start: string;
  deny: DenyList;
  signal: AbortSignal;
  visit: (relative: string, absolute: string) => Promise<boolean> | boolean;
}

/**
 * Every file under `start` that is neither denied nor ignored, depth first in
 * name order; `visit` returns false to stop. Linked directories are not
 * entered, so everything walked is physically under the root.
 */
async function walk(options: WalkOptions): Promise<{ visited: number; complete: boolean }> {
  const { root, deny, signal, visit } = options;
  let visited = 0;
  const stack: { relative: string; rules: IgnoreRules }[] = [
    { relative: options.start, rules: await rulesAt(root, options.start) },
  ];
  while (stack.length > 0) {
    if (signal.aborted) return { visited, complete: false };
    const { relative, rules } = stack.pop()!;
    const absolute = relative === "." || relative === "" ? root : nodePath.join(root, ...relative.split("/"));
    let entries: Dirent[];
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    const here = relative === "." || relative === "" ? rules : await withGitignore(rules, absolute, relative);
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const dirs: string[] = [];
    for (const entry of entries) {
      const rel = join(relative === "." ? "" : relative, entry.name);
      const kind = await entryKind(root, rel, entry, deny);
      if (kind === null) continue;
      const isDir = kind === "dir";
      if (deny.matches(rel, { isDir }) || here.ignored(rel, isDir)) continue;
      if (isDir) {
        dirs.push(rel);
        continue;
      }
      visited += 1;
      if (visited > MAX_WALKED) return { visited, complete: false };
      if (!(await visit(rel, nodePath.join(root, ...rel.split("/"))))) return { visited, complete: false };
    }
    for (const dir of dirs.reverse()) stack.push({ relative: dir, rules: here });
  }
  return { visited, complete: true };
}

// --- the tools ------------------------------------------------------------------

async function readFileTool(args: Record<string, unknown>, ctx: ToolContext, options: HostOptions): Promise<ToolOutcome> {
  const path = stringArg(args, "path");
  if (isOutcome(path)) return path;
  const start = intArg(args, "start_line");
  if (isOutcome(start)) return start;
  const end = intArg(args, "end_line");
  if (isOutcome(end)) return end;
  let target;
  try {
    target = confine(ctx.root, path!);
  } catch (error) {
    return refused(error);
  }
  const kind = await kindOf(target.absolute);
  if (kind === null) return failure(`${path} does not exist.`);
  if (kind === "dir") return failure(`${path} is a directory; use list_dir to see what is in it.`);
  const text = await readText(target.absolute, target.relative, options);
  if (isOutcome(text)) return text;
  if (text === "") return ok(`(${target.relative} is empty)`);
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const first = Math.max(1, start ?? 1);
  if (first > lines.length) return failure(`${target.relative} has ${lines.length} lines; start_line ${first} is past its end.`);
  const last = Math.min(lines.length, end ?? lines.length, first + LIMITS.read_max_lines - 1);
  const out: string[] = [];
  let bytes = 0;
  let shown = first - 1;
  for (let n = first; n <= last; n++) {
    const line = `${n}\t${lines[n - 1]}`;
    bytes += Buffer.byteLength(line) + 1;
    if (bytes > LIMITS.read_max_bytes && out.length > 0) break;
    out.push(line);
    shown = n;
  }
  const wanted = Math.min(lines.length, end ?? lines.length);
  if (shown < wanted) {
    out.push(`[cut at line ${shown} of ${lines.length}: the read limit; pass start_line=${shown + 1} to read on]`);
  }
  return ok(out.join("\n"));
}

async function listDirTool(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const path = stringArg(args, "path", false);
  if (isOutcome(path)) return path;
  let target;
  try {
    target = confine(ctx.root, path || ".");
  } catch (error) {
    return refused(error);
  }
  if ((await kindOf(target.absolute)) !== "dir") return failure(`${path || "."} is not a directory.`);
  const deny = loadDenyList(ctx.root);
  const rules = await rulesAt(ctx.root, target.relative);
  const entries = await readdir(target.absolute, { withFileTypes: true });
  const dirs: string[] = [];
  const files: string[] = [];
  for (const entry of entries) {
    const rel = join(target.relative === "." ? "" : target.relative, entry.name);
    let isDir = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try {
        isDir = (await kindOf(confine(ctx.root, rel, { deny }).absolute)) === "dir";
      } catch {
        continue;
      }
    }
    if (deny.matches(rel, { isDir }) || PROTECTED_LIST.matches(rel, { isDir }) || rules.ignored(rel, isDir)) continue;
    (isDir ? dirs : files).push(isDir ? `${entry.name}/` : entry.name);
  }
  const sorted = [...dirs.sort(), ...files.sort()];
  if (sorted.length === 0) return ok(`(${target.relative} is empty)`);
  const shown = sorted.slice(0, LIMITS.list_max_entries);
  if (sorted.length > shown.length) shown.push(`[${sorted.length - shown.length} more entries not shown]`);
  return ok(shown.join("\n"));
}

async function searchBase(ctx: ToolContext, path: string | undefined): Promise<{ relative: string } | ToolOutcome> {
  let target;
  try {
    target = confine(ctx.root, path || ".");
  } catch (error) {
    return refused(error);
  }
  const kind = await kindOf(target.absolute);
  if (kind === null) return failure(`${path} does not exist.`);
  return { relative: target.relative };
}

async function globTool(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const pattern = stringArg(args, "pattern");
  if (isOutcome(pattern)) return pattern;
  const path = stringArg(args, "path", false);
  if (isOutcome(path)) return path;
  const base = await searchBase(ctx, path);
  if (isOutcome(base)) return base;
  const matches = globMatcher(pattern!);
  const prefix = base.relative === "." ? "" : `${base.relative}/`;
  const found: string[] = [];
  let more = false;
  await walk({
    root: ctx.root,
    start: base.relative,
    deny: loadDenyList(ctx.root),
    signal: ctx.signal,
    visit: (relative) => {
      if (!matches(relative.slice(prefix.length))) return true;
      if (found.length >= LIMITS.search_max_results) {
        more = true;
        return false;
      }
      found.push(relative);
      return true;
    },
  });
  if (found.length === 0) return ok(`No files match ${pattern}.`);
  if (more) found.push(`[stopped at ${LIMITS.search_max_results} results; narrow the pattern or the path]`);
  return ok(found.join("\n"));
}

async function grepTool(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const pattern = stringArg(args, "pattern");
  if (isOutcome(pattern)) return pattern;
  const path = stringArg(args, "path", false);
  if (isOutcome(path)) return path;
  const glob = stringArg(args, "glob", false);
  if (isOutcome(glob)) return glob;
  const ignoreCase = args.ignore_case === true;
  let regex: RegExp;
  try {
    regex = new RegExp(pattern!, ignoreCase ? "i" : "");
  } catch (error) {
    return failure(`The pattern is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`);
  }
  const deny = loadDenyList(ctx.root);
  let target;
  try {
    target = confine(ctx.root, path || ".", { deny });
  } catch (error) {
    return refused(error);
  }
  const kind = await kindOf(target.absolute);
  if (kind === null) return failure(`${path} does not exist.`);
  const filter = glob ? globMatcher(glob) : null;
  const prefix = kind === "dir" && target.relative !== "." ? `${target.relative}/` : "";
  const found: string[] = [];
  let more = false;
  const search = async (relative: string, absolute: string): Promise<boolean> => {
    if (filter && !filter(relative.slice(prefix.length))) return true;
    let bytes: Buffer;
    try {
      const info = await stat(absolute);
      if (info.size > MAX_GREP_FILE_BYTES) return true;
      bytes = await readFile(absolute);
    } catch {
      return true;
    }
    if (isBinary(bytes)) return true;
    const lines = decoder.decode(bytes).split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.replace(/\r$/, "");
      if (!regex.test(line)) continue;
      if (found.length >= LIMITS.search_max_results) {
        more = true;
        return false;
      }
      const text = line.length > MAX_MATCH_LINE_CHARS ? `${line.slice(0, MAX_MATCH_LINE_CHARS)}…` : line;
      found.push(`${relative}:${i + 1}: ${text}`);
    }
    return true;
  };
  if (kind === "file") {
    await search(target.relative, target.absolute);
  } else {
    await walk({ root: ctx.root, start: target.relative, deny, signal: ctx.signal, visit: search });
  }
  if (found.length === 0) return ok(`No matches for ${pattern}.`);
  if (more) found.push(`[stopped at ${LIMITS.search_max_results} matches; narrow the pattern, the path or the glob]`);
  return ok(found.join("\n"));
}

function changeResult(
  relative: string,
  verb: string,
  outcome: Awaited<ReturnType<ToolContext["approvals"]["change"]>>,
  before: string | null,
  proposed: string,
): ToolOutcome {
  if (outcome.status === "rejected") {
    const said = outcome.reason ? ` They said: ${outcome.reason}` : "";
    return { content: `The person rejected the change to ${relative}; the file is unchanged.${said}`, isError: false, rejected: true };
  }
  // The view shows what landed, as a diff; the model is told in words.
  const display = unifiedDiff(before ?? "", outcome.content, relative) || `${verb} ${relative}.`;
  if (!outcome.edited) return { ...ok(`${verb} ${relative}.`), display };
  const theirs = unifiedDiff(proposed, outcome.content, relative);
  return {
    ...ok(
      `${verb} ${relative}, with the person's own changes: they edited your proposal before accepting it. ` +
        `The file now holds their version, which differs from yours by:\n${theirs}`,
    ),
    display,
  };
}

async function editTool(args: Record<string, unknown>, decision: "allow" | "ask", ctx: ToolContext, options: HostOptions): Promise<ToolOutcome> {
  const path = stringArg(args, "path");
  if (isOutcome(path)) return path;
  const oldString = stringArg(args, "old_string");
  if (isOutcome(oldString)) return oldString;
  const newString = stringArg(args, "new_string");
  if (isOutcome(newString)) return newString;
  let target;
  try {
    target = confine(ctx.root, path!, { write: true });
  } catch (error) {
    return refused(error);
  }
  const kind = await kindOf(target.absolute);
  if (kind === null) return failure(new EditError("missing", target.relative).message);
  if (kind === "dir") return failure(`${target.relative} is a directory, not a file.`);
  const before = await readText(target.absolute, target.relative, options);
  if (isOutcome(before)) return before;
  let after: string;
  try {
    after = applyEdit(before, oldString!, newString!, { path: target.relative });
  } catch (error) {
    if (error instanceof EditError) return failure(error.message);
    throw error;
  }
  const outcome = await ctx.approvals.change(
    { tool: "edit", relative: target.relative, absolute: target.absolute, before, after, diff: unifiedDiff(before, after, target.relative) },
    decision === "ask",
    ctx.signal,
  );
  return changeResult(target.relative, "Edited", outcome, before, after);
}

async function writeFileTool(args: Record<string, unknown>, decision: "allow" | "ask", ctx: ToolContext, options: HostOptions): Promise<ToolOutcome> {
  const path = stringArg(args, "path");
  if (isOutcome(path)) return path;
  const content = stringArg(args, "content");
  if (isOutcome(content)) return content;
  let target;
  try {
    target = confine(ctx.root, path!, { write: true });
  } catch (error) {
    return refused(error);
  }
  const kind = await kindOf(target.absolute);
  if (kind === "dir") return failure(`${target.relative} is a directory, not a file.`);
  let before: string | null = null;
  if (kind === "file") {
    const text = await readText(target.absolute, target.relative, options);
    if (isOutcome(text)) return text;
    before = text;
  }
  if (before === content) return ok(`${target.relative} already has exactly this content; nothing was written.`);
  const outcome = await ctx.approvals.change(
    {
      tool: "write_file",
      relative: target.relative,
      absolute: target.absolute,
      before,
      after: content!,
      diff: unifiedDiff(before ?? "", content!, target.relative),
    },
    decision === "ask",
    ctx.signal,
  );
  return changeResult(target.relative, before === null ? "Created" : "Wrote", outcome, before, content!);
}

async function runShellTool(args: Record<string, unknown>, decision: "allow" | "ask", ctx: ToolContext, options: HostOptions): Promise<ToolOutcome> {
  const command = stringArg(args, "command");
  if (isOutcome(command)) return command;
  if (!command!.trim()) return failure("The command is empty.");
  const timeout = intArg(args, "timeout_s");
  if (isOutcome(timeout)) return timeout;
  const timeoutS = Math.min(Math.max(1, timeout ?? LIMITS.shell_timeout_s_default), LIMITS.shell_timeout_s_max);
  if (decision === "ask") {
    const answer = await ctx.approvals.confirm(
      { kind: "shell", tool: "run_shell", title: `Run a command in ${ctx.root} (time limit ${timeoutS}s)`, detail: command! },
      ctx.signal,
    );
    if (!answer.approved) {
      const said = answer.reason ? ` They said: ${answer.reason}` : "";
      return { content: `The person rejected the command; it did not run.${said}`, isError: false, rejected: true };
    }
  }
  const run = options.runShell ?? spawnShell;
  const result = await run(command!, {
    cwd: ctx.root,
    timeoutMs: timeoutS * 1000,
    maxBytes: LIMITS.shell_output_max_bytes,
    signal: ctx.signal,
    onOutput: ctx.onOutput,
  });
  const output = result.output.trimEnd() || "(no output)";
  if (result.stopped) return failure(`The person stopped the command.\n${output}`);
  if (result.timedOut) return failure(`The command was stopped after ${timeoutS}s, its time limit.\n${output}`);
  return { content: `Exit code ${result.exitCode}\n${output}`, isError: result.exitCode !== 0 };
}

function contractDecision(name: string): (mode: ModeName) => "allow" | "ask" | "deny" {
  return (mode) => allowed(name, mode);
}

/**
 * The contract's seven tools as `ToolSpec`s. Their `/v1` definitions are the
 * SDK's (`toolsForMode`), and so is every decision (`allowed`).
 */
export function contractTools(options: HostOptions = {}): ToolSpec[] {
  const spec = (
    name: string,
    run: (args: Record<string, unknown>, decision: "allow" | "ask", ctx: ToolContext) => Promise<ToolOutcome>,
    label: (args: Record<string, unknown>) => string,
  ): ToolSpec => ({
    name,
    // Offered through `toolsForMode`; see `offeredTools` in loop.ts.
    definition: { type: "function", function: { name } },
    decide: contractDecision(name),
    run: (args, decision, ctx) => (decision === "deny" ? Promise.resolve(failure(`${name} is not available in ${ctx.mode} mode.`)) : run(args, decision, ctx)),
    label,
  });
  const str = (value: unknown) => (typeof value === "string" ? value : "");
  return [
    spec("read_file", (a, _d, c) => readFileTool(a, c, options), (a) => str(a.path)),
    spec("list_dir", (a, _d, c) => listDirTool(a, c), (a) => str(a.path) || "."),
    spec("glob", (a, _d, c) => globTool(a, c), (a) => str(a.pattern)),
    spec("grep", (a, _d, c) => grepTool(a, c), (a) => `${str(a.pattern)}${a.path ? ` in ${str(a.path)}` : ""}`),
    spec("edit", (a, d, c) => editTool(a, d, c, options), (a) => str(a.path)),
    spec("write_file", (a, d, c) => writeFileTool(a, d, c, options), (a) => str(a.path)),
    spec("run_shell", (a, d, c) => runShellTool(a, d, c, options), (a) => str(a.command)),
  ];
}

export const CONTRACT_TOOL_NAMES: ReadonlySet<string> = new Set(TOOL_NAMES);
