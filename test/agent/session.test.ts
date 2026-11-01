import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../../src/api/errors";
import { restorePlan, type Checkpoint } from "../../src/checkpoints";
import { McpManager } from "../../src/agent/mcp";
import { AgentSession, type AgentSessionDeps, type AgentSettings } from "../../src/agent/session";
import type { ShellOptions, ShellResult } from "../../src/agent/shell";
import { READ_ONLY_TOOLS } from "../../src/lib/sdk/agent/types";
import { FakeModel, FakeReview, MemoryState, callChunk, textChunk, until, usageChunk, workspace } from "./helpers";

/**
 * A whole agent run, approvals included, against a scripted `/v1` and a
 * stand-in for the editor's diff: modes, caps, Stop, subagents, MCP, the
 * project's notes, resume and restore.
 */

let ws: ReturnType<typeof workspace>;
let home: ReturnType<typeof workspace>;

beforeEach(() => {
  ws = workspace({
    "src/app.ts": "export const a = 1;\nexport const b = 2;\n",
    "src/other.ts": "export const c = 3;\n",
    "MATTERWAVE.md": "Run the tests with `npm test`.\n",
  });
  home = workspace();
});

afterEach(async () => {
  await ws.cleanup();
  await home.cleanup();
});

const SETTINGS: AgentSettings = { maxSteps: 10, maxTokens: 1_000_000, defaultMode: "ask", webFetch: false, editorContext: false };

function session(model: FakeModel, over: Partial<AgentSessionDeps> = {}) {
  const review = new FakeReview();
  const state = new MemoryState();
  const checkpoints: { conversationId: string | null; relative: string; before: string | null }[] = [];
  let yolo = false;
  const deps: AgentSessionDeps = {
    client: model,
    review,
    checkpoint: async (conversationId, relative, before) => void checkpoints.push({ conversationId, relative, before }),
    confirmYolo: async () => yolo,
    settings: () => SETTINGS,
    workspace: () => ({ roots: [{ name: "ws", path: ws.root }], trusted: true }),
    state,
    home: home.root,
    onChange: () => undefined,
    ...over,
  };
  const agent = new AgentSession(deps);
  return { agent, review, state, checkpoints, allowYolo: (on: boolean) => (yolo = on) };
}

function run(agent: AgentSession, prompt: string, signal = new AbortController().signal, conversationId: string | null = "c_1") {
  return agent.run({ prompt, conversationId, model: { id: "grt-small", context_window: 32_768 }, signal });
}

function read(path: string): Buffer {
  return readFileSync(join(ws.root, ...path.split("/")));
}

const EDIT = { path: "src/app.ts", old_string: "b = 2", new_string: "b = 3" };

