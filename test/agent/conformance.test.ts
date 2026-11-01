import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contractTools, shellText, type HostOptions } from "../../src/agent/host";
import { CappedOutput, type ShellResult } from "../../src/agent/shell";
import type { ToolOutcome } from "../../src/agent/tools";
import { CONTRACT, LIMITS, PathRefusedError, confine, formatShell, loadSearchIgnore, windowsAlias, type Limits, type ModeName } from "../../src/lib/sdk/agent/node";
import { ScriptedApprovals, workspace } from "./helpers";

/**
 * The contract's conformance cases (`CONTRACT.conformance`), which every
 * client must reproduce, run through this extension's own tools: the tree
 * written out as a workspace, each tool case through `contractTools()` as
 * the agent runs it, each path through what read_file and write_file make
 * of it, the ignore verdicts through what glob and list_dir leave out, and
 * the run_shell texts through the output capture and `shellText`.
 */

interface ToolCase {
  tool: "read_file" | "list_dir" | "glob" | "grep";
  args: Record<string, string | number | boolean>;
  limits?: Limits;
  expected?: string;
  error?: string;
  refused?: string;
  message?: string;
  message_prefix?: string;
}

interface Conformance {
  tree: Record<string, string>;
  paths: { path: string; write?: boolean; relative?: string; refused?: string; message?: string }[];
  tools: ToolCase[];
  ignore: { path: string; is_dir?: boolean; ancestors?: boolean; ignored: boolean }[];
  shell: { output: string; exit_code?: number | null; timed_out?: boolean; stopped?: boolean; timeout_s?: number; limits?: Limits; expected: string }[];
}

const CASES = CONTRACT.conformance as unknown as Conformance;

let ws: ReturnType<typeof workspace>;

beforeAll(() => {
  ws = workspace(CASES.tree);
});

afterAll(() => ws.cleanup());

async function call(name: string, args: Record<string, unknown>, options: HostOptions = {}, { mode = "ask" as ModeName, approvals = new ScriptedApprovals() } = {}): Promise<ToolOutcome> {
  const spec = contractTools(options).find((t) => t.name === name)!;
  return spec.run(args, spec.decide(mode), {
    root: ws.root,
    mode,
    signal: new AbortController().signal,
    approvals,
    call: { id: "c", type: "function", function: { name, arguments: JSON.stringify(args) } },
  });
}

// No document open in the editor: what the extension host passes when the file is only on disk.
const noEditor: HostOptions["readText"] = async () => null;

describe("tool cases", () => {
  it.each(CASES.tools.map((c) => [`${c.tool} ${JSON.stringify(c.args)}${c.limits ? " limits" : ""}`, c] as const))("%s", async (_, c) => {
    const result = await call(c.tool, c.args, { limits: c.limits, readText: noEditor });
    if (c.expected !== undefined) {
      expect(result).toEqual({ content: c.expected, isError: false });
    } else if (c.message !== undefined) {
      expect(result).toEqual({ content: c.message, isError: true });
    } else {
      expect(result.isError).toBe(true);
      expect(result.content.startsWith(c.message_prefix!)).toBe(true);
    }
  });

  it("covers every tool and outcome the contract names", () => {
    expect(new Set(CASES.tools.map((c) => c.tool))).toEqual(new Set(["read_file", "list_dir", "glob", "grep"]));
    expect(CASES.tools.some((c) => c.refused)).toBe(true);
  });
});

describe("path cases", () => {
  const refusals = CASES.paths.filter((c) => c.refused !== undefined && c.refused !== "protected");

  it.each(CASES.paths.map((c) => [`${JSON.stringify(c.path)}${c.write ? " (write)" : ""}`, c] as const))("confine: %s", (_, c) => {
    if (c.relative !== undefined) {
      expect(confine(ws.root, c.path, { write: c.write ?? false }).relative).toBe(c.relative);
      return;
    }
    let thrown: unknown;
    try {
      confine(ws.root, c.path, { write: c.write ?? false });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PathRefusedError);
    expect([(thrown as PathRefusedError).reason, (thrown as PathRefusedError).message]).toEqual([c.refused, c.message]);
  });

  it.each(refusals.map((c) => [`${JSON.stringify(c.path)}${c.write ? " (write)" : ""}`, c] as const))("the tool refuses %s, before anything is read or proposed", async (_, c) => {
    const approvals = new ScriptedApprovals();
    const result = c.write ? await call("write_file", { path: c.path, content: "x" }, {}, { mode: "yolo", approvals }) : await call("read_file", { path: c.path }, { readText: noEditor });
    expect(result).toEqual({ content: c.message, isError: true });
    expect(approvals.changes).toHaveLength(0);
  });

  it.each(CASES.paths.filter((c) => c.refused === "protected").map((c) => [c.path, c] as const))("a write to %s asks, even in yolo", async (_, c) => {
    const approvals = new ScriptedApprovals({ change: false });
    const result = await call("write_file", { path: c.path, content: "x" }, {}, { mode: "yolo", approvals });
    expect(approvals.changes.map((change) => [change.change.relative, change.ask])).toEqual([[confine(ws.root, c.path, { write: true, approved: true }).relative, true]]);
    expect(result).toMatchObject({ rejected: true, isError: false });
    expect(existsSync(join(ws.root, ...c.path.split("/")))).toBe(c.path in CASES.tree);
  });

  it.each(CASES.paths.filter((c) => c.relative !== undefined).map((c) => [c.path, c] as const))("the tools take %s as a path", async (_, c) => {
    const result = await call("read_file", { path: c.path }, { readText: noEditor });
    expect(result.content.startsWith("Refused:")).toBe(false);
  });

  it("names the Windows aliases without the filesystem", () => {
    const aliases = new Set(["stream", "trailing", "device", "unc"]);
    for (const c of CASES.paths) {
      if (c.refused !== undefined && aliases.has(c.refused)) expect([c.path, windowsAlias(c.path)]).toEqual([c.path, c.refused]);
      else if (c.relative !== undefined) expect([c.path, windowsAlias(c.path)]).toEqual([c.path, null]);
    }
  });
});

