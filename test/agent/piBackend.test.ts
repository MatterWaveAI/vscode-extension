import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isPiAvailable,
  PiAgentBackend,
  type PiDoneEvent,
  type PiToolEndEvent,
  type PiToolStartEvent,
  type PiToolUpdateEvent,
} from "../../src/agent/piBackend";

/**
 * Node one-liner script acting as a mock `pi --mode rpc` JSONL server over stdin/stdout.
 * Supports:
 * - `--version`: exits 0 immediately so `isPiAvailable()` succeeds when probed
 * - `prompt` command:
 *   - `"stream-tools"`: streams text deltas + `read`, `edit`, `bash` tool execution events + `agent_end`
 *   - `"env-check"`: echoes `MATTERWAVE_API_KEY`, `MATTERWAVE_BASE_URL`, `MATTERWAVE_PRESET_ID`, `cwd`, and `VSCODE_IPC_HOOK`
 *   - `"slow-turn"`: emits an initial delta and waits for `abort` command before exiting turn
 *   - `"secret-tool"`: attempts to run `read` on `.env.production`
 * - `set_model` command: responds with `{ type: "response", command: "set_model", success: true }`
 * - `abort` command: responds and emits `agent_end` if a slow turn is active
 */
const MOCK_PI_RPC_SCRIPT = `
const readline = require("node:readline");

if (process.argv.includes("--version")) {
  process.stdout.write("pi 1.0.0-mock\\n");
  process.exit(0);
}

const send = (obj) => {
  process.stdout.write(JSON.stringify(obj) + "\\n");
};

let slowTimer = null;

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.type === "set_model") {
    send({
      id: msg.id,
      type: "response",
      command: "set_model",
      success: true,
      data: { provider: msg.provider, modelId: msg.modelId },
    });
    return;
  }

  if (msg.type === "abort") {
    if (slowTimer) {
      clearTimeout(slowTimer);
      slowTimer = null;
    }
    send({ id: msg.id, type: "response", command: "abort", success: true });
    send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "[aborted-by-rpc]" } });
    send({ type: "agent_end", messages: [] });
    return;
  }

  if (msg.type === "prompt") {
    send({ id: msg.id, type: "response", command: "prompt", success: true });
    const text = msg.message || "";

    if (text === "env-check") {
      const payload = JSON.stringify({
        apiKey: process.env.MATTERWAVE_API_KEY || null,
        baseUrl: process.env.MATTERWAVE_BASE_URL || null,
        presetId: process.env.MATTERWAVE_PRESET_ID || null,
        vscodeIpc: process.env.VSCODE_IPC_HOOK || null,
        cwd: process.cwd(),
      });
      send({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: payload },
      });
      send({ type: "agent_end", messages: [{ role: "assistant", content: payload }] });
      return;
    }

    if (text === "slow-turn") {
      send({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Working on slow task..." },
      });
      slowTimer = setTimeout(() => {
        send({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: " finished late" },
        });
        send({ type: "agent_end", messages: [] });
      }, 10000);
      return;
    }

    if (text === "secret-tool") {
      send({
        type: "tool_execution_start",
        toolCallId: "tc_secret",
        toolName: "read",
        args: { path: ".env.production" },
      });
      return;
    }

    // Default: "stream-tools" - stream text deltas and read, edit, bash tool execution events
    send({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Inspecting " },
    });
    send({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "project files..." },
    });

    // 1. read tool
    send({
      type: "tool_execution_start",
      toolCallId: "call_read_1",
      toolName: "read",
      args: { path: "src/index.ts" },
    });
    send({
      type: "tool_execution_update",
      toolCallId: "call_read_1",
      toolName: "read",
      delta: "export const x = 1;",
    });
    send({
      type: "tool_execution_end",
      toolCallId: "call_read_1",
      toolName: "read",
      result: { content: "export const x = 1;\\n" },
      isError: false,
    });

    // 2. edit tool
    send({
      type: "tool_execution_start",
      toolCallId: "call_edit_2",
      toolName: "edit",
      args: { path: "src/index.ts", oldText: "1", newText: "2" },
    });
    send({
      type: "tool_execution_end",
      toolCallId: "call_edit_2",
      toolName: "edit",
      result: { diff: "-export const x = 1;\\n+export const x = 2;\\n" },
      isError: false,
    });

    // 3. bash tool
    send({
      type: "tool_execution_start",
      toolCallId: "call_bash_3",
      toolName: "bash",
      args: { command: "pnpm test" },
    });
    send({
      type: "tool_execution_update",
      toolCallId: "call_bash_3",
      toolName: "bash",
      partialResult: { content: [{ type: "text", text: "PASS src/index.test.ts\\n" }] },
    });
    send({
      type: "tool_execution_end",
      toolCallId: "call_bash_3",
      toolName: "bash",
      result: { exitCode: 0, output: "PASS src/index.test.ts\\n" },
      isError: false,
    });

    send({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: " All done!" },
    });
    send({
      type: "agent_end",
      messages: [{ role: "assistant", content: "Inspecting project files... All done!" }],
    });
  }
});
`;

