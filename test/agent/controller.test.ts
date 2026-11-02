import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { MatterWaveClient } from "../../src/api/client";
import { TokenStore } from "../../src/auth/session";
import { AgentSession, type AgentSessionDeps } from "../../src/agent/session";
import { ChatController, type StatusInfo } from "../../src/chat/controller";
import type { HostMessage, ViewState } from "../../src/chat/protocol";
import { STREAM_ERROR_COPY } from "../../src/streamErrors";
import { CONVERSATION, MODELS, fakeFetch, json, sse, type Call } from "../fakeApi";
import { MemorySecrets } from "../vscode-mock";
import { FakeReview, MemoryState, callChunk, textChunk, until, usageChunk, workspace } from "./helpers";

/**
 * Agent mode through the chat controller and the real API client, over HTTP
 * to a scripted `/v1`: what the requests carry, how a run shows in the
 * transcript, and the chat's own copy for a budget refusal.
 */

const TOKEN = "mw_abcdefgh_SECRET";
let ws: ReturnType<typeof workspace>;

beforeEach(() => {
  ws = workspace({ "src/app.ts": "export const a = 1;\n" });
});

afterEach(() => ws.cleanup());

function v1(chunks: object[]): Response {
  return sse(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`, 13);
}

const MODELS_WITH_TOOLS = {
  ...MODELS,
  data: [
    { ...MODELS.data[0], supports_tools: true },
    { id: "grt-tiny", label: "GRT Tiny", included: true, upgrade_to: null, partner: false, research_preview: false, supports_vision: false, supports_tools: false, context_window: 8192 },
  ],
};

async function setup(v1Steps: ((call: Call) => Response)[], over: { me?: Record<string, unknown>; models?: unknown; session?: Partial<AgentSessionDeps> } = {}) {
  const secrets = new MemorySecrets();
  const tokens = new TokenStore(secrets as unknown as vscode.SecretStorage, () => "https://mw.test");
  await tokens.set(TOKEN);
  const steps = [...v1Steps];
  const fake = fakeFetch({
    "GET /api/me": () => json({ subject: "u1", kind: "user", email: "ada@example.com", name: "Ada", org_name: "Acme", ...over.me }),
    "GET /api/models": () => json(over.models ?? MODELS_WITH_TOOLS),
    "GET /api/conversations": () => json({ data: [], filter: "default" }),
    "POST /api/conversations": () => json(CONVERSATION, 201),
    "GET /api/conversations/c_1/context": () => json({ model: "grt-small", context_window: 32768, used_tokens: 10, compactable: false }),
    "POST /v1/chat/completions": (call) => (steps.shift() ?? (() => v1([textChunk("done")])))(call),
  });
  const client = new MatterWaveClient({ baseUrl: "https://mw.test", getToken: () => tokens.get(), fetch: fake.fetch });
  const posted: HostMessage[] = [];
  const statuses: StatusInfo[] = [];
  const runCommands: string[] = [];
  const review = new FakeReview();
  const agent: AgentSession = new AgentSession({
    client,
    review,
    confirmYolo: async () => false,
    settings: () => ({ maxSteps: 10, maxTokens: 1_000_000, defaultMode: "ask", webFetch: false, editorContext: false }),
    workspace: () => ({ roots: [{ name: "ws", path: ws.root }], trusted: true }),
    state: new MemoryState(),
    home: ws.root,
    onChange: () => controller.emit(),
    ...over.session,
  });
  const controller: ChatController = new ChatController({
    client,
    agent,
    post: (message) => void posted.push(structuredClone(message)),
    isSignedIn: async () => true,
    rememberedModel: { get: () => null, set: () => undefined },
    runCommand: (command) => void runCommands.push(command),
    onStatus: (status) => void statuses.push(status),
  });
  await controller.refresh();
  return { controller, agent, review, posted, statuses, runCommands, v1Calls: () => fake.calls.filter((c) => c.url === "/v1/chat/completions") };
}

function last(posted: HostMessage[]): ViewState {
  const states = posted.filter((m): m is Extract<HostMessage, { type: "state" }> => m.type === "state");
  return states.at(-1)!.state;
}

describe("agent mode in the chat", () => {
  it("sends plan mode's read tools to /v1 with the conversation, and shows the run as a turn with its tool parts", async () => {
    const { controller, agent, posted, v1Calls, statuses } = await setup([
      () => v1([callChunk("call_1", "read_file", { path: "src/app.ts" }), usageChunk(100, 10)]),
      () => v1([textChunk("It exports a."), usageChunk(150, 5)]),
    ]);
    await controller.toggleAgent(true);
    await agent.setMode("plan");
    await controller.send("What does app.ts export?");

    const calls = v1Calls();
    expect(calls).toHaveLength(2);
    const body = JSON.parse(String(calls[0]!.body));
    expect(body.stream).toBe(true);
    expect(body.metadata).toEqual({ conversation_id: "c_1" });
    expect(body.model).toBe("grt-small");
    expect(body.tools.map((t: { function: { name: string } }) => t.function.name).sort()).toEqual(["glob", "grep", "list_dir", "read_file", "todo_write"]);
    // The second step carries the first's call and its result.
    const second = JSON.parse(String(calls[1]!.body)).messages;
    expect(second.at(-2).tool_calls[0].function.name).toBe("read_file");
    expect(second.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_1" });
    expect(second.at(-1).content).toContain("1\texport const a = 1;");
    expect(calls.every((c) => c.headers.Authorization === `Bearer ${TOKEN}`)).toBe(true);

    const state = last(posted);
    expect(state.streaming).toBe(false);
    const roles = state.transcript.map((e) => e.message.role);
    expect(roles).toEqual(["user", "assistant"]);
    expect(state.transcript[1]!.message.parts.map((p) => p.type)).toEqual(["tool_call", "tool_result", "text"]);
    expect(state.notice).toContain("Agent run: 2 steps, 1 tool call, 265 tokens");
    expect(state.agent).toMatchObject({ enabled: true, available: true, mode: "plan", root: { name: "ws", path: ws.root } });
    expect(statuses.at(-1)!.agentMode).toBe("plan");
    // The credential never crosses into the view.
    expect(JSON.stringify(posted)).not.toContain(TOKEN);
  });

  it("ends a run on a 402 with the chat's budget copy and the request's reference", async () => {
    const { controller, posted } = await setup([
      () => json({ error: { message: "Payment required", type: "billing", code: "plan_budget" } }, 402, { "X-Request-Id": "req-402" }),
    ]);
    await controller.toggleAgent(true);
    await controller.send("Do it.");
    const state = last(posted);
    expect(state.error).toEqual({ ...STREAM_ERROR_COPY.budget, requestId: "req-402" });
    expect(state.streaming).toBe(false);
  });

  it("reads a 429 insufficient_quota (the API's spent budget) as the budget state too", async () => {
    const { controller, posted } = await setup([
      () => json({ error: { message: "Your organisation's monthly token budget is used up", type: "insufficient_quota", code: "insufficient_quota" } }, 429, { "X-Request-Id": "req-429" }),
    ]);
    await controller.toggleAgent(true);
    await controller.send("Do it.");
    expect(last(posted).error).toEqual({ ...STREAM_ERROR_COPY.budget, requestId: "req-429" });
  });

  it("ends a run on an error inside the stream, keeping what arrived", async () => {
    const { controller, posted } = await setup([
      () => sse(`data: ${JSON.stringify(textChunk("Starting"))}\n\ndata: ${JSON.stringify({ error: { message: "Lost the connection to the model gateway", code: "upstream_error" } })}\n\n`),
    ]);
    await controller.toggleAgent(true);
    await controller.send("Go.");
    const state = last(posted);
    expect(state.error?.title).toBe(STREAM_ERROR_COPY.gateway.title);
    expect(state.transcript.at(-1)!.message.truncated).toBe(true);
  });

  it("greys the toggle out with a reason for a model that cannot call tools, and for an org that turned local tools off", async () => {
    const tiny = await setup([], { models: { ...MODELS_WITH_TOOLS, default_model: "grt-tiny" } });
    await tiny.controller.toggleAgent(true);
    expect(last(tiny.posted).agent).toMatchObject({ enabled: false, available: false, reason: "GRT Tiny cannot call tools. Pick a model that can to use the agent." });
    const off = await setup([], { me: { local_agent_tools: false } });
    await off.controller.toggleAgent(true);
    expect(last(off.posted).agent).toMatchObject({ available: false, reason: "Your organisation has turned off local agent tools." });
    expect(last(off.posted).notice).toBe("Your organisation has turned off local agent tools.");
  });

  it("Stop ends the run while an approval waits, and the file stays as it was", async () => {
    const { controller, agent, posted } = await setup([() => v1([callChunk("call_1", "write_file", { path: "new.txt", content: "x" })])]);
    await controller.toggleAgent(true);
    const running = controller.send("Write a file.");
    await until(() => agent.pendingId() !== null);
    expect(last(posted).agent!.pending).toMatchObject({ kind: "edit", path: "new.txt", title: "Create new.txt" });
    await controller.handle({ type: "stop" });
    await running;
    expect(last(posted).notice).toMatch(/^Stopped\. Agent run: 1 step/);
    expect(last(posted).agent!.pending).toBeNull();
  });
});

describe("slash commands in the composer", () => {
  it("/approval-mode sets the mode, /help lists the commands, /context reports the agent's context", async () => {
    const { controller, agent, posted, runCommands } = await setup([]);
    await controller.toggleAgent(true);
    await controller.send("/approval-mode auto-edit");
    expect(agent.mode).toBe("auto-edit");
    expect(last(posted).notice).toBe("Approval mode: auto-edit.");
    await controller.send("/approval-mode yolo");
    expect(agent.mode).toBe("auto-edit");
    expect(last(posted).notice).toBe("Kept auto-edit: yolo was not confirmed.");
    await controller.send("/approval-mode");
    expect(runCommands).toContain("agentPickMode");
    await controller.send("/help");
    for (const name of ["/help", "/model", "/approval-mode", "/compact", "/context", "/restore", "/init", "/resume"]) {
      expect(last(posted).notice).toContain(name);
    }
    await controller.send("/context");
    expect(last(posted).notice).toContain("Mode auto-edit; root");
    await controller.send("/restore");
    await controller.send("/resume");
    expect(runCommands).toEqual(expect.arrayContaining(["restoreCheckpoint", "agentResume"]));
  });

  it("/init runs the agent with the draft-MATTERWAVE.md prompt", async () => {
    const { controller, v1Calls } = await setup([() => v1([textChunk("Here is a draft.")])]);
    await controller.send("/init");
    const body = JSON.parse(String(v1Calls()[0]!.body));
    expect(body.messages.at(-1).content).toContain("draft a MATTERWAVE.md at the workspace root");
  });
});

describe("the chat stream's compacting frame", () => {
  it("shows the server's sentence while it folds earlier turns before the answer", async () => {
    const turn = [
      "event: compacting",
      'data: {"detail": "Summarising earlier turns to fit the model\'s context window"}',
      "",
      "event: message",
      'data: {"id": "m_user", "conversation_id": "c_1", "role": "user", "parts": [{"type": "text", "text": "Hi"}], "content": "Hi", "created_at": "2026-10-18T10:00:00+00:00", "parent_id": null, "model": null, "truncated": false}',
      "",
      "event: done",
      'data: {"id": "m_a", "conversation_id": "c_1", "role": "assistant", "parts": [{"type": "text", "text": "Hello"}], "content": "Hello", "created_at": "2026-10-18T10:00:00+00:00", "parent_id": "m_user", "model": "grt-small", "truncated": false}',
      "",
      "",
    ].join("\n");
    const secrets = new MemorySecrets();
    const tokens = new TokenStore(secrets as unknown as vscode.SecretStorage, () => "https://mw.test");
    await tokens.set(TOKEN);
    const fake = fakeFetch({
      "GET /api/me": () => json({ subject: "u1", kind: "user", email: null, name: "Ada" }),
      "GET /api/models": () => json(MODELS),
      "GET /api/conversations": () => json({ data: [], filter: "default" }),
      "POST /api/conversations": () => json(CONVERSATION, 201),
      "POST /api/conversations/c_1/messages": () => sse(turn),
    });
    const client = new MatterWaveClient({ baseUrl: "https://mw.test", getToken: () => tokens.get(), fetch: fake.fetch });
    const posted: HostMessage[] = [];
    const controller = new ChatController({
      client,
      post: (message) => void posted.push(structuredClone(message)),
      isSignedIn: async () => true,
      rememberedModel: { get: () => null, set: () => undefined },
      runCommand: () => undefined,
    });
    await controller.refresh();
    await controller.send("Hi");
    const notices = posted.filter((m): m is Extract<HostMessage, { type: "state" }> => m.type === "state").map((m) => m.state.notice);
    expect(notices).toContain("Summarising earlier turns to fit the model's context window");
  });
});
