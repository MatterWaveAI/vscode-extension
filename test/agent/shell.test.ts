import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { CappedOutput, runShell, shellArgv, strays } from "../../src/agent/shell";
import { until } from "./helpers";

/**
 * `run_shell`'s process on this platform's contract shell: output, exit
 * code, the cap, the timeout, and Stop ending the whole tree fast. The
 * commands are written per platform (PowerShell on Windows, sh elsewhere).
 */

const windows = process.platform === "win32";
const cwd = process.cwd();

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("runShell", () => {
  it("uses the contract's shell for the platform", () => {
    expect(shellArgv("echo hi", "linux")).toEqual({ file: "/bin/sh", args: ["-c", "echo hi"] });
    const win = shellArgv("echo hi", "win32");
    expect(win.file).toBe("powershell.exe");
    expect(win.args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
    expect(win.args[4]).toMatch(/echo hi$/);
  });

  it("returns stdout and stderr together, with the exit code", async () => {
    const command = windows ? `Write-Output "out put"; [Console]::Error.WriteLine("err"); exit 3` : `echo "out put"; echo err 1>&2; exit 3`;
    const result = await runShell(command, { cwd, timeoutMs: 30_000, maxBytes: 65_536 });
    expect(result.exitCode).toBe(3);
    expect(result.output).toContain("out put");
    expect(result.output).toContain("err");
    expect(result.timedOut).toBe(false);
  }, 30_000);

  it("keeps the head and tail of output past the cap, saying how much was cut", async () => {
    // One write of 4,000 lines: a slow pipeline under a loaded test run would test the machine, not the cap.
    const command = windows
      ? `[Console]::Out.Write((1..4000 | ForEach-Object { "line $_" }) -join [Environment]::NewLine)`
      : `i=1; while [ $i -le 4000 ]; do echo "line $i"; i=$((i+1)); done`;
    const result = await runShell(command, { cwd, timeoutMs: 55_000, maxBytes: 2_000 });
    expect(result.truncated).toBe(true);
    expect(result.output).toContain("line 1");
    expect(result.output).toContain("line 4000");
    expect(result.output).toMatch(/\n\[\.\.\. \d+ bytes of output cut from the middle \.\.\.\]\n/);
    expect(result.omitted).toBeGreaterThan(0);
  }, 60_000);

  it("stops a command at its timeout", async () => {
    const command = windows ? "Start-Sleep -Seconds 60" : "sleep 60";
    const started = Date.now();
    const result = await runShell(command, { cwd, timeoutMs: 1_500, maxBytes: 1_000 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 30_000);

  it(`ends "${windows ? "Start-Sleep -Seconds 60" : "sleep 60"}" within 2 s of Stop`, async () => {
    const abort = new AbortController();
    let pid = 0;
    const running = runShell(windows ? "Start-Sleep -Seconds 60" : "sleep 60", {
      cwd,
      timeoutMs: 120_000,
      maxBytes: 1_000,
      signal: abort.signal,
      onSpawn: (p) => (pid = p),
    });
    await until(() => pid > 0);
    // Give the shell time to start the sleep itself.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const stoppedAt = Date.now();
    abort.abort();
    const result = await running;
    expect(result.stopped).toBe(true);
    // The run is told at once; the process is gone within 2 s of Stop.
    await until(() => !alive(pid), 2_000 - (Date.now() - stoppedAt));
    expect(Date.now() - stoppedAt).toBeLessThan(2_000);
  }, 30_000);

  it("kills the whole tree on Stop: a process the command started dies with it within 2 s", async () => {
    const abort = new AbortController();
    let output = "";
    const command = windows
      ? `$p = Start-Process -FilePath ping.exe -ArgumentList '-n','60','127.0.0.1' -NoNewWindow -PassThru; Write-Output "CHILD=$($p.Id)"; Wait-Process -Id $p.Id`
      : `sleep 60 & echo "CHILD=$!"; wait`;
    const running = runShell(command, { cwd, timeoutMs: 120_000, maxBytes: 65_536, signal: abort.signal, onOutput: (text) => (output += text) });
    await until(() => /CHILD=\d+/.test(output), 15_000);
    const child = Number(/CHILD=(\d+)/.exec(output)![1]);
    expect(alive(child)).toBe(true);
    const stoppedAt = Date.now();
    abort.abort();
    expect((await running).stopped).toBe(true);
    await until(() => !alive(child), 2_000);
    expect(Date.now() - stoppedAt).toBeLessThan(2_000);
  }, 40_000);

  /**
   * A process that detached from the command: `cmd /c start /b` on Windows
   * (its parent, cmd, is gone before Stop, so no tree walk finds it), a new
   * session on POSIX (outside the shell's process group).
   */
  const DETACHED = windows
    ? `cmd /c 'start /b powershell -NoProfile -Command "Write-Output CHILD=$PID; Start-Sleep 60"'; Start-Sleep 60`
    : `perl -MPOSIX -e '$| = 1; POSIX::setsid(); print "CHILD=$$\\n"; exec @ARGV' sleep 60 & wait`;

  async function detached(options: { hostPid?: number } = {}) {
    const abort = new AbortController();
    let output = "";
    let shell = 0;
    const running = runShell(DETACHED, {
      cwd,
      timeoutMs: 120_000,
      maxBytes: 65_536,
      signal: abort.signal,
      onOutput: (text) => (output += text),
      onSpawn: (pid) => (shell = pid),
      ...options,
    });
    await until(() => /CHILD=\d+/.test(output), 20_000);
    const child = Number(/CHILD=(\d+)/.exec(output)![1]);
    expect(alive(child)).toBe(true);
    return { abort, running, child, shell, output: () => output };
  }

  it(`ends a process the command detached (${windows ? "cmd /c start /b" : "a new session"}) within 2 s of Stop`, async () => {
    const { abort, running, child } = await detached();
    const stoppedAt = Date.now();
    abort.abort();
    const result = await running;
    expect(result.stopped).toBe(true);
    try {
      await until(() => !alive(child), 2_000);
    } finally {
      if (alive(child)) process.kill(child);
    }
    expect(Date.now() - stoppedAt).toBeLessThan(2_000);
    expect(result.output).not.toContain("matterwave-job");
  }, 40_000);

  it.runIf(windows)("ends the command and what it detached when the extension host ends", async () => {
    const host = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      const { running, child, shell } = await detached({ hostPid: host.pid! });
      const endedAt = Date.now();
      host.kill();
      await until(() => !alive(child) && !alive(shell), 2_000);
      expect(Date.now() - endedAt).toBeLessThan(2_000);
      await running;
    } finally {
      host.kill();
    }
  }, 40_000);

  it.runIf(windows)("leaves the exit code, the output and a finished command's background process as they were", async () => {
    const plain = await runShell(`Write-Output "out"; [Console]::Error.WriteLine("err"); exit 3`, { cwd, timeoutMs: 30_000, maxBytes: 65_536 });
    expect(plain.exitCode).toBe(3);
    expect(plain.output.replace(/\r/g, "")).toBe("out\nerr\n");
    let output = "";
    const finished = await runShell(`cmd /c 'start /b powershell -NoProfile -Command "Write-Output CHILD=$PID; Start-Sleep 30"'; Start-Sleep -Milliseconds 1500`, {
      cwd,
      timeoutMs: 30_000,
      maxBytes: 65_536,
      onOutput: (text) => (output += text),
    });
    expect(finished.exitCode).toBe(0);
    const child = Number(/CHILD=(\d+)/.exec(output)![1]);
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      // As in a terminal: what a finished command left running is not ended with it.
      expect(alive(child)).toBe(true);
    } finally {
      if (alive(child)) process.kill(child);
    }
  }, 40_000);

  it.runIf(windows)("does not hand its prelude to the command or echo it in an error", async () => {
    const result = await runShell(`Write-Error boom; Get-ChildItem env: | ForEach-Object { $_.Name }`, { cwd, timeoutMs: 30_000, maxBytes: 65_536 });
    expect(result.output).toContain("boom");
    expect(result.output).not.toContain("DefineDynamicAssembly");
    // The error's header echoes the command line, which carries only the bootstrap.
    expect(result.output).toContain("iex $env:MATTERWAVE_SHELL_PRELUDE; Write-Error boom");
    const names = result.output.split(/\r?\n/).map((line) => line.trim());
    expect(names).toContain("PATH");
    expect(names).not.toContain("MATTERWAVE_SHELL_PRELUDE");
  }, 30_000);
});

describe("the shell's output capture", () => {
  it("keeps everything up to the cap and a few bytes over, and only the head and tail past it", () => {
    const small = new CappedOutput(10);
    small.push(Buffer.from("0123456789ABCDEF"));
    expect(small.result()).toEqual({ output: "0123456789ABCDEF", omitted: 0 });
    const large = new CappedOutput(10);
    for (const piece of ["01234", "56789", "ABCDE", "FGHIJ", "KLMNO"]) large.push(Buffer.from(piece));
    expect(large.truncated).toBe(true);
    expect(large.result()).toEqual({ output: "01234\n[... 15 bytes of output cut from the middle ...]\nKLMNO", omitted: 15 });
  });

  it("finds a POSIX command's strays by parent and by session, never the extension host", () => {
    expect(strays(process.pid)).not.toContain(process.pid);
  });
});
