import { spawn, type ChildProcess } from "node:child_process";
import { shellFor } from "../lib/sdk/agent/modes";
import { childEnv } from "./env";

/**
 * `run_shell`'s process: the contract's shell for the platform (PowerShell
 * on Windows, `/bin/sh -c` elsewhere), the workspace root as its working
 * directory, stdout and stderr together, a timeout, and an output cap.
 *
 * Stop and the timeout end the whole process tree, not just the shell: a
 * test runner the shell started would otherwise outlive it. On POSIX the
 * shell leads its own process group and the group is killed; on Windows
 * `taskkill /T /F` walks the tree. Either way the promise settles a moment
 * after the kill is sent, without waiting on it, and a stray grandchild
 * that still holds a pipe open cannot hang it.
 */

export interface ShellResult {
  /** The exit code, or null when the process was killed (by Stop or the timeout). */
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  stopped: boolean;
  /** True when the output passed the cap and its middle was cut. */
  truncated: boolean;
  durationMs: number;
}

export interface ShellOptions {
  cwd: string;
  timeoutMs: number;
  /** The cap on what is kept: the first and last halves of it, the middle cut. */
  maxBytes: number;
  signal?: AbortSignal;
  /** Each piece of output as it arrives, for a live view; capped output is still what the result returns. */
  onOutput?: (text: string) => void;
  onSpawn?: (pid: number) => void;
  /** The environment to start from (the extension host's by default); `childEnv` cleans it either way. */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/**
 * After a kill, how long output already in flight is still collected before
 * the result is settled. The kill itself runs on (taskkill on Windows takes
 * most of a second): the person who pressed Stop is not kept waiting for it.
 */
const SETTLE_AFTER_KILL_MS = 100;
/**
 * After the shell exits, how long its pipes may stay open before the result
 * is settled: output written just before the exit still arrives, and a
 * background process the command left holding the pipes does not hang it.
 */
const SETTLE_AFTER_EXIT_MS = 200;

/**
 * On Windows the tree is killed by `taskkill`, a process of its own, which a
 * loaded machine can take seconds to start. If the shell is still alive this
 * long after Stop, it is terminated directly, so the command itself always
 * ends in time; by then taskkill has normally walked the tree.
 */
const TERMINATE_SHELL_AFTER_MS = 1_200;

/** PowerShell 5.1 writes redirected output in the OEM code page; UTF-8 keeps non-ASCII output readable. */
const POWERSHELL_UTF8 = "$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ";

export function shellArgv(command: string, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  const shell = shellFor(platform);
  const [file, ...rest] = shell.argv;
  const windows = platform === "win32";
  return { file: file ?? (windows ? "powershell.exe" : "/bin/sh"), args: [...rest, windows ? POWERSHELL_UTF8 + command : command] };
}

/** Kill `child` and everything it started. Safe to call twice and on a process already gone. */
export function killTree(child: ChildProcess, platform: NodeJS.Platform = process.platform): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (platform === "win32") {
    // Not spawnSync: the extension host's event loop keeps running while the tree dies.
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.on("error", () => child.kill());
    if (child.exitCode === null && child.signalCode === null) {
      const fallback = setTimeout(() => child.kill("SIGKILL"), TERMINATE_SHELL_AFTER_MS);
      child.once("exit", () => clearTimeout(fallback));
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

class CappedOutput {
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private cut = 0;

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    const half = Math.floor(this.maxBytes / 2);
    if (this.headBytes < half) {
      const take = chunk.subarray(0, half - this.headBytes);
      this.head.push(take);
      this.headBytes += take.length;
      chunk = chunk.subarray(take.length);
    }
    if (chunk.length === 0) return;
    this.tail.push(chunk);
    this.tailBytes += chunk.length;
    const room = this.maxBytes - half;
    while (this.tailBytes > room && this.tail.length > 0) {
      const first = this.tail[0]!;
      const excess = this.tailBytes - room;
      if (first.length <= excess) {
        this.tail.shift();
        this.tailBytes -= first.length;
        this.cut += first.length;
      } else {
        this.tail[0] = first.subarray(excess);
        this.tailBytes -= excess;
        this.cut += excess;
      }
    }
  }

  get truncated(): boolean {
    return this.cut > 0;
  }

  text(): string {
    const head = Buffer.concat(this.head).toString("utf8");
    const tail = Buffer.concat(this.tail).toString("utf8");
    return this.cut > 0 ? `${head}\n[... ${this.cut.toLocaleString("en-US")} bytes of output cut ...]\n${tail}` : head + tail;
  }
}

export function runShell(command: string, options: ShellOptions): Promise<ShellResult> {
  const platform = options.platform ?? process.platform;
  const started = Date.now();
  const output = new CappedOutput(options.maxBytes);
  const { file, args } = shellArgv(command, platform);
  return new Promise<ShellResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let stopped = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(file, args, {
      cwd: options.cwd,
      // The editor's plumbing and MatterWave's credential stay out of the command's environment.
      env: childEnv(options.env ?? process.env),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // Its own process group on POSIX, so the group can be killed whole.
      detached: platform !== "win32",
    });
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(exitTimer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode: timedOut || stopped ? null : exitCode,
        output: output.text(),
        timedOut,
        stopped,
        truncated: output.truncated,
        durationMs: Date.now() - started,
      });
    };
    const kill = () => {
      killTree(child, platform);
      killTimer = setTimeout(() => finish(null), SETTLE_AFTER_KILL_MS);
    };
    const onAbort = () => {
      stopped = true;
      kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    const take = (chunk: Buffer) => {
      output.push(chunk);
      options.onOutput?.(chunk.toString("utf8"));
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", (error) => {
      output.push(Buffer.from(`${error.message}\n`));
      finish(127);
    });
    child.on("close", (code) => finish(code));
    child.on("exit", (code) => {
      // Stopped or timed out, what is left in the pipes does not matter: settle now.
      exitTimer = setTimeout(() => finish(code), stopped || timedOut ? 0 : SETTLE_AFTER_EXIT_MS);
    });
    if (child.pid !== undefined) options.onSpawn?.(child.pid);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}
