import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fill } from "../lib/sdk/agent/fill";
import { OUTPUTS, shellFor, utf8Head, utf8Tail } from "../lib/sdk/agent/node";
import { childEnv } from "./env";

/**
 * `run_shell`'s process: the contract's shell for the platform (PowerShell
 * on Windows, `/bin/sh -c` elsewhere), the workspace root as its working
 * directory, stdout and stderr together, a timeout, and an output cap.
 *
 * Stop and the timeout end the command and every process it started,
 * including the ones that detached from it, as far as the platform allows:
 *
 * - Windows: the shell puts itself in a Job Object with KILL_ON_JOB_CLOSE
 *   before the command runs (a PowerShell prelude, see `WINDOWS_PRELUDE`),
 *   so every process it starts is in the job, `cmd /c start /b` and
 *   `Start-Process` included. Stop terminates the shell, which closes the
 *   job's only handle, and Windows ends everything in it. The job also ends
 *   when the extension host does. A command that ends on its own lifts the
 *   kill first, so what it left in the background runs on, as in a terminal.
 *   Where the job cannot be made (PowerShell in ConstrainedLanguage mode),
 *   `taskkill /T` walks the tree as before.
 * - Linux: the shell leads a new session and process group; where a systemd
 *   user manager runs, it also runs in a transient scope (a cgroup of its
 *   own), and Stop kills the whole cgroup, which a process does not leave by
 *   forking, detaching or starting a session of its own.
 *   Without one, Stop kills the group, the session and every descendant
 *   still linked to the shell; a process that started a session of its own
 *   and lost its parent (a double-forked daemon) is out of reach.
 * - macOS: a new session and process group, and every descendant still
 *   linked to the shell by its parent; a daemon that detached is out of
 *   reach (macOS has no cgroups and no subreaper for a process like this).
 *
 * Either way the promise settles a moment after the kill is sent, without
 * waiting on it, and a stray grandchild that still holds a pipe open cannot
 * hang it.
 */

export interface ShellResult {
  /** The exit code, or null when the process was killed (by Stop or the timeout). */
  exitCode: number | null;
  /**
   * What the command wrote, whole; or, past what is kept, its head and tail
   * with the contract's cut marker between them (`omitted` > 0).
   */
  output: string;
  /** Bytes of output dropped from the middle and named by the marker in `output`; 0 when nothing was. */
  omitted: number;
  timedOut: boolean;
  stopped: boolean;
  /** True when the output passed the cap, so its middle is cut from what the model sees. */
  truncated: boolean;
  durationMs: number;
}

export interface ShellOptions {
  cwd: string;
  timeoutMs: number;
  /** The cap on what the model sees: the first and last halves of it, the middle cut. */
  maxBytes: number;
  signal?: AbortSignal;
  /** Each piece of output as it arrives, for a live view; capped output is still what the result returns. */
  onOutput?: (text: string) => void;
  onSpawn?: (pid: number) => void;
  /** The environment to start from (the extension host's by default); `childEnv` cleans it either way. */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** The process whose end ends the command (Windows); the extension host by default. */
  hostPid?: number;
}

/**
 * After a kill, how long output already in flight is still collected before
 * the result is settled. The person who pressed Stop is not kept waiting for
 * the kill itself.
 */
const SETTLE_AFTER_KILL_MS = 100;
/**
 * After the shell exits, how long its pipes may stay open before the result
 * is settled: output written just before the exit still arrives, and a
 * background process the command left holding the pipes does not hang it.
 */
const SETTLE_AFTER_EXIT_MS = 200;

/**
 * Without the job (Windows), the tree is killed by `taskkill /T`, a process
 * of its own, which a loaded machine can take a while to start. If the shell
 * is still alive this long after Stop, it is terminated directly, so the
 * command itself always ends in time.
 */
const TERMINATE_SHELL_AFTER_MS = 1_200;

/** Where the prelude rides into PowerShell, read and removed before the command starts. */
const PRELUDE_VAR = "MATTERWAVE_SHELL_PRELUDE";
/**
 * What the PowerShell command line starts with. The prelude itself travels
 * in the environment, so the command line (which PowerShell echoes in an
 * error's header) carries only this.
 */
const WINDOWS_BOOTSTRAP = `iex $env:${PRELUDE_VAR}; `;

