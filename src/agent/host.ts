import { stat } from "node:fs/promises";
import * as nodePath from "node:path";
import {
  DenyList,
  EditError,
  PathRefusedError,
  TOOLS_BY_NAME,
  ToolError,
  allowed,
  applyEdit,
  confine,
  formatReadFile,
  formatShell,
  isAbsolute,
  isBinary,
  limit,
  refusal,
  runGlobAsync,
  runGrepAsync,
  runListDir,
  runReadFile,
  unifiedDiff,
  type Limits,
  type ToolName,
} from "../lib/sdk/agent/node";
import { readBytes } from "./readConfined";
import { runShell as spawnShell, type ShellOptions, type ShellResult } from "./shell";
import { failure, intArg, isOutcome, ok, rejectedOutcome, stringArg, toolSpec, type ToolContext, type ToolOutcome, type ToolSpec } from "./tools";

/**
 * The seven contract tools, run in the extension host against the
 * workspace root: `read_file`, `list_dir`, `glob`, `grep`, `edit`,
 * `write_file` and `run_shell`.
 *
 * What they return is the SDK's: `runReadFile` and `runListDir`, and
 * `runGlobAsync` and `runGrepAsync` for the searches, which walk with the
 * .gitignore and .matterwaveignore rules, let the editor breathe as they go
 * and stop on the run's Stop signal; grep reads and matches on the SDK's
 * worker threads, ended at GREP_TIMEOUT_S of matching or GREP_MAX_DURATION_S
 * in all. Every path goes through the SDK's `confine` before anything is
 * read or written. A write never touches the disk here: the change goes to
 * `approvals.change`, which shows the diff, waits for the person when it
 * asks, and applies it through the editor after `stale()` confirms that the
 * path still leads where it did and the file still holds what the diff was
 * made from. A command runs as a child process in the root (shell.ts), its
 * text the SDK's `formatShell`.
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
  /** Overrides for the contract's limits, by name (the conformance cases set some). */
  limits?: Limits;
  /** grep's regex deadline in seconds; GREP_TIMEOUT_S by default. */
  grepTimeoutS?: number;
  /** The most a whole grep may take, in seconds; GREP_MAX_DURATION_S by default. */
  grepMaxDurationS?: number;
}

/**
 * grep's regex deadline, in seconds: the most the model's pattern may spend
 * matching on each of the SDK's worker threads (the walk and the reads do
 * not count). Past it the workers are ended and grep returns the contract's
 * `timeout`, which tells the model to narrow the pattern. A pattern can take
 * exponential time on one line (`(a+)+$` on a line of `a`s, perhaps copied
 * from a file that asked for it); an ordinary one spends about a second on
 * the 4.6 million lines of a 100,000-file workspace.
 */
export const GREP_TIMEOUT_S = 30;

/**
 * The most a whole grep may take, walk and reads included, in seconds: also
 * the contract's `timeout`. A full search of a 100,000-file workspace takes
 * 15-20 s on Windows (where every open is scanned) and 3-6 s on Linux; this
 * leaves a slow disk or a cold cache room to finish.
 */
export const GREP_MAX_DURATION_S = 120;

/** A leading byte-order mark is dropped, as the editor drops it: an edit must not write it back as text. */
const decoder = new TextDecoder("utf-8");

/**
 * What steers the editor rather than holds the project's code, on top of the
 * contract's protected paths (`.matterwave/`, the context files, the deny
 * file, the home folder's shell and credential files): VS Code's workspace
 * settings (MCP servers, tasks, the executables other extensions run) and
 * workspace files. A write to one asks in every mode, yolo included, as a
 * write to a protected path does, so text the agent read cannot turn itself
 * into a process the editor starts.
 */
export const EDITOR_CONFIG = new DenyList([".vscode/", "*.code-workspace"]);

/** The contract's sentence for a refused path or a tool that cannot answer, as the tool's error result. */
function failed(error: unknown): ToolOutcome {
  if (error instanceof PathRefusedError || error instanceof ToolError || error instanceof EditError) return failure(error.message);
  throw error;
}

/** For comparing what the diff was made from with the file now: the editor and the disk differ in a BOM and line endings, not content. */
function comparable(text: string): string {
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n/g, "\n");
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? nodePath.normalize(p).toLowerCase() : nodePath.normalize(p));
  return norm(a) === norm(b);
}

