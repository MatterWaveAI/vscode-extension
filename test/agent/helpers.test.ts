import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FOLDED_PREFIX, SUMMARY_LEAD, compactHistory, foldToolOutput, tailStart } from "../../src/agent/compaction";
import { loadProjectContext } from "../../src/agent/contextFiles";
import { definitionDirs, expandCommand, loadCustomCommands, parseFrontMatter } from "../../src/agent/definitions";
import { webFetchDecision } from "../../src/agent/extraTools";
import { IgnoreRules, globMatcher } from "../../src/agent/ignore";
import { mcpDecision, mcpToolName } from "../../src/agent/mcp";
import { buildPromptContext, parsePathMentions } from "../../src/agent/promptContext";
import { StepAccumulator, type ChatMessage } from "../../src/agent/wire";
import { restorePlan, type Checkpoint } from "../../src/checkpoints";
import { workspace } from "./helpers";

let ws: ReturnType<typeof workspace>;

beforeEach(() => {
  ws = workspace({
    "src/app.ts": "export const a = 1;\n",
    ".env": "SECRET=1\n",
    "MATTERWAVE.md": "Use pnpm.\n",
    "AGENTS.md": "Write tests first.\n",
    "MATTERWAVE.local.md": "I like short answers.\n",
  });
});

afterEach(() => ws.cleanup());