/**
 * The Windows prelude, run by the shell before the command:
 *
 * - UTF-8 output: PowerShell 5.1 writes redirected output in the OEM code
 *   page, which garbles non-ASCII text.
 * - A Job Object with KILL_ON_JOB_CLOSE, the shell assigned to it before the
 *   command runs, so every process the command starts is born in it. The
 *   handle is the shell's alone (not inheritable), so when the shell is
 *   terminated (Stop, the timeout) Windows ends everything in the job.
 * - A wait on the extension host's process that terminates the job when the
 *   host ends, so nothing outlives the editor.
 * - On a normal exit (`ProcessExit`, which a terminated process never
 *   raises) the kill flag is lifted first: a finished command's background
 *   processes run on, as in a terminal.
 *
 * Node has no API for a job, so the four kernel32 calls are bound through
 * Reflection.Emit (no compiler, a few milliseconds), and the two callbacks
 * are emitted as IL, since a thread-pool thread cannot run script. When it
 * all worked the shell writes `{marker}` first on stdout, which `runShell`
 * takes off; without it Stop falls back to `taskkill /T`. Any failure
 * (ConstrainedLanguage mode, say) leaves the command to run as before, and
 * so would a script scanner (AMSI) that refused the prelude, though its
 * error would then show in the output.
 */
const WINDOWS_PRELUDE = [
  `Remove-Item Env:${PRELUDE_VAR} -ErrorAction SilentlyContinue`,
  "try { $OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}",
  "& {",
  "  try {",
  "    $o = [Reflection.Emit.OpCodes]; $m = [Runtime.InteropServices.Marshal]",
  "    $t = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName 'MatterWaveJob'), 'Run').DefineDynamicModule('MatterWaveJob').DefineType('MatterWaveJob', 'Public,Abstract,Sealed')",
  "    $k = 'kernel32.dll'; $p = 'Public,Static,PinvokeImpl'",
  "    $create = $t.DefinePInvokeMethod('CreateJobObjectW', $k, $p, 'Standard', [IntPtr], [Type[]]@([IntPtr], [IntPtr]), 'Winapi', 'Unicode')",
  "    $set = $t.DefinePInvokeMethod('SetInformationJobObject', $k, $p, 'Standard', [bool], [Type[]]@([IntPtr], [int], [IntPtr], [int]), 'Winapi', 'Auto')",
  "    $assign = $t.DefinePInvokeMethod('AssignProcessToJobObject', $k, $p, 'Standard', [bool], [Type[]]@([IntPtr], [IntPtr]), 'Winapi', 'Auto')",
  "    $end = $t.DefinePInvokeMethod('TerminateJobObject', $k, $p, 'Standard', [bool], [Type[]]@([IntPtr], [int]), 'Winapi', 'Auto')",
  "    foreach ($f in $create, $set, $assign, $end) { $f.SetImplementationFlags('PreserveSig') }",
  "    $job = $t.DefineField('Job', [IntPtr], 'Public,Static'); $open = $t.DefineField('Open', [IntPtr], 'Public,Static'); $size = $t.DefineField('Size', [int], 'Public,Static')",
  "    $null = $t.DefineField('Keep', [object], 'Public,Static')",
  "    $il = $t.DefineMethod('HostEnded', 'Public,Static', [void], [Type[]]@([object], [bool])).GetILGenerator()",
  "    $il.Emit($o::Ldsfld, $job); $il.Emit($o::Ldc_I4_1); $il.Emit($o::Call, $end); $il.Emit($o::Pop); $il.Emit($o::Ret)",
  "    $il = $t.DefineMethod('Exiting', 'Public,Static', [void], [Type[]]@([object], [EventArgs])).GetILGenerator()",
  "    $il.Emit($o::Ldsfld, $job); $il.Emit($o::Ldc_I4_S, [sbyte]9); $il.Emit($o::Ldsfld, $open); $il.Emit($o::Ldsfld, $size); $il.Emit($o::Call, $set); $il.Emit($o::Pop); $il.Emit($o::Ret)",
  "    $j = $t.CreateType()",
  "    $h = $j::CreateJobObjectW([IntPtr]::Zero, [IntPtr]::Zero)",
  "    if ($h -eq [IntPtr]::Zero) { return }",
  // JOBOBJECT_EXTENDED_LIMIT_INFORMATION: 144 bytes on 64-bit, 112 on 32-bit; LimitFlags at 16 in both.
  "    $n = if ([IntPtr]::Size -eq 8) { 144 } else { 112 }",
  "    $kill = $m::AllocHGlobal($n); $lift = $m::AllocHGlobal($n)",
  "    for ($i = 0; $i -lt $n; $i += 4) { $m::WriteInt32($kill, $i, 0); $m::WriteInt32($lift, $i, 0) }",
  "    $m::WriteInt32($kill, 16, 0x2000)",
  "    if (-not $j::SetInformationJobObject($h, 9, $kill, $n)) { return }",
  "    $j.GetField('Job').SetValue($null, $h); $j.GetField('Open').SetValue($null, $lift); $j.GetField('Size').SetValue($null, $n)",
  "    if (-not $j::AssignProcessToJobObject($h, [IntPtr](-1))) { return }",
  "    [AppDomain]::CurrentDomain.add_ProcessExit([Delegate]::CreateDelegate([EventHandler], $j.GetMethod('Exiting')))",
  "    $hostProcess = [Diagnostics.Process]::GetProcessById({hostPid})",
  "    $wait = New-Object Threading.ManualResetEvent $false",
  "    $wait.SafeWaitHandle = New-Object Microsoft.Win32.SafeHandles.SafeWaitHandle($hostProcess.Handle, $false)",
  "    $null = [Threading.ThreadPool]::RegisterWaitForSingleObject($wait, [Delegate]::CreateDelegate([Threading.WaitOrTimerCallback], $j.GetMethod('HostEnded')), $null, -1, $true)",
  "    $j.GetField('Keep').SetValue($null, @($hostProcess, $wait))",
  "    [Console]::Out.Write('{marker}'); [Console]::Out.Flush()",
  "  } catch {}",
  "}",
].join("\n");

