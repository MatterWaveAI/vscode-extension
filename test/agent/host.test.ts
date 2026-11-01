import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contractTools } from "../../src/agent/host";
import type { ShellOptions, ShellResult } from "../../src/agent/shell";
import type { ToolOutcome, ToolSpec } from "../../src/agent/tools";
import type { ModeName } from "../../src/lib/sdk/agent/types";
import { ScriptedApprovals, workspace } from "./helpers";

/**
 * The seven contract tools against a real folder: what they return, what
 * they skip, and the paths they refuse before anything is read or written.
 */

/**
 * Windows without Developer Mode refuses file symlinks to a normal user, so
 * that one case is skipped there, with the reason in its name; directory
 * links (junctions) need no privilege and are tested everywhere.
 */
const SYMLINK_PROBLEM: string | null = (() => {
  const dir = mkdtempSync(join(tmpdir(), "mw-link-"));
  try {
    writeFileSync(join(dir, "target"), "");
    symlinkSync(join(dir, "target"), join(dir, "link"), "file");
    return null;
  } catch (error) {
    return `file symlinks cannot be created by this user (${(error as NodeJS.ErrnoException).code ?? "error"})`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

let ws: ReturnType<typeof workspace>;
let outside: ReturnType<typeof workspace>;

const FILES = {
  "src/app.ts": "export const a = 1;\nexport const b = 2;\n",
  "src/util.ts": "export function twice(n: number) {\n  return n * 2;\n}\n",
  "README.md": "# Demo\n",
  ".env": "SECRET=hunter2\n",
  ".gitignore": "node_modules/\n*.log\n!keep.log\n",
  "node_modules/pkg/index.ts": "export const hidden = 1;\n",
  "debug.log": "noise\n",
  "keep.log": "kept\n",
  "certs/server.pem": "-----BEGIN-----\n",
  ".matterwaveignore": "private/\n",
  "private/notes.txt": "do not send\n",
  ".git/config": "[core]\n",
};

beforeEach(() => {
  ws = workspace(FILES);
  outside = workspace({ "secret.txt": "outside the root\n" });
});

afterEach(async () => {
  await ws.cleanup();
  await outside.cleanup();
});

function tool(name: string, options: Parameters<typeof contractTools>[0] = {}): ToolSpec {
  const spec = contractTools(options).find((t) => t.name === name);
  if (!spec) throw new Error(`no tool ${name}`);
  return spec;
}

async function run(
  name: string,
  args: Record<string, unknown>,
  { mode = "ask" as ModeName, approvals = new ScriptedApprovals(), options = {} as Parameters<typeof contractTools>[0] } = {},
): Promise<ToolOutcome> {
  const spec = tool(name, options);
  return spec.run(args, spec.decide(mode), {
    root: ws.root,
    mode,
    signal: new AbortController().signal,
    approvals,
    call: { id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } },
  });
}

function bytes(path: string): Buffer {
  return readFileSync(join(ws.root, ...path.split("/")));
}

describe("read_file", () => {
  it("numbers the lines, and reads a range", async () => {
    expect((await run("read_file", { path: "src/util.ts" })).content).toBe(
      "1\texport function twice(n: number) {\n2\t  return n * 2;\n3\t}",
    );
    expect((await run("read_file", { path: "src/util.ts", start_line: 2, end_line: 2 })).content).toBe("2\t  return n * 2;");
  });

  it("cuts a long file at the read limit and says where to read on", async () => {
    writeFileSync(join(ws.root, "long.txt"), Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n"));
    const result = await run("read_file", { path: "long.txt" });
    expect(result.content.split("\n")).toHaveLength(2001);
    expect(result.content).toContain("[cut at line 2000 of 2500: the read limit; pass start_line=2001 to read on]");
  });

  it("names a missing file, a folder and a binary one rather than reading them", async () => {
    expect(await run("read_file", { path: "nope.ts" })).toMatchObject({ isError: true, content: "nope.ts does not exist." });
    expect((await run("read_file", { path: "src" })).content).toContain("is a directory");
    writeFileSync(join(ws.root, "blob.bin"), Buffer.from([1, 0, 2, 3]));
    expect((await run("read_file", { path: "blob.bin" })).content).toContain("binary file");
  });
});

describe("confinement: refused before anything happens", () => {
  it("refuses a path through ..", async () => {
    const result = await run("read_file", { path: "src/../../secret.txt" });
    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("goes through '..'");
  });

  it("refuses an absolute path outside the root", async () => {
    const result = await run("read_file", { path: join(outside.root, "secret.txt") });
    expect(result.content).toContain("is outside the workspace root");
    expect(result.content).not.toContain("outside the root\n");
  });

  it("allows an absolute path inside the root", async () => {
    expect((await run("read_file", { path: join(ws.root, "README.md") })).content).toBe("1\t# Demo");
  });

  it.skipIf(SYMLINK_PROBLEM !== null)(`refuses a file symlink that leads out of the root${SYMLINK_PROBLEM ? ` (skipped: ${SYMLINK_PROBLEM})` : ""}`, async () => {
    symlinkSync(join(outside.root, "secret.txt"), join(ws.root, "notes.txt"), "file");
    const result = await run("read_file", { path: "notes.txt" });
    expect(result.content).toContain("is a link that leads outside the workspace root");
  });

  it("refuses a directory link (a junction on Windows) that leads out of the root, for reads and writes", async () => {
    symlinkSync(outside.root, join(ws.root, "escape"), process.platform === "win32" ? "junction" : "dir");
    expect((await run("read_file", { path: "escape/secret.txt" })).content).toContain("leads outside the workspace root");
    const approvals = new ScriptedApprovals();
    const write = await run("write_file", { path: "escape/new.txt", content: "x" }, { approvals });
    expect(write.content).toContain("leads outside the workspace root");
    expect(approvals.changes).toHaveLength(0);
    expect(() => readFileSync(join(outside.root, "new.txt"))).toThrow();
  });

  it("refuses to read .env, a key or .git, so their contents never reach the model", async () => {
    for (const path of [".env", "certs/server.pem", ".git/config", "private/notes.txt"]) {
      const result = await run("read_file", { path });
      expect(result.isError, path).toBe(true);
      expect(result.content, path).toContain("is protected");
    }
    expect((await run("read_file", { path: ".env" })).content).not.toContain("hunter2");
  });

  it("refuses an edit or a write to a denied or protected path without asking", async () => {
    const approvals = new ScriptedApprovals();
    expect((await run("edit", { path: ".env", old_string: "hunter2", new_string: "x" }, { approvals })).content).toContain("is protected");
    expect((await run("write_file", { path: ".matterwaveignore", content: "" }, { approvals })).content).toContain(
      "can be read but not changed",
    );
    expect((await run("write_file", { path: "../escaped.txt", content: "x" }, { approvals })).content).toContain("'..'");
    expect(approvals.changes).toHaveLength(0);
    expect(bytes(".env").toString()).toBe(FILES[".env"]);
  });
});

describe("list_dir, glob and grep", () => {
  it("lists folders first, leaving out ignored, denied and protected entries", async () => {
    const result = await run("list_dir", {});
    expect(result.content.split("\n")).toEqual(["certs/", "src/", ".gitignore", "README.md", "keep.log"]);
    // certs/ itself is listed; the key inside it is not.
    expect((await run("list_dir", { path: "certs" })).content).toBe("(certs is empty)");
  });

  it("globs under .gitignore (negation included) and the deny list", async () => {
    expect((await run("glob", { pattern: "**/*.ts" })).content.split("\n")).toEqual(["src/app.ts", "src/util.ts"]);
    expect((await run("glob", { pattern: "*.log" })).content).toBe("keep.log");
    expect((await run("glob", { pattern: "*.ts", path: "src" })).content.split("\n")).toEqual(["src/app.ts", "src/util.ts"]);
  });

  it("greps file contents as path:line: text, never in denied files", async () => {
    expect((await run("grep", { pattern: "export const" })).content.split("\n")).toEqual([
      "src/app.ts:1: export const a = 1;",
      "src/app.ts:2: export const b = 2;",
    ]);
    expect((await run("grep", { pattern: "hunter2" })).content).toBe("No matches for hunter2.");
    expect((await run("grep", { pattern: "RETURN", ignore_case: true, glob: "*.ts" })).content).toBe("src/util.ts:2:   return n * 2;");
    expect((await run("grep", { pattern: "(" })).content).toContain("not a valid regular expression");
  });
});

describe("edit and write_file", () => {
  it("proposes an exact replace with its diff, and asks in ask mode", async () => {
    const approvals = new ScriptedApprovals();
    const result = await run("edit", { path: "src/app.ts", old_string: "b = 2", new_string: "b = 3" }, { approvals });
    expect(result).toMatchObject({ isError: false, content: "Edited src/app.ts." });
    expect(approvals.changes).toHaveLength(1);
    expect(approvals.changes[0]!.ask).toBe(true);
    expect(approvals.changes[0]!.change.diff).toContain("-export const b = 2;\n+export const b = 3;");
    expect(bytes("src/app.ts").toString()).toBe("export const a = 1;\nexport const b = 3;\n");
  });

  it("applies without asking in auto-edit", async () => {
    const approvals = new ScriptedApprovals();
    await run("edit", { path: "src/app.ts", old_string: "a = 1", new_string: "a = 9" }, { approvals, mode: "auto-edit" });
    expect(approvals.changes[0]!.ask).toBe(false);
  });

  it("leaves the file byte-identical when the change is rejected", async () => {
    const before = bytes("src/app.ts");
    const result = await run("edit", { path: "src/app.ts", old_string: "b = 2", new_string: "b = 3" }, { approvals: new ScriptedApprovals({ change: false }) });
    expect(result).toMatchObject({ rejected: true, isError: false });
    expect(result.content).toContain("rejected the change to src/app.ts");
    expect(bytes("src/app.ts").equals(before)).toBe(true);
  });

  it("tells the model when the person edited the proposal", async () => {
    const approvals = new ScriptedApprovals({ edited: (after) => after.replace("b = 3", "b = 4") });
    const result = await run("edit", { path: "src/app.ts", old_string: "b = 2", new_string: "b = 3" }, { approvals });
    expect(result.content).toContain("edited your proposal");
    expect(result.content).toContain("+export const b = 4;");
    expect(bytes("src/app.ts").toString()).toContain("b = 4");
  });

  it("names a missing, ambiguous or absent old_string with the contract's sentences", async () => {
    expect((await run("edit", { path: "src/none.ts", old_string: "a", new_string: "b" })).content).toBe(
      "src/none.ts does not exist. Use write_file to create it.",
    );
    expect((await run("edit", { path: "src/app.ts", old_string: "export", new_string: "x" })).content).toBe(
      "old_string occurs 2 times in src/app.ts. Add neighbouring lines so it matches exactly once.",
    );
    expect((await run("edit", { path: "src/app.ts", old_string: "zzz", new_string: "x" })).content).toContain("was not found in src/app.ts");
  });

  it("creates a new file (and its folders) through the same approval", async () => {
    const approvals = new ScriptedApprovals();
    const result = await run("write_file", { path: "lib/new/mod.ts", content: "export {};\n" }, { approvals });
    expect(result.content).toBe("Created lib/new/mod.ts.");
    expect(approvals.changes[0]!.change.before).toBeNull();
    expect(bytes("lib/new/mod.ts").toString()).toBe("export {};\n");
    expect((await run("write_file", { path: "lib/new/mod.ts", content: "export {};\n" })).content).toContain("already has exactly this content");
  });
});

describe("run_shell", () => {
  function fakeShell(record: string[]): (command: string, options: ShellOptions) => Promise<ShellResult> {
    return async (command, options) => {
      record.push(`${command} @ ${options.cwd} ${options.timeoutMs} ${options.maxBytes}`);
      return { exitCode: 0, output: "ok\n", timedOut: false, stopped: false, truncated: false, durationMs: 1 };
    };
  }

  it("asks with the whole command in ask and auto-edit, and runs it in the root with the contract's caps", async () => {
    for (const mode of ["ask", "auto-edit"] as const) {
      const ran: string[] = [];
      const approvals = new ScriptedApprovals();
      const command = "npm test -- --grep 'a very long pattern that must be shown in full'";
      const result = await run("run_shell", { command, timeout_s: 30 }, { mode, approvals, options: { runShell: fakeShell(ran) } });
      expect(approvals.confirms).toHaveLength(1);
      expect(approvals.confirms[0]!.detail).toBe(command);
      expect(ran).toEqual([`${command} @ ${ws.root} 30000 65536`]);
      expect(result.content).toBe("Exit code 0\nok");
    }
  });

  it("does not run a rejected command, and does not ask in yolo", async () => {
    const ran: string[] = [];
    const rejected = await run("run_shell", { command: "rm -rf build" }, { approvals: new ScriptedApprovals({ confirm: false }), options: { runShell: fakeShell(ran) } });
    expect(rejected).toMatchObject({ rejected: true });
    expect(ran).toHaveLength(0);
    const approvals = new ScriptedApprovals();
    await run("run_shell", { command: "echo hi" }, { mode: "yolo", approvals, options: { runShell: fakeShell(ran) } });
    expect(approvals.confirms).toHaveLength(0);
    expect(ran).toHaveLength(1);
  });

  it("is refused outright in plan mode", async () => {
    const ran: string[] = [];
    const result = await run("run_shell", { command: "echo hi" }, { mode: "plan", options: { runShell: fakeShell(ran) } });
    expect(result).toMatchObject({ isError: true, content: "run_shell is not available in plan mode." });
    expect(ran).toHaveLength(0);
  });
});