/** What is at `path`, its links followed: a regular file, a folder, something else (a pipe, a socket, a device), or null for nothing. */
async function kindOf(path: string): Promise<"file" | "dir" | "special" | null> {
  try {
    const info = await stat(path);
    return info.isDirectory() ? "dir" : info.isFile() ? "file" : "special";
  } catch {
    return null;
  }
}

/**
 * A file's text for a change (the editor's copy when it has one); `ToolError`
 * when it is too large, not text, or not a regular file. No more than
 * `read_max_file_bytes` + 1 bytes are read, and a pipe is never waited on.
 */
async function readForChange(absolute: string, relative: string, options: HostOptions): Promise<string> {
  const open = await options.readText?.(absolute);
  if (typeof open === "string") return open;
  const cap = limit("read_max_file_bytes", options.limits);
  const read = await readBytes(absolute, cap + 1);
  if (read === null) throw new ToolError("special_file", { path: relative });
  if (read.size > cap) throw new ToolError("too_large", { path: relative, size: read.size, limit: cap });
  if (isBinary(read.bytes, options.limits)) throw new ToolError("binary", { path: relative });
  return decoder.decode(read.bytes);
}

/** Where a write leads, and whether it asks the person whatever the mode says. */
interface WriteTarget {
  absolute: string;
  relative: string;
  /** A path the contract protects or the editor's configuration, by its own name or where its links lead. */
  guarded: boolean;
}

/**
 * Where a write to `path` leads. A protected path is one `confine` refuses
 * until the write is approved; it is resolved as approved here because the
 * change will be put to the person before anything is written.
 */
function writeTarget(root: string, path: string): WriteTarget {
  let target;
  let guarded = false;
  try {
    target = confine(root, path, { write: true });
  } catch (error) {
    if (!(error instanceof PathRefusedError) || error.reason !== "protected") throw error;
    target = confine(root, path, { write: true, approved: true });
    guarded = true;
  }
  const given = isAbsolute(path) ? nodePath.relative(root, path) : path;
  guarded ||= EDITOR_CONFIG.matches(given) || EDITOR_CONFIG.matches(target.relative);
  return { ...target, guarded };
}

/**
 * What would make applying a change proposed earlier wrong now, or null: the
 * path refused or leading elsewhere (a folder swapped for a link meanwhile),
 * or the file not what the diff was made from (the person, a formatter or a
 * command changed it while the change waited). Writing anyway would clobber
 * that change or follow the new link.
 */
function staleCheck(root: string, target: WriteTarget, before: string | null, options: HostOptions): () => Promise<string | null> {
  const { relative, absolute } = target;
  return async () => {
    let now;
    try {
      now = confine(root, relative, { write: true, approved: target.guarded });
    } catch (error) {
      return error instanceof PathRefusedError ? error.message : `${relative} can no longer be checked.`;
    }
    if (!samePath(now.absolute, absolute)) return `${relative} now leads somewhere else: a folder or link on its path changed while the change waited.`;
    const kind = await kindOf(absolute);
    if (before === null) return kind === null ? null : `${relative} was created by something else while the change waited.`;
    if (kind === "special") return new ToolError("special_file", { path: relative }).message;
    if (kind !== "file") return `${relative} was removed while the change waited.`;
    let current: string;
    try {
      current = await readForChange(absolute, relative, options);
    } catch (error) {
      if (error instanceof ToolError) return error.message;
      throw error;
    }
    return comparable(current) === comparable(before) ? null : `${relative} changed while the change waited.`;
  };
}

// --- the tools ------------------------------------------------------------------

async function readFileTool(args: Record<string, unknown>, ctx: ToolContext, options: HostOptions): Promise<ToolOutcome> {
  const path = stringArg(args, "path");
  if (isOutcome(path)) return path;
  const start = intArg(args, "start_line");
  if (isOutcome(start)) return start;
  const end = intArg(args, "end_line");
  if (isOutcome(end)) return end;
  const lines = { startLine: start, endLine: end, limits: options.limits };
  try {
    if (options.readText) {
      // The editor's copy of an open file, numbered as the disk's would be.
      const target = confine(ctx.root, path!);
      const open = await options.readText(target.absolute);
      if (typeof open === "string") return ok(formatReadFile(open, target.relative, lines));
    }
    return ok(runReadFile(ctx.root, path!, lines));
  } catch (error) {
    return failed(error);
  }
}