export function shellArgv(command: string, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  const shell = shellFor(platform);
  const [file, ...rest] = shell.argv;
  const windows = platform === "win32";
  return { file: file ?? (windows ? "powershell.exe" : "/bin/sh"), args: [...rest, windows ? WINDOWS_BOOTSTRAP + command : command] };
}

/** The prelude's text for one command: `{hostPid}` and `{marker}` filled in. */
export function windowsPrelude(hostPid: number, marker: string): string {
  return fill(WINDOWS_PRELUDE, { hostPid: String(Math.trunc(hostPid)), marker });
}

/** What holds a command's processes besides the process tree: the Windows job, a systemd scope. */
export interface Containment {
  /** The shell is in a Job Object with KILL_ON_JOB_CLOSE: terminating it ends everything in the job. */
  job?: boolean;
  /** The transient systemd scope the shell runs in (Linux), by unit name. */
  scope?: string | null;
}

// --- POSIX: the processes a kill must reach -----------------------------------

function procStat(pid: string): { ppid: number; session: number } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name, in parentheses, may itself hold spaces and parentheses.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { ppid: Number(fields[1]), session: Number(fields[3]) };
  } catch {
    return null;
  }
}

function processTable(platform: NodeJS.Platform): { pid: number; ppid: number; session: number | null }[] {
  if (platform === "linux" && existsSync("/proc/self/stat")) {
    const rows: { pid: number; ppid: number; session: number | null }[] = [];
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      const stat = procStat(name);
      if (stat) rows.push({ pid: Number(name), ...stat });
    }
    return rows;
  }
  try {
    const text = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] });
    return text
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter((pair) => pair.length === 2 && pair.every(Number.isInteger))
      .map(([pid, ppid]) => ({ pid: pid!, ppid: ppid!, session: null }));
  } catch {
    return [];
  }
}

/**
 * The processes `leader` (a session and group leader) started that a kill of
 * its group would miss: its descendants by parent, and on Linux every process
 * still in its session. Read before the group is killed, while the links hold.
 */
export function strays(leader: number, platform: NodeJS.Platform = process.platform): number[] {
  const table = processTable(platform);
  const children = new Map<number, number[]>();
  for (const row of table) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid]);
  const found = new Set<number>(table.filter((row) => row.session === leader && row.pid !== leader).map((row) => row.pid));
  const queue = [leader];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (child === leader || found.has(child) || child === process.pid) continue;
      found.add(child);
      queue.push(child);
    }
  }
  found.delete(process.pid);
  return [...found];
}

