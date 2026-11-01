import { describe, expect, it } from "vitest";
import { runShell, shellArgv } from "../../src/agent/shell";
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

  // The command ends within 2 s (above); a process it started goes with the
  // tree kill, which on a loaded Windows machine can take a little longer.
  it("kills the whole tree on Stop: a process the command started dies with it", async () => {
    const abort = new AbortController();
    let output = "";
    const command = windows
      ? `$p = Start-Process -FilePath ping.exe -ArgumentList '-n','60','127.0.0.1' -NoNewWindow -PassThru; Write-Output "CHILD=$($p.Id)"; Wait-Process -Id $p.Id`
      : `sleep 60 & echo "CHILD=$!"; wait`;
    const running = runShell(command, { cwd, timeoutMs: 120_000, maxBytes: 65_536, signal: abort.signal, onOutput: (text) => (output += text) });
    await until(() => /CHILD=\d+/.test(output), 15_000);
    const child = Number(/CHILD=(\d+)/.exec(output)![1]);
    expect(alive(child)).toBe(true);
    abort.abort();
    expect((await running).stopped).toBe(true);
    await until(() => !alive(child), 5_000);
  }, 40_000);
});