async function listDirTool(args: Record<string, unknown>, ctx: ToolContext, options: HostOptions): Promise<ToolOutcome> {
  const path = stringArg(args, "path", false);
  if (isOutcome(path)) return path;
  try {
    return ok(runListDir(ctx.root, path || ".", { limits: options.limits }));
  } catch (error) {
    return failed(error);
  }
}

async function globTool(args: Record<string, unknown>, ctx: ToolContext, options: HostOptions): Promise<ToolOutcome> {
  const pattern = stringArg(args, "pattern");
  if (isOutcome(pattern)) return pattern;
  const path = stringArg(args, "path", false);
  if (isOutcome(path)) return path;
  try {
    // Stop ends the walk at once and rejects with an AbortError, which the loop answers as stopped.
    return ok(await runGlobAsync(ctx.root, pattern!, { path: path || undefined, limits: options.limits, signal: ctx.signal }));
  } catch (error) {
    return failed(error);
  }
}

async function grepTool(args: Record<string, unknown>, ctx: ToolContext, options: HostOptions): Promise<ToolOutcome> {
  const pattern = stringArg(args, "pattern");
  if (isOutcome(pattern)) return pattern;
  const path = stringArg(args, "path", false);
  if (isOutcome(path)) return path;
  const glob = stringArg(args, "glob", false);
  if (isOutcome(glob)) return glob;
  try {
    // Stop ends the walk and the workers at once and rejects with an AbortError, which the loop answers as stopped.
    const search = runGrepAsync(ctx.root, pattern!, {
      path: path || undefined,
      glob: glob || undefined,
      ignoreCase: args.ignore_case === true,
      limits: options.limits,
      timeoutS: options.grepTimeoutS ?? GREP_TIMEOUT_S,
      maxDurationS: options.grepMaxDurationS ?? GREP_MAX_DURATION_S,
      signal: ctx.signal,
    });
    return ok(await search);
  } catch (error) {
    return failed(error);
  }
}