/** Kill everything in a systemd scope: its cgroup's `cgroup.kill` where the kernel has one, `systemctl --user kill` otherwise. */
function killScope(unit: string, pid: number): void {
  try {
    const line = readFileSync(`/proc/${pid}/cgroup`, "utf8")
      .split("\n")
      .find((l) => l.startsWith("0::"));
    const path = line?.slice(3).trim();
    if (path && path.endsWith(`/${unit}`)) {
      writeFileSync(`/sys/fs/cgroup${path}/cgroup.kill`, "1");
      return;
    }
  } catch {
    // No cgroup v2 kill file, or the shell is already gone: ask systemd.
  }
  const killer = spawn("systemctl", ["--user", "kill", "--signal=SIGKILL", unit], { stdio: "ignore" });
  killer.on("error", () => undefined);
}

/** Kill `child` and everything it started. Safe to call twice and on a process already gone. */
export function killTree(child: ChildProcess, platform: NodeJS.Platform = process.platform, containment: Containment = {}): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (platform === "win32") {
    if (containment.job) {
      // The job's only handle is the shell's: when it goes, Windows ends every process in the job.
      child.kill();
      return;
    }
    // Not spawnSync: the extension host's event loop keeps running while the tree dies.
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.on("error", () => child.kill());
    if (child.exitCode === null && child.signalCode === null) {
      const fallback = setTimeout(() => child.kill("SIGKILL"), TERMINATE_SHELL_AFTER_MS);
      child.once("exit", () => clearTimeout(fallback));
    }
    return;
  }
  const others = child.exitCode === null && child.signalCode === null ? strays(pid, platform) : [];
  if (containment.scope) killScope(containment.scope, pid);
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
  for (const other of others) {
    try {
      process.kill(other, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

// --- Linux: a systemd scope where a user manager runs ----------------------------

let scopes: Promise<boolean> | null = null;

/**
 * Whether `systemd-run --user --scope` works here, tried once: the probe
 * checks what the command relies on (output through the pipe, the exit code
 * through the scope), so anything short of that runs the shell as before.
 */
export function systemdScopes(platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (platform !== "linux") return Promise.resolve(false);
  scopes ??= new Promise<boolean>((resolve) => {
    let out = "";
    const probe = spawn("systemd-run", ["--user", "--scope", "--quiet", "--collect", "--", "/bin/sh", "-c", "echo scoped; exit 7"], {
      stdio: ["ignore", "pipe", "ignore"],
      env: childEnv(process.env),
    });
    const timer = setTimeout(() => {
      probe.kill("SIGKILL");
      resolve(false);
    }, 5_000);
    probe.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    probe.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    probe.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 7 && out.trim() === "scoped");
    });
  });
  return scopes;
}

// --- the output ------------------------------------------------------------------

/**
 * A command's output as it streams, kept to what the model can be shown: the
 * first half of the cap and the last half, plus a few bytes either side so a
 * character cut at the edge decodes as it would whole, and a count of the
 * rest. The cut itself is the SDK's (`utf8Head`, `utf8Tail` and the
 * contract's marker), made here because the middle is never held.
 */
export class CappedOutput {
  private readonly head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private dropped = 0;
  private total = 0;
  private readonly half: number;
  private readonly headRoom: number;
  private readonly tailRoom: number;

  constructor(private readonly maxBytes: number) {
    this.half = Math.floor(maxBytes / 2);
    this.headRoom = this.half + 3;
    this.tailRoom = maxBytes - this.half + 3;
  }

  push(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.headBytes < this.headRoom) {
      const take = chunk.subarray(0, this.headRoom - this.headBytes);
      this.head.push(take);
      this.headBytes += take.length;
      chunk = chunk.subarray(take.length);
    }
    if (chunk.length === 0) return;
    this.tail.push(chunk);
    this.tailBytes += chunk.length;
    while (this.tailBytes > this.tailRoom && this.tail.length > 0) {
      const first = this.tail[0]!;
      const excess = this.tailBytes - this.tailRoom;
      if (first.length <= excess) {
        this.tail.shift();
        this.tailBytes -= first.length;
        this.dropped += first.length;
      } else {
        this.tail[0] = first.subarray(excess);
        this.tailBytes -= excess;
        this.dropped += excess;
      }
    }
  }

  /** Past the cap, the model sees the head and tail only. */
  get truncated(): boolean {
    return this.total > this.maxBytes;
  }

  /** The output whole when all of it is still held; otherwise the head, the marker and the tail. */
  result(): { output: string; omitted: number } {
    if (this.dropped === 0) return { output: Buffer.concat([...this.head, ...this.tail]).toString("utf8"), omitted: 0 };
    const head = Buffer.concat(this.head).toString("utf8");
    const tail = Buffer.concat(this.tail).toString("utf8");
    const kept = { head: utf8Head(head, this.half), tail: utf8Tail(tail, this.maxBytes - this.half) };
    const omitted = this.total - Buffer.byteLength(kept.head) - Buffer.byteLength(kept.tail);
    return { output: `${kept.head}\n${fill(OUTPUTS.shell.cut, { omitted: String(omitted) })}\n${kept.tail}`, omitted };
  }
}