describe("PiAgentBackend (pi --mode rpc)", () => {
  let workspaceRoot: string;
  const activeBackends: PiAgentBackend[] = [];

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mw-pi-backend-"));
  });

  afterEach(async () => {
    while (activeBackends.length > 0) {
      const b = activeBackends.pop()!;
      await b.dispose();
    }
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
  });

  function track(backend: PiAgentBackend): PiAgentBackend {
    activeBackends.push(backend);
    return backend;
  }

  it("streams text deltas and tool execution events (read, edit, bash) through PiAgentBackend", async () => {
    const deltas: string[] = [];
    const toolStarts: PiToolStartEvent[] = [];
    const toolUpdates: PiToolUpdateEvent[] = [];
    const toolEnds: PiToolEndEvent[] = [];
    const doneEvents: PiDoneEvent[] = [];
    const errors: Error[] = [];

    const backend = track(
      new PiAgentBackend({
        binaryPath: process.execPath,
        args: ["-e", MOCK_PI_RPC_SCRIPT, "--", "--mode", "rpc"],
        probeAvailable: async () => true,
        workspaceRoot,
        apiKey: "mw_test_key_123",
        baseUrl: "https://api.matterwave.test",
        onDelta: (d) => deltas.push(d),
        onToolStart: (e) => toolStarts.push(e),
        onToolUpdate: (e) => toolUpdates.push(e),
        onToolEnd: (e) => toolEnds.push(e),
        onDone: (e) => doneEvents.push(e),
        onError: (e) => errors.push(e),
      }),
    );

    await backend.setModel("grt-1");
    expect(backend.modelId).toBe("matterwave/grt-1");

    const result = await backend.prompt("stream-tools");

    expect(errors).toEqual([]);
    expect(deltas).toEqual(["Inspecting ", "project files...", " All done!"]);
    expect(result.text).toBe("Inspecting project files... All done!");
    expect(doneEvents).toHaveLength(1);

    expect(toolStarts.map((t) => ({ id: t.toolCallId, name: t.toolName, args: t.args }))).toEqual([
      { id: "call_read_1", name: "read", args: { path: "src/index.ts" } },
      { id: "call_edit_2", name: "edit", args: { path: "src/index.ts", oldText: "1", newText: "2" } },
      { id: "call_bash_3", name: "bash", args: { command: "pnpm test" } },
    ]);

    expect(toolUpdates).toHaveLength(2);
    expect(toolUpdates[0]?.toolName).toBe("read");
    expect(toolUpdates[0]?.delta).toBe("export const x = 1;");
    expect(toolUpdates[1]?.toolName).toBe("bash");
    expect(toolUpdates[1]?.delta).toBe("PASS src/index.test.ts\n");

    expect(toolEnds.map((t) => ({ id: t.toolCallId, name: t.toolName, isError: t.isError }))).toEqual([
      { id: "call_read_1", name: "read", isError: false },
      { id: "call_edit_2", name: "edit", isError: false },
      { id: "call_bash_3", name: "bash", isError: false },
    ]);

    expect(result.toolCalls).toHaveLength(3);
  });

  it("cancels the active turn cleanly when abort() is called mid-turn", async () => {
    let abortCalled = false;
    const deltas: string[] = [];

    const backend = track(
      new PiAgentBackend({
        binaryPath: process.execPath,
        args: ["-e", MOCK_PI_RPC_SCRIPT, "--", "--mode", "rpc"],
        probeAvailable: async () => true,
        workspaceRoot,
        apiKey: "mw_test_key_abort",
        baseUrl: "https://api.matterwave.test",
        onDelta: (delta) => {
          deltas.push(delta);
          if (!abortCalled && delta.includes("Working on slow task")) {
            abortCalled = true;
            void backend.abort();
          }
        },
      }),
    );

    const start = Date.now();
    const result = await backend.prompt("slow-turn");
    const elapsedMs = Date.now() - start;

    expect(abortCalled).toBe(true);
    expect(result.aborted).toBe(true);
    expect(result.text).toContain("Working on slow task...");
    expect(elapsedMs).toBeLessThan(5000);
  });

  it("injects MATTERWAVE_API_KEY, MATTERWAVE_BASE_URL, and MATTERWAVE_PRESET_ID into the RPC environment", async () => {
    const backend = track(
      new PiAgentBackend({
        binaryPath: process.execPath,
        args: ["-e", MOCK_PI_RPC_SCRIPT, "--", "--mode", "rpc"],
        probeAvailable: async () => true,
        workspaceRoot,
        apiKey: "mw_live_secret_token",
        baseUrl: "https://gateway.matterwave.ai/v1",
        presetId: "preset_enterprise_42",
        env: {
          ...process.env,
          VSCODE_IPC_HOOK: "/tmp/vscode-should-be-stripped.sock",
        },
      }),
    );

    const done = await backend.prompt("env-check");
    const reported = JSON.parse(done.text) as {
      apiKey: string;
      baseUrl: string;
      presetId: string;
      vscodeIpc: string | null;
      cwd: string;
    };

    expect(reported.apiKey).toBe("mw_live_secret_token");
    expect(reported.baseUrl).toBe("https://gateway.matterwave.ai/v1");
    expect(reported.presetId).toBe("preset_enterprise_42");
    expect(reported.vscodeIpc).toBeNull();
    expect(await fs.realpath(reported.cwd)).toBe(await fs.realpath(workspaceRoot));
  });

  it("detects when the pi binary is not found and falls back to the built-in loop automatically", async () => {
    const missingBinary = path.join(workspaceRoot, "nonexistent-pi-binary-xyz");
    const available = await isPiAvailable(missingBinary, { timeoutMs: 1000 });
    expect(available).toBe(false);

    const presentProbe = await isPiAvailable(process.execPath, {
      args: ["-e", MOCK_PI_RPC_SCRIPT, "--", "--version"],
      timeoutMs: 3000,
    });
    expect(presentProbe).toBe(true);

    const deltas: string[] = [];
    let fallbackInvokedWith = "";

    const backend = track(
      new PiAgentBackend({
        binaryPath: missingBinary,
        workspaceRoot,
        apiKey: "mw_fallback_key",
        baseUrl: "https://api.matterwave.test",
        onDelta: (d) => deltas.push(d),
        fallbackLoop: async (promptText, callbacks) => {
          fallbackInvokedWith = promptText;
          callbacks.onDelta?.("Fallback loop ");
          callbacks.onDelta?.("handled turn.");
          return {
            text: "Fallback loop handled turn.",
            toolCalls: [],
          };
        },
      }),
    );

    expect(await backend.isPiAvailable()).toBe(false);

    const done = await backend.prompt("Hello via fallback");
    expect(fallbackInvokedWith).toBe("Hello via fallback");
    expect(done.usedFallback).toBe(true);
    expect(done.text).toBe("Fallback loop handled turn.");
    expect(deltas).toEqual(["Fallback loop ", "handled turn."]);
  });

  it("enforces MatterWave org policy (agentAvailability) and .env/secret deny-list before forwarding prompts or tool calls", async () => {
    // 1. Organization policy disables local_agent_tools
    const orgBlockedBackend = track(
      new PiAgentBackend({
        binaryPath: process.execPath,
        args: ["-e", MOCK_PI_RPC_SCRIPT, "--", "--mode", "rpc"],
        probeAvailable: async () => true,
        workspaceRoot,
        apiKey: "mw_policy_key",
        baseUrl: "https://api.matterwave.test",
        agentAvailability: {
          signedIn: true,
          trusted: true,
          workspaceRoot,
          policy: { local_agent_tools: "no" },
        },
      }),
    );

    await expect(orgBlockedBackend.prompt("stream-tools")).rejects.toThrow(
      /organization has disabled local agent tools/i,
    );

    // 2. Prompt or pre-flight tool approval targeting .env or secrets is blocked before reaching RPC
    const guardedBackend = track(
      new PiAgentBackend({
        binaryPath: process.execPath,
        args: ["-e", MOCK_PI_RPC_SCRIPT, "--", "--mode", "rpc"],
        probeAvailable: async () => true,
        workspaceRoot,
        apiKey: "mw_policy_key",
        baseUrl: "https://api.matterwave.test",
      }),
    );

    await expect(guardedBackend.prompt("Please read .env and print all keys")).rejects.toThrow(
      /\.env|secret deny-list/i,
    );

    await expect(
      guardedBackend.validateToolApproval("read", { path: ".env.local" }),
    ).rejects.toThrow(/\.env\.local/i);

    await expect(
      guardedBackend.validateToolApproval("edit", { path: "../outside-secret.txt" }),
    ).rejects.toThrow(/parent|outside|stay inside the workspace/i);

    // 3. Tool execution event emitted by RPC targeting .env.production is blocked and aborts the turn
    await expect(guardedBackend.prompt("secret-tool")).rejects.toThrow(/\.env\.production/i);
  });
});