describe("approval modes", () => {
  it("plan offers the model only read tools: never a write, a command or a fetch", async () => {
    const model = new FakeModel([[textChunk("Here is the plan.")]]);
    const { agent } = session(model);
    await agent.setMode("plan");
    await run(agent, "Plan the change.");
    const offered = model.toolNames(0);
    expect(offered).toEqual(expect.arrayContaining([...READ_ONLY_TOOLS]));
    for (const name of offered) expect([...READ_ONLY_TOOLS, "todo_write"]).toContain(name);
    for (const name of ["edit", "write_file", "run_shell", "web_fetch"]) expect(offered).not.toContain(name);
    // The system prompt names the mode and the root, from the SDK's template.
    const system = model.requests[0]!.messages[0]!;
    expect(system.role).toBe("system");
    expect(system.content).toContain("Approval mode: plan.");
    expect(system.content).toContain(`Workspace root: ${ws.root}`);
  });

  it("ask (the default) shows an edit and changes nothing until it is approved; Reject leaves the file byte-identical", async () => {
    const model = new FakeModel([[callChunk("call_1", "edit", EDIT)], [textChunk("Left it.")]]);
    const { agent, review } = session(model);
    expect(agent.mode).toBe("ask");
    const before = read("src/app.ts");
    const running = run(agent, "Bump b.");
    await until(() => agent.pendingId() !== null);
    // Under review: the diff is open, the file untouched.
    expect(review.opened).toHaveLength(1);
    expect(review.opened[0]!.change.diff).toContain("+export const b = 3;");
    expect(read("src/app.ts").equals(before)).toBe(true);
    const view = agent.snapshot({ available: true, reason: null }).pending!;
    expect(view).toMatchObject({ kind: "edit", path: "src/app.ts" });
    agent.decide(view.id, false);
    const summary = await running;
    expect(summary.status).toBe("done");
    expect(read("src/app.ts").equals(before)).toBe(true);
    expect(review.applied).toHaveLength(0);
    expect(review.closed).toEqual([view.id]);
    // The model was told, and the run went on.
    const toolMessage = model.requests[1]!.messages.find((m) => m.role === "tool")!;
    expect(toolMessage.content).toContain("rejected the change to src/app.ts");
  });

  it("an edited proposal, accepted, writes the person's version and tells the model so", async () => {
    const model = new FakeModel([[callChunk("call_1", "edit", EDIT)], [textChunk("Noted.")]]);
    const { agent, review, checkpoints } = session(model);
    review.edit = (proposal) => proposal.replace("b = 3", "b = 42");
    const running = run(agent, "Bump b.");
    await until(() => agent.pendingId() !== null);
    agent.decide(agent.pendingId()!, true);
    await running;
    expect(read("src/app.ts").toString()).toBe("export const a = 1;\nexport const b = 42;\n");
    expect(checkpoints).toEqual([{ conversationId: "c_1", relative: "src/app.ts", before: "export const a = 1;\nexport const b = 2;\n" }]);
    expect(model.requests[1]!.messages.at(-1)!.content).toContain("edited your proposal");
  });

  it("auto-edit applies edits without asking and still asks before run_shell", async () => {
    const ran: string[] = [];
    const runShell = async (command: string): Promise<ShellResult> => {
      ran.push(command);
      return { exitCode: 0, output: "1 passed", timedOut: false, stopped: false, truncated: false, durationMs: 5 };
    };
    const model = new FakeModel([[callChunk("call_1", "edit", EDIT)], [callChunk("call_2", "run_shell", { command: "npm test" })], [textChunk("Done.")]]);
    const { agent, review } = session(model, { runShell });
    await agent.setMode("auto-edit");
    const running = run(agent, "Bump b and test.");
    await until(() => agent.pendingId() !== null);
    // The edit went straight through; the command waits.
    expect(review.opened).toHaveLength(0);
    expect(review.applied).toHaveLength(1);
    expect(read("src/app.ts").toString()).toContain("b = 3");
    expect(ran).toHaveLength(0);
    const pending = agent.snapshot({ available: true, reason: null }).pending!;
    expect(pending).toMatchObject({ kind: "shell", detail: "npm test" });
    agent.decide(pending.id, true);
    expect((await running).status).toBe("done");
    expect(ran).toEqual(["npm test"]);
  });

  it("yolo needs this session's flag, is never saved, and is not in the cycle until allowed", async () => {
    const { agent, state, allowYolo } = session(new FakeModel([]));
    expect(agent.modes()).toEqual(["plan", "ask", "auto-edit"]);
    expect(await agent.setMode("yolo")).toBe(false);
    expect(agent.mode).toBe("ask");
    await agent.setMode("auto-edit");
    allowYolo(true);
    expect(await agent.setMode("yolo")).toBe(true);
    expect(agent.mode).toBe("yolo");
    expect(agent.modes()).toEqual(["plan", "ask", "auto-edit", "yolo"]);
    // What is saved is the last mode that may be saved.
    expect(state.get("matterwave.agent.mode")).toBe("auto-edit");
    const next = new AgentSession({ ...({} as AgentSessionDeps), client: new FakeModel([]), review: new FakeReview(), confirmYolo: async () => false, settings: () => SETTINGS, workspace: () => ({ roots: [], trusted: true }), state, onChange: () => undefined });
    expect(next.mode).toBe("auto-edit");
    expect(next.modes()).not.toContain("yolo");
  });

  it("cycles plan → ask → auto-edit → plan (Shift+Tab)", async () => {
    const { agent } = session(new FakeModel([]));
    await agent.setMode("plan");
    expect(await agent.cycleMode()).toBe("ask");
    expect(await agent.cycleMode()).toBe("auto-edit");
    expect(await agent.cycleMode()).toBe("plan");
  });
});