function changeResult(
  tool: string,
  relative: string,
  verb: string,
  outcome: Awaited<ReturnType<ToolContext["approvals"]["change"]>>,
  before: string | null,
  proposed: string,
): ToolOutcome {
  if (outcome.status === "failed") {
    return failure(`${relative} was not changed: ${outcome.reason} Read it again before proposing the change anew.`);
  }
  if (outcome.status === "rejected") return rejectedOutcome(tool, outcome.reason);
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

/**
 * Whether a write asks: the mode's answer for this path (`allowed` with the
 * path asks for a protected one), and a guarded path asks whatever the mode.
 */
function asks(tool: string, decision: "allow" | "ask", ctx: ToolContext, target: WriteTarget): boolean {
  return decision === "ask" || target.guarded || allowed(tool, ctx.mode, null, { path: target.relative }) !== "allow";
}

async function editTool(args: Record<string, unknown>, decision: "allow" | "ask", ctx: ToolContext, options: HostOptions): Promise<ToolOutcome> {
  const path = stringArg(args, "path");
  if (isOutcome(path)) return path;
  const oldString = stringArg(args, "old_string");
  if (isOutcome(oldString)) return oldString;
  const newString = stringArg(args, "new_string");
  if (isOutcome(newString)) return newString;
  try {
    const target = writeTarget(ctx.root, path!);
    const kind = await kindOf(target.absolute);
    if (kind === null) throw new EditError("missing", target.relative);
    if (kind === "dir") throw new ToolError("is_directory", { path: target.relative });
    if (kind === "special") throw new ToolError("special_file", { path: target.relative });
    const before = await readForChange(target.absolute, target.relative, options);
    const after = applyEdit(before, oldString!, newString!, { path: target.relative });
    const outcome = await ctx.approvals.change(
      {
        tool: "edit",
        relative: target.relative,
        absolute: target.absolute,
        before,
        after,
        diff: unifiedDiff(before, after, target.relative),
        stale: staleCheck(ctx.root, target, before, options),
      },
      asks("edit", decision, ctx, target),
      ctx.signal,
    );
    return changeResult("edit", target.relative, "Edited", outcome, before, after);
  } catch (error) {
    return failed(error);
  }
}

async function writeFileTool(args: Record<string, unknown>, decision: "allow" | "ask", ctx: ToolContext, options: HostOptions): Promise<ToolOutcome> {
  const path = stringArg(args, "path");
  if (isOutcome(path)) return path;
  const content = stringArg(args, "content");
  if (isOutcome(content)) return content;
  try {
    const target = writeTarget(ctx.root, path!);
    const kind = await kindOf(target.absolute);
    if (kind === "dir") throw new ToolError("is_directory", { path: target.relative });
    if (kind === "special") throw new ToolError("special_file", { path: target.relative });
    const before = kind === "file" ? await readForChange(target.absolute, target.relative, options) : null;
    if (before === content) return ok(`${target.relative} already has exactly this content; nothing was written.`);
    const outcome = await ctx.approvals.change(
      {
        tool: "write_file",
        relative: target.relative,
        absolute: target.absolute,
        before,
        after: content!,
        diff: unifiedDiff(before ?? "", content!, target.relative),
        stale: staleCheck(ctx.root, target, before, options),
      },
      asks("write_file", decision, ctx, target),
      ctx.signal,
    );
    return changeResult("write_file", target.relative, before === null ? "Created" : "Wrote", outcome, before, content!);
  } catch (error) {
    return failed(error);
  }
}

/**
 * run_shell's text for a finished command: the SDK's `formatShell` over the
 * start and end the capture kept (shell.ts), with the bytes it dropped from
 * between them as `omitted`.
 */
export function shellText(result: ShellResult, timeoutS: number, limits?: Limits): string {
  return formatShell(result.output, { exitCode: result.exitCode, timedOut: result.timedOut, stopped: result.stopped, timeoutS, limits, omitted: result.omitted });
}

async function runShellTool(args: Record<string, unknown>, decision: "allow" | "ask", ctx: ToolContext, options: HostOptions): Promise<ToolOutcome> {
  const command = stringArg(args, "command");
  if (isOutcome(command)) return command;
  if (!command!.trim()) return failure("The command is empty.");
  const max = limit("shell_timeout_s_max", options.limits);
  const given = args.timeout_s;
  if (given !== undefined && given !== null && (typeof given !== "number" || !Number.isInteger(given) || given < 1 || given > max)) {
    return failure(new ToolError("bad_timeout", { max }).message);
  }
  const timeoutS = typeof given === "number" ? given : limit("shell_timeout_s_default", options.limits);
  if (decision === "ask") {
    const answer = await ctx.approvals.confirm(
      { kind: "shell", tool: "run_shell", title: `Run a command in ${ctx.root} (time limit ${timeoutS}s)`, detail: command! },
      ctx.signal,
    );
    if (!answer.approved) return rejectedOutcome("run_shell", answer.reason);
  }
  const run = options.runShell ?? spawnShell;
  const result = await run(command!, {
    cwd: ctx.root,
    timeoutMs: timeoutS * 1000,
    maxBytes: limit("shell_output_max_bytes", options.limits),
    signal: ctx.signal,
    onOutput: ctx.onOutput,
  });
  return { content: shellText(result, timeoutS, options.limits), isError: result.stopped || result.timedOut || result.exitCode !== 0 };
}

/**
 * The contract's seven tools as `ToolSpec`s. Their `/v1` definitions are the
 * SDK's (`toolsForMode`), and so is every decision (`allowed`).
 */
export function contractTools(options: HostOptions = {}): ToolSpec[] {
  const spec = (
    name: ToolName,
    run: (args: Record<string, unknown>, decision: "allow" | "ask", ctx: ToolContext) => Promise<ToolOutcome>,
    label: (args: Record<string, unknown>) => string,
  ): ToolSpec =>
    toolSpec({
      name,
      kind: TOOLS_BY_NAME[name].kind,
      description: "",
      run: (args, decision, ctx) => (decision === "deny" ? Promise.resolve(failure(refusal("mode", { tool: name, mode: ctx.mode }))) : run(args, decision, ctx)),
      label,
    });
  const str = (value: unknown) => (typeof value === "string" ? value : "");
  return [
    spec("read_file", (a, _d, c) => readFileTool(a, c, options), (a) => str(a.path)),
    spec("list_dir", (a, _d, c) => listDirTool(a, c, options), (a) => str(a.path) || "."),
    spec("glob", (a, _d, c) => globTool(a, c, options), (a) => str(a.pattern)),
    spec("grep", (a, _d, c) => grepTool(a, c, options), (a) => `${str(a.pattern)}${a.path ? ` in ${str(a.path)}` : ""}`),
    spec("edit", (a, d, c) => editTool(a, d, c, options), (a) => str(a.path)),
    spec("write_file", (a, d, c) => writeFileTool(a, d, c, options), (a) => str(a.path)),
    spec("run_shell", (a, d, c) => runShellTool(a, d, c, options), (a) => str(a.command)),
  ];
}