describe("the step accumulator", () => {
  it("joins text and tool-call fragments by index, and keeps the usage", () => {
    const acc = new StepAccumulator();
    expect(acc.add({ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] })).toBe("");
    expect(acc.add({ choices: [{ index: 0, delta: { content: "Look" } }] })).toBe("Look");
    acc.add({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "read_", arguments: '{"pa' } }] } }] });
    acc.add({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "file", arguments: 'th":"x"}' } }] } }] });
    acc.add({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "call_b", function: { name: "glob", arguments: "{}" } }] } }] });
    acc.add({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    acc.add({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    expect(acc.result()).toEqual({
      text: "Look",
      toolCalls: [
        { id: "call_a", type: "function", function: { name: "read_file", arguments: '{"path":"x"}' } },
        { id: "call_b", type: "function", function: { name: "glob", arguments: "{}" } },
      ],
      finishReason: "tool_calls",
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  });
});

describe("compaction", () => {
  function round(n: number, output: string): ChatMessage[] {
    return [
      { role: "assistant", content: null, tool_calls: [{ id: `c${n}`, type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: `c${n}`, content: output },
    ];
  }

  it("folds tool output older than the latest rounds, leaving the recent and the short alone", () => {
    const big = `first line\n${"x".repeat(2_000)}`;
    const history: ChatMessage[] = [{ role: "user", content: "go" }, ...round(1, big), ...round(2, "short"), ...round(3, big), ...round(4, big)];
    expect(foldToolOutput(history, 2)).toBe(1);
    expect((history[2] as { content: string }).content.startsWith(FOLDED_PREFIX)).toBe(true);
    expect((history[2] as { content: string }).content).toContain('it began "first line"');
    expect((history[4] as { content: string }).content).toBe("short");
    expect((history[6] as { content: string }).content).toBe(big);
    expect(foldToolOutput(history, 2)).toBe(0);
  });

  it("never starts the kept tail on a tool result", () => {
    const history: ChatMessage[] = [{ role: "user", content: "go" }, ...round(1, "a"), ...round(2, "b")];
    expect(history[tailStart(history, 1)]!.role).toBe("assistant");
  });

  it("folds first, then summarises what is older, when the history outgrows the window", async () => {
    const big = "y".repeat(8_000);
    const history: ChatMessage[] = [{ role: "user", content: "task" }];
    for (let n = 1; n <= 8; n++) history.push(...round(n, big));
    history.push({ role: "user", content: "next" });
    const summarised: number[] = [];
    const result = await compactHistory(history, { contextWindow: 4_000 }, async (older) => {
      summarised.push(older.length);
      return "Read eight files.";
    });
    expect(result.folded).toBeGreaterThan(0);
    expect(result.summarised).toBe(true);
    expect(summarised).toHaveLength(1);
    expect(history[0]).toEqual({ role: "user", content: `${SUMMARY_LEAD}\n\nRead eight files.` });
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
    expect(history.at(-1)).toEqual({ role: "user", content: "next" });
    // No tool result is left without the call it answers.
    for (let i = 0; i < history.length; i++) if (history[i]!.role === "tool") expect(history[i - 1]!.role).toMatch(/assistant|tool/);
  });

  it("leaves a small history alone", async () => {
    const history: ChatMessage[] = [{ role: "user", content: "hi" }];
    const result = await compactHistory(history, { contextWindow: 100_000 }, async () => "never");
    expect(result).toMatchObject({ folded: 0, summarised: false });
  });
});

describe("the project's notes", () => {
  it("load in a trusted folder: MATTERWAVE.md, AGENTS.md and the personal override", async () => {
    const context = await loadProjectContext(ws.root, { trusted: true, userFile: null });
    expect(context.files).toEqual(["MATTERWAVE.md", "AGENTS.md", "MATTERWAVE.local.md"]);
    expect(context.text).toContain("Use pnpm.");
    expect(context.text).toContain("Write tests first.");
    expect(context.text).toContain("your personal notes for this project, which take precedence");
    expect(context.notice).toBeNull();
  });

  it("are ignored, with a notice, in an untrusted folder", async () => {
    const context = await loadProjectContext(ws.root, { trusted: false, userFile: null });
    expect(context.text).toBeNull();
    expect(context.files).toEqual([]);
    expect(context.notice).toBe(
      "MATTERWAVE.md and AGENTS.md and MATTERWAVE.local.md were not loaded: this folder is not trusted. Trust it (Workspaces: Manage Workspace Trust) to use the project's notes.",
    );
  });
});

describe("@path mentions and the editor's context", () => {
  it("finds paths, not provider mentions or email addresses", () => {
    expect(parsePathMentions("look at @src/app.ts, @README.md and @file; mail a@b.com (@./x)")).toEqual(["src/app.ts", "README.md", "./x"]);
  });

  it("attaches mentioned files and refuses a denied one by the confinement's rule", async () => {
    const built = await buildPromptContext(ws.root, "Compare @src/app.ts with @.env and @missing.ts", null);
    expect(built.attached).toEqual(["src/app.ts"]);
    expect(built.content).toContain("export const a = 1;");
    expect(built.content).not.toContain("SECRET");
    expect(built.notes[0]).toContain("@.env was not attached. Refused: .env is protected");
    expect(built.notes[1]).toContain("@missing.ts was not attached");
  });

  it("adds the active file, the selection and recent files, never from a denied file or outside the root", async () => {
    const built = await buildPromptContext(ws.root, "Fix it", {
      activeFile: { absolute: join(ws.root, "src", "app.ts"), line: 1 },
      selection: { absolute: join(ws.root, ".env"), startLine: 1, endLine: 1, text: "SECRET=1", languageId: "dotenv" },
      recentFiles: [join(ws.root, "src", "app.ts"), join(ws.root, "MATTERWAVE.md"), "/elsewhere/x.ts"],
    });
    expect(built.content).toContain("Active file: src/app.ts, line 1");
    expect(built.content).toContain("Recently opened: MATTERWAVE.md");
    expect(built.content).not.toContain("SECRET");
    expect(built.content).not.toContain("elsewhere");
  });
});

describe("custom commands and front matter", () => {
  it("parses key: value, [lists] and - item lists", () => {
    expect(parseFrontMatter("---\ndescription: Review it\ntools: [read_file, grep]\nmore:\n  - a\n  - b\n---\nBody $ARGUMENTS\n")).toEqual({
      meta: { description: "Review it", tools: ["read_file", "grep"], more: ["a", "b"] },
      body: "Body $ARGUMENTS",
    });
    expect(parseFrontMatter("No front matter")).toEqual({ meta: {}, body: "No front matter" });
  });

  it("loads the person's and a trusted workspace's commands, the workspace's winning", async () => {
    const home = workspace();
    try {
      mkdirSync(join(home.root, ".matterwave", "commands"), { recursive: true });
      writeFileSync(join(home.root, ".matterwave", "commands", "review.md"), "Review: $ARGUMENTS");
      writeFileSync(join(home.root, ".matterwave", "commands", "mine.md"), "---\ndescription: Mine\n---\nDo mine.");
      mkdirSync(join(ws.root, ".matterwave", "commands"), { recursive: true });
      writeFileSync(join(ws.root, ".matterwave", "commands", "review.md"), "Project review of {{args}}.");
      const trusted = await loadCustomCommands(definitionDirs("commands", ws.root, true, home.root));
      expect(trusted.map((c) => [c.name, c.scope])).toEqual([["mine", "user"], ["review", "workspace"]]);
      expect(expandCommand(trusted.find((c) => c.name === "review")!, "src/app.ts")).toBe("Project review of src/app.ts.");
      expect(expandCommand(trusted.find((c) => c.name === "mine")!, "now")).toBe("Do mine.\n\nnow");
      const untrusted = await loadCustomCommands(definitionDirs("commands", ws.root, false, home.root));
      expect(untrusted.find((c) => c.name === "review")!.scope).toBe("user");
    } finally {
      await home.cleanup();
    }
  });
});

describe("search ignore rules", () => {
  it("reads .gitignore: negation, folders only, anchoring, nested files", () => {
    const rules = IgnoreRules.empty(false).with("*.log\n!keep.log\nbuild/\n/root-only.txt\n", "").with("local.txt\n", "pkg");
    expect(rules.ignored("a.log", false)).toBe(true);
    expect(rules.ignored("keep.log", false)).toBe(false);
    expect(rules.ignored("build", true)).toBe(true);
    expect(rules.ignored("build", false)).toBe(false);
    expect(rules.ignored("root-only.txt", false)).toBe(true);
    expect(rules.ignored("sub/root-only.txt", false)).toBe(false);
    expect(rules.ignored("pkg/local.txt", false)).toBe(true);
    expect(rules.ignored("local.txt", false)).toBe(false);
  });

  it("matches a search glob by path, or by name when it has no slash", () => {
    expect(globMatcher("src/**/*.ts", false)("src/a/b.ts")).toBe(true);
    expect(globMatcher("*.ts", false)("deep/x.ts")).toBe(true);
    expect(globMatcher("src/*.ts", false)("src/a/b.ts")).toBe(false);
  });
});

describe("decisions outside the contract", () => {
  it("web fetch asks in ask and auto-edit, is off in plan, runs in yolo", () => {
    expect(["plan", "ask", "auto-edit", "yolo"].map((m) => webFetchDecision(m as "plan"))).toEqual(["deny", "ask", "ask", "allow"]);
  });

  it("an MCP tool that writes asks unless the server is trusted; a read-only one runs; plan offers reads only", () => {
    const write = { name: "w", description: "", inputSchema: {}, readOnly: false };
    const read = { ...write, readOnly: true };
    expect(mcpDecision(write, {}, "ask")).toBe("ask");
    expect(mcpDecision(write, {}, "auto-edit")).toBe("ask");
    expect(mcpDecision(write, { trust: true }, "ask")).toBe("allow");
    expect(mcpDecision(write, { trust: true }, "plan")).toBe("deny");
    expect(mcpDecision(read, { trust: true }, "plan")).toBe("allow");
    expect(mcpDecision(read, {}, "plan", true)).toBe("allow");
    expect(mcpDecision(read, {}, "ask", true)).toBe("allow");
    expect(mcpDecision(write, {}, "yolo")).toBe("allow");
    expect(mcpToolName("my server", "do.thing")).toBe("mcp__my_server__do_thing");
  });

  it("a read-only mark from a server whose hints are not trusted is not believed: it asks, and plan leaves it out", () => {
    const read = { name: "r", description: "", inputSchema: {}, readOnly: true };
    expect(mcpDecision(read, {}, "plan")).toBe("deny");
    expect(mcpDecision(read, {}, "ask")).toBe("ask");
    expect(mcpDecision(read, {}, "auto-edit")).toBe("ask");
    expect(mcpDecision(read, {}, "plan", false)).toBe("deny");
  });
});

describe("restore plans", () => {
  const row = (id: string, path: string, content: string | null): Checkpoint => ({ id, conversationId: "c", path, content, createdAt: "", label: "Agent edit" });

  it("restoring to before a change also takes back every later one, each file to its earliest content", () => {
    // Newest first: a.ts edited twice, b.ts once, c.ts created.
    const rows = [row("4", "c.ts", null), row("3", "a.ts", "a-v2"), row("2", "b.ts", "b-v1"), row("1", "a.ts", "a-v1")];
    expect(restorePlan(rows, "1")).toEqual([
      { path: "a.ts", content: "a-v1", label: "Agent edit" },
      { path: "b.ts", content: "b-v1", label: "Agent edit" },
      { path: "c.ts", content: null, label: "Agent edit" },
    ]);
    expect(restorePlan(rows, "3").map((p) => [p.path, p.content])).toEqual([["a.ts", "a-v2"], ["c.ts", null]]);
    expect(restorePlan(rows, "nope")).toEqual([]);
  });
});