/**
 * Takes the prelude's marker off the front of the shell's stdout, saying
 * whether it came; whatever else arrives passes through untouched.
 */
class MarkerFilter {
  private pending: Buffer | null;

  constructor(
    private readonly marker: Buffer | null,
    private readonly found: () => void,
  ) {
    this.pending = marker ? Buffer.alloc(0) : null;
  }

  take(chunk: Buffer): Buffer {
    if (this.pending === null || this.marker === null) return chunk;
    const seen = Buffer.concat([this.pending, chunk]);
    if (seen.length < this.marker.length && this.marker.subarray(0, seen.length).equals(seen)) {
      this.pending = seen;
      return Buffer.alloc(0);
    }
    this.pending = null;
    if (seen.subarray(0, this.marker.length).equals(this.marker)) {
      this.found();
      return seen.subarray(this.marker.length);
    }
    return seen;
  }

  /** What is still held at the end: output that began like the marker but was not it. */
  flush(): Buffer {
    const rest = this.pending ?? Buffer.alloc(0);
    this.pending = null;
    return rest;
  }
}

// --- running one command ------------------------------------------------------------

const live = new Set<() => void>();

/** End every command still running: for the extension's deactivation. */
export function killAllShells(): void {
  for (const kill of [...live]) kill();
}

export async function runShell(command: string, options: ShellOptions): Promise<ShellResult> {
  const platform = options.platform ?? process.platform;
  const windows = platform === "win32";
  const started = Date.now();
  const output = new CappedOutput(options.maxBytes);
  const containment: Containment = {};
  let { file, args } = shellArgv(command, platform);
  const env = childEnv(options.env ?? process.env);
  let marker: Buffer | null = null;
  if (windows) {
    const text = `[matterwave-job ${randomBytes(8).toString("hex")}]`;
    marker = Buffer.from(text, "utf8");
    env[PRELUDE_VAR] = windowsPrelude(options.hostPid ?? process.pid, text);
  } else if (await systemdScopes(platform)) {
    containment.scope = `matterwave-shell-${process.pid}-${randomBytes(6).toString("hex")}.scope`;
    args = ["--user", "--scope", "--quiet", "--collect", `--unit=${containment.scope}`, "--", file, ...args];
    file = "systemd-run";
  }
  if (options.signal?.aborted) {
    return { exitCode: null, output: "", omitted: 0, timedOut: false, stopped: true, truncated: false, durationMs: Date.now() - started };
  }
  return new Promise<ShellResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let stopped = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(file, args, {
      cwd: options.cwd,
      // The editor's plumbing and MatterWave's credential stay out of the command's environment.
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // A session and process group of its own on POSIX, so the group can be killed whole.
      detached: !windows,
    });
    const filter = new MarkerFilter(marker, () => (containment.job = true));
    const take = (chunk: Buffer) => {
      if (chunk.length === 0) return;
      output.push(chunk);
      options.onOutput?.(chunk.toString("utf8"));
    };
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      live.delete(kill);
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(exitTimer);
      options.signal?.removeEventListener("abort", onAbort);
      take(filter.flush());
      resolve({
        exitCode: timedOut || stopped ? null : exitCode,
        ...output.result(),
        timedOut,
        stopped,
        truncated: output.truncated,
        durationMs: Date.now() - started,
      });
    };
    function kill() {
      killTree(child, platform, containment);
      killTimer ??= setTimeout(() => finish(null), SETTLE_AFTER_KILL_MS);
    }
    const onAbort = () => {
      stopped = true;
      kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    live.add(kill);
    child.stdout?.on("data", (chunk: Buffer) => take(filter.take(chunk)));
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