describe("ignore cases", () => {
  it.each(CASES.ignore.map((c) => [`${c.path}${c.is_dir ? "/" : ""}${c.ancestors === false ? " (alone)" : ""}`, c] as const))("%s", async (_, c) => {
    // The rules the tools search with.
    const rules = loadSearchIgnore(ws.root);
    expect(rules.ignored(c.path, { isDir: c.is_dir ?? false, ancestors: c.ancestors ?? true })).toBe(c.ignored);
    // And what the tools leave out, where the tree has the path.
    const absolute = join(ws.root, ...c.path.split("/"));
    if (c.ancestors === false || !existsSync(absolute) || statSync(absolute).isDirectory() !== (c.is_dir ?? false)) return;
    if (c.is_dir) {
      const parent = c.path.includes("/") ? c.path.slice(0, c.path.lastIndexOf("/")) : ".";
      const name = `${c.path.slice(c.path.lastIndexOf("/") + 1)}/`;
      const listed = await call("list_dir", { path: parent });
      // A parent that is itself ignored is not reached by a search, but list_dir is given it.
      if (!listed.isError) expect(listed.content.split("\n").includes(name)).toBe(!rules.ignored(c.path, { isDir: true, ancestors: false }));
      return;
    }
    const found = (await call("glob", { pattern: "*" })).content.split("\n");
    expect(found.includes(c.path)).toBe(!c.ignored);
  });
});

describe("shell cases", () => {
  function captured(output: string, maxBytes: number, chunk: number): Pick<ShellResult, "output" | "omitted" | "truncated"> {
    const capture = new CappedOutput(maxBytes);
    const bytes = Buffer.from(output, "utf8");
    for (let at = 0; at < bytes.length; at += chunk) capture.push(bytes.subarray(at, at + chunk));
    return { ...capture.result(), truncated: capture.truncated };
  }

  it.each(CASES.shell.map((c, i) => [`#${i + 1} ${JSON.stringify(c.output).slice(0, 30)}`, c] as const))("%s, through run_shell", async (_, c) => {
    const maxBytes = c.limits?.shell_output_max_bytes ?? LIMITS.shell_output_max_bytes;
    const result = await call(
      "run_shell",
      { command: "echo case", ...(c.timeout_s !== undefined ? { timeout_s: c.timeout_s } : {}) },
      {
        limits: c.limits,
        runShell: async (_command, options) => {
          expect(options.maxBytes).toBe(maxBytes);
          return { exitCode: c.exit_code ?? null, ...captured(c.output, options.maxBytes, 3), timedOut: c.timed_out ?? false, stopped: c.stopped ?? false, durationMs: 1 };
        },
      },
      { mode: "yolo" },
    );
    expect(result.content).toBe(c.expected);
  });

  it("cuts output it could not hold whole exactly as formatShell cuts the whole", () => {
    const pieces = ["a", "é", "€", "😀", "\n", "line of text ", "\r\n"];
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let round = 0; round < 300; round++) {
      let text = "";
      const length = Math.floor(random() * 400);
      while (text.length < length) text += pieces[Math.floor(random() * pieces.length)];
      const maxBytes = 1 + Math.floor(random() * 120);
      const chunk = 1 + Math.floor(random() * 17);
      const kept = captured(text, maxBytes, chunk);
      const status = { exitCode: 0, timedOut: false, stopped: false, timeoutS: 120 };
      const limits = { shell_output_max_bytes: maxBytes };
      expect([round, shellText({ ...kept, ...status, durationMs: 0 }, 120, limits)]).toEqual([round, formatShell(text, { ...status, limits })]);
      expect(kept.truncated).toBe(Buffer.byteLength(text) > maxBytes);
    }
  });
});