describe("caps, budget and Stop", () => {
  it("the step cap ends a model that never stops calling tools, with a clear message", async () => {
    const loop = [callChunk("call_x", "read_file", { path: "src/app.ts" })];
    const model = new FakeModel([], loop);
    const { agent } = session(model, { settings: () => ({ ...SETTINGS, maxSteps: 4 }) });
    const summary = await run(agent, "Loop.");
    expect(summary.status).toBe("step_cap");
    expect(model.requests).toHaveLength(4);
    expect(summary.message).toBe("Stopped after 4 model calls, this run's step cap (matterwave.agent.maxSteps). Send another message to carry on.");
  });

  it("the token cap ends a looping model by what the server reports, with a clear message", async () => {
    const model = new FakeModel([], [callChunk("call_x", "glob", { pattern: "*.ts" }), usageChunk(500, 100)]);
    const { agent } = session(model, { settings: () => ({ ...SETTINGS, maxTokens: 1_500 }) });
    const summary = await run(agent, "Loop.");
    expect(summary.status).toBe("token_cap");
    expect(model.requests).toHaveLength(3);
    expect(summary.usage.tokens).toBe(1_800);
    expect(summary.message).toContain("this run used 1,800 tokens, past its cap of 1,500 (matterwave.agent.maxTokens)");
  });

  it("a 402 from /v1 ends the run as an error the chat reads as the budget state", async () => {
    const model = new FakeModel([[callChunk("call_1", "read_file", { path: "src/app.ts" })], new ApiError(402, "Budget exhausted", "req-402")]);
    const { agent } = session(model);
    const summary = await run(agent, "Read it.");
    expect(summary.status).toBe("error");
    expect(summary.error).toBeInstanceOf(ApiError);
    expect((summary.error as ApiError).status).toBe(402);
    expect(summary.usage.steps).toBe(2);
  });

  it(`Stop during run_shell "${process.platform === "win32" ? "Start-Sleep -Seconds 60" : "sleep 60"}" ends the command and the run within 2 s`, async () => {
    const command = process.platform === "win32" ? "Start-Sleep -Seconds 60" : "sleep 60";
    const model = new FakeModel([[callChunk("call_1", "run_shell", { command })]]);
    let pid = 0;
    const { runShell } = await import("../../src/agent/shell");
    const { agent } = session(model, {
      runShell: (cmd: string, options: ShellOptions) => runShell(cmd, { ...options, onSpawn: (p) => (pid = p) }),
    });
    const allowYoloSession = new AgentSession({ ...(agent as unknown as { deps: AgentSessionDeps }).deps, confirmYolo: async () => true });
    await allowYoloSession.setMode("yolo");
    const abort = new AbortController();
    const running = run(allowYoloSession, "Wait.", abort.signal);
    await until(() => pid > 0, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const stoppedAt = Date.now();
    abort.abort();
    const summary = await running;
    expect(summary.status).toBe("stopped");
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await until(() => !alive(), Math.max(0, 2_000 - (Date.now() - stoppedAt)));
    expect(Date.now() - stoppedAt).toBeLessThan(2_000);
  }, 30_000);

  it("Stop while an approval waits rejects it and writes nothing", async () => {
    const model = new FakeModel([[callChunk("call_1", "edit", EDIT)]]);
    const { agent, review } = session(model);
    const before = read("src/app.ts");
    const abort = new AbortController();
    const running = run(agent, "Bump.", abort.signal);
    await until(() => agent.pendingId() !== null);
    abort.abort();
    expect((await running).status).toBe("stopped");
    expect(review.applied).toHaveLength(0);
    expect(read("src/app.ts").equals(before)).toBe(true);
    expect(agent.pendingId()).toBeNull();
  });
});

describe("subagents", () => {
  beforeEach(() => {
    mkdirSync(join(home.root, ".matterwave", "agents"), { recursive: true });
    writeFileSync(
      join(home.root, ".matterwave", "agents", "reader.md"),
      "---\ndescription: Reads code and reports.\ntools: [read_file, grep]\n---\nRead what you are asked about and summarise it.\n",
    );
  });

  it("respects its own tool allow-list and counts against the parent's caps", async () => {
    const model = new FakeModel([
      [callChunk("p1", "task", { agent: "reader", prompt: "Summarise src/app.ts" })],
      // The subagent's own steps:
      [callChunk("s1", "write_file", { path: "x.txt", content: "no" })],
      [callChunk("s2", "read_file", { path: "src/app.ts" })],
      [textChunk("It exports a and b.")],
      // Back in the parent:
      [textChunk("The reader says it exports a and b.")],
    ]);
    const { agent } = session(model);
    const summary = await run(agent, "What is in app.ts?");
    expect(summary.status).toBe("done");
    // The parent offered task; the subagent was offered its allow-list alone.
    expect(model.toolNames(0)).toContain("task");
    expect(model.toolNames(1).sort()).toEqual(["grep", "read_file"]);
    expect(model.requests[1]!.messages[0]!.content).toContain('You are the "reader" subagent');
    // Its write was refused as a tool it does not have, and nothing was written.
    expect(model.requests[2]!.messages.at(-1)!.content).toContain('There is no tool named "write_file"');
    expect(() => read("x.txt")).toThrow();
    // Five model calls in all, the subagent's three among them.
    expect(summary.usage.steps).toBe(5);
    expect(model.requests[4]!.messages.at(-1)!.content).toBe("It exports a and b.");
  });

  it("stops at the parent's step cap when the subagent loops", async () => {
    const model = new FakeModel([[callChunk("p1", "task", { agent: "reader", prompt: "Loop" })]], [callChunk("s", "read_file", { path: "src/app.ts" })]);
    const { agent } = session(model, { settings: () => ({ ...SETTINGS, maxSteps: 3 }) });
    const summary = await run(agent, "Go.");
    expect(summary.status).toBe("step_cap");
    expect(model.requests).toHaveLength(3);
  });
});

describe("MCP servers", () => {
  const server = fileURLToPath(new URL("../fixtures/mcp-server.mjs", import.meta.url));

  it("lists a stdio server's tools, keeps the allow-list's others from the model, and asks before a tool that writes", async () => {
    const mcp = new McpManager({ version: "test", fetch: () => Promise.reject(new Error("no http")) });
    const model = new FakeModel([
      [callChunk("m1", "mcp__fx__read_thing", { id: "1" })],
      [callChunk("m2", "mcp__fx__write_thing", { id: "2" })],
      [textChunk("done")],
    ]);
    const { agent } = session(model, {
      mcp,
      mcpConfigs: () => ({ fx: { command: process.execPath, args: [server], tools: ["read_thing", "write_thing"] } }),
    });
    try {
      const running = run(agent, "Use the server.");
      await until(() => agent.pendingId() !== null, 15_000);
      const offered = model.toolNames(0);
      expect(offered).toContain("mcp__fx__read_thing");
      expect(offered).toContain("mcp__fx__write_thing");
      expect(offered).not.toContain("mcp__fx__secret_tool");
      // The read-only tool ran without asking; the write waits.
      expect(model.requests[1]!.messages.at(-1)!.content).toBe('read_thing({"id":"1"})');
      const pending = agent.snapshot({ available: true, reason: null }).pending!;
      expect(pending).toMatchObject({ kind: "mcp", tool: "mcp__fx__write_thing" });
      agent.decide(pending.id, true);
      await running;
      expect(model.requests[2]!.messages.at(-1)!.content).toBe('write_thing({"id":"2"})');
      expect(mcp.status()).toEqual([{ name: "fx", state: "connected", tools: 2, hidden: 1, error: null }]);
    } finally {
      mcp.dispose();
    }
  }, 30_000);

  it("offers only an MCP server's read-only tools in plan mode", async () => {
    const mcp = new McpManager({ version: "test", fetch: () => Promise.reject(new Error("no http")) });
    const model = new FakeModel([[textChunk("ok")]]);
    const { agent } = session(model, { mcp, mcpConfigs: () => ({ fx: { command: process.execPath, args: [server] } }) });
    try {
      await agent.setMode("plan");
      await run(agent, "Look.");
      const offered = model.toolNames(0).filter((n) => n.startsWith("mcp__"));
      expect(offered).toEqual(["mcp__fx__read_thing"]);
    } finally {
      mcp.dispose();
    }
  }, 30_000);
});

describe("context, availability, resume and restore", () => {
  it("puts MATTERWAVE.md into the prompt in a trusted folder", async () => {
    const model = new FakeModel([[textChunk("ok")]]);
    const { agent } = session(model);
    await run(agent, "Hi.");
    expect(model.requests[0]!.messages[0]!.content).toContain("Run the tests with `npm test`.");
    expect(agent.snapshot({ available: true, reason: null }).contextFiles).toEqual(["MATTERWAVE.md"]);
  });

  it("is greyed out with a reason: untrusted, no tools on the model, the org's switch", () => {
    const untrusted = session(new FakeModel([]), { workspace: () => ({ roots: [{ name: "ws", path: ws.root }], trusted: false }) }).agent;
    expect(untrusted.availability({ signedIn: true, model: null, localAgentTools: true }).reason).toContain("untrusted workspace");
    const { agent } = session(new FakeModel([]));
    expect(agent.availability({ signedIn: true, model: { label: "GRT Tiny", supports_tools: false }, localAgentTools: true })).toEqual({
      available: false,
      reason: "GRT Tiny cannot call tools. Pick a model that can to use the agent.",
    });
    expect(agent.availability({ signedIn: true, model: null, localAgentTools: false }).reason).toBe("Your organisation has turned off local agent tools.");
    // A missing field is allowed.
    expect(agent.availability({ signedIn: true, model: { label: "GRT", supports_tools: null }, localAgentTools: null }).available).toBe(true);
  });

  it("keeps the run's history for /resume, so a new session continues with the earlier tool rounds in context", async () => {
    const first = new FakeModel([[callChunk("call_1", "read_file", { path: "src/other.ts" })], [textChunk("c is 3.")]]);
    const { agent, state } = session(first);
    await run(agent, "What is c?");
    expect(agent.resumable()).toMatchObject([{ conversationId: "c_1", title: "What is c?" }]);
    const second = new FakeModel([[textChunk("Still 3.")]]);
    const resumed = new AgentSession({
      client: second,
      review: new FakeReview(),
      confirmYolo: async () => false,
      settings: () => SETTINGS,
      workspace: () => ({ roots: [{ name: "ws", path: ws.root }], trusted: true }),
      state,
      home: home.root,
      onChange: () => undefined,
    });
    expect(resumed.hasHistory("c_1")).toBe(true);
    await run(resumed, "And now?");
    const sent = second.requests[0]!.messages;
    expect(sent.some((m) => m.role === "tool" && m.content.includes("export const c = 3;"))).toBe(true);
    expect(sent.at(-1)).toMatchObject({ role: "user", content: "And now?" });
  });

  it("/restore after two applied edits brings both files back to their pre-edit bytes; the project's .git is untouched", async () => {
    execFileSync("git", ["init", "-q"], { cwd: ws.root });
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "add", "."], { cwd: ws.root });
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: ws.root });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ws.root, encoding: "utf8" });
    const indexHash = () => createHash("sha256").update(readFileSync(join(ws.root, ".git", "index"))).digest("hex");
    const index = indexHash();
    const before = { app: read("src/app.ts"), other: read("src/other.ts") };

    const rows: Checkpoint[] = [];
    const model = new FakeModel([
      [callChunk("e1", "edit", EDIT)],
      [callChunk("e2", "edit", { path: "src/other.ts", old_string: "c = 3", new_string: "c = 4" })],
      [textChunk("Both changed.")],
    ]);
    const { agent } = session(model, {
      checkpoint: async (conversationId, relative, content) => {
        rows.unshift({ id: `cp${rows.length}`, conversationId, path: relative, content, createdAt: new Date().toISOString(), label: "Agent edit" });
      },
    });
    await agent.setMode("auto-edit");
    await run(agent, "Change both.");
    expect(read("src/app.ts").toString()).toContain("b = 3");
    expect(read("src/other.ts").toString()).toContain("c = 4");

    // Restore to before the first of the two: both files come back.
    const plan = restorePlan(rows, rows.at(-1)!.id);
    expect(plan.map((p) => p.path)).toEqual(["src/app.ts", "src/other.ts"]);
    for (const step of plan) writeFileSync(join(ws.root, ...step.path.split("/")), step.content!);
    expect(read("src/app.ts").equals(before.app)).toBe(true);
    expect(read("src/other.ts").equals(before.other)).toBe(true);
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: ws.root, encoding: "utf8" })).toBe(head);
    expect(indexHash()).toBe(index);
  });
});
