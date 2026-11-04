import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import {
  activate,
  browseConnectors,
  exportsFor,
  inspectRunDecisionTrail,
  planToolsCommand,
  replayRunCommand,
  resumeRunCheckpointCommand,
  showReliabilityMetrics,
  type MatterWaveApi,
} from "../src/extension";
import type { Memento } from "../src/promptLibrary";
import { commands, ExtensionMode, FakeWebview, MemorySecrets, Uri, window, workspace } from "./vscode-mock";

function fakeMemento(): Memento & { synced: string[]; setKeysForSync(keys: readonly string[]): void } {
  const values = new Map<string, unknown>();
  const synced: string[] = [];
  return {
    synced,
    setKeysForSync(keys: readonly string[]) {
      synced.splice(0, synced.length, ...keys);
    },
    get<T>(key: string): T | undefined {
      return values.get(key) as T | undefined;
    },
    update(key: string, value: unknown): Promise<void> {
      values.set(key, value);
      return Promise.resolve();
    },
  };
}

function contextIn(mode: ExtensionMode): vscode.ExtensionContext {
  return {
    extensionMode: mode,
    extensionUri: Uri.file("/ext"),
    globalStorageUri: Uri.file("/storage"),
    secrets: new MemorySecrets(),
    globalState: fakeMemento(),
    workspaceState: fakeMemento(),
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

beforeEach(() => {
  commands.registered.clear();
  workspace.settings.clear();
  // A configured server keeps the first-run prompt out of these runs.
  workspace.settings.set("matterwave.baseUrl", "https://mw.test");
});

describe("activation", () => {
  it("asks nothing while activating, and asks for the server when the chat view first opens", async () => {
    workspace.settings.delete("matterwave.baseUrl");
    window.inputBoxes.length = 0;
    activate(contextIn(ExtensionMode.Production));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.inputBoxes).toEqual([]);

    const view = window.viewProviders["matterwave.chat"] as { resolveWebviewView(view: unknown): void };
    view.resolveWebviewView({ webview: new FakeWebview(), onDidDispose: () => ({ dispose() {} }), show() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.inputBoxes).toEqual(["MatterWave server"]);
  });

  it("lets Settings Sync carry the prompt library and the picked model, and nothing machine-bound", () => {
    const context = contextIn(ExtensionMode.Production);
    activate(context);
    expect((context.globalState as unknown as { synced: string[] }).synced).toEqual(["matterwave.prompts", "matterwave.model"]);
  });

  it("has a command to open the chat and one to show the request log", () => {
    activate(contextIn(ExtensionMode.Production));
    expect(commands.registered.has("matterwave.openChat")).toBe(true);
    expect(commands.registered.has("matterwave.choosePreset")).toBe(true);
    expect(commands.registered.has("matterwave.showLog")).toBe(true);
    expect(commands.registered.has("matterwave.listConnectors")).toBe(true);
    expect(commands.registered.has("matterwave.inspectRunDecisionTrail")).toBe(true);
    expect(commands.registered.has("matterwave.replayRun")).toBe(true);
    expect(commands.registered.has("matterwave.resumeRunCheckpoint")).toBe(true);
    expect(commands.registered.has("matterwave.showReliabilityMetrics")).toBe(true);
    expect(commands.registered.has("matterwave.planTools")).toBe(true);
    expect(window.channels.map((channel) => channel.name)).toContain("MatterWave");
  });

  it("executes connector catalog, decision trail, replay, checkpoint resume, reliability, and tool planning commands", async () => {
    window.shown.length = 0;

    const connectors = await browseConnectors(
      {
        listConnectorCatalog: async () => ({
          data: [
            {
              provider_id: "slack",
              name: "Slack",
              category: "communication",
              auth_types: ["oauth2"],
              authorize_url: "https://slack.com/oauth/v2/authorize",
              token_url: "https://slack.com/api/oauth.v2.access",
              api_base_url: "https://slack.com/api",
              default_scopes: ["chat:write"],
              pkce_supported: true,
              refresh_supported: true,
              revoke_url: "https://slack.com/api/auth.revoke",
              docs_url: "https://api.slack.com",
              icon: "slack",
            },
          ],
          total: 1,
        }),
      },
      { category: "communication", q: "slack" },
    );
    expect(connectors?.total).toBe(1);

    const trail = await inspectRunDecisionTrail(
      {
        getRunDecisionTrail: async (runId: string) => ({
          run_id: runId,
          org: "org_1",
          nodes: [
            {
              id: "node_1",
              type: "tool_call",
              label: "read_file",
              step_id: "step_1",
              timestamp: "2026-11-01T00:00:00Z",
              duration_ms: 15,
              confidence: 0.99,
              tokens_used: 120,
              cost_usd: 0.001,
              outcome: "success",
              rationale: "Read file",
              evidence: [],
              metadata: {},
            },
          ],
          edges: [],
          statistics: {
            total_nodes: 1,
            total_edges: 0,
            tool_calls_count: 1,
            total_tokens: 120,
            total_cost_usd: 0.001,
            duration_ms: 15,
            success: true,
          },
        }),
      },
      { runId: "run_abc" },
    );
    expect(trail?.statistics.total_nodes).toBe(1);

    const replay = await replayRunCommand(
      {
        replayRun: async (runId, mode) => ({
          replay_id: "replay_xyz",
          run_id: runId,
          mode: String(mode ?? "simulated"),
          success: true,
          original_outcome: {},
          replayed_outcome: {},
          differences: [],
          duration_ms: 25,
          created_at: "2026-11-01T00:00:00Z",
        }),
      },
      { runId: "run_abc", mode: "simulated" },
    );
    expect(replay?.replay_id).toBe("replay_xyz");

    const resumed = await resumeRunCheckpointCommand(
      {
        listRunCheckpoints: async (runId: string) => ({
          run_id: runId,
          data: [],
        }),
        resumeRun: async (runId: string, checkpointId?: string) => ({
          run_id: "run_resumed_1",
          source_run_id: runId,
          resumed_from_checkpoint_id: checkpointId ?? "cp_1",
          resumed_from_step: "step_3",
          state: "running",
          restored_state: {},
          created_at: "2026-11-01T00:00:00Z",
        }),
      },
      { runId: "run_abc", checkpointId: "cp_3" },
    );
    expect(resumed?.run_id).toBe("run_resumed_1");

    const metrics = await showReliabilityMetrics(
      {
        getReliabilityMetrics: async (agentId) => ({
          org: "org_1",
          agent_id: typeof agentId === "string" ? agentId : null,
          sr: 0.916,
          cr: 1.0,
          pc: 0.0085,
          hir: 0.05,
          ma: 0.95,
          tcl: 35,
          wct: 980,
          total_runs: 12,
          window: "24h",
        }),
      },
      { agentId: "agent_coder" },
    );
    expect(metrics?.total_runs).toBe(12);

    const plan = await planToolsCommand(
      {
        planTools: async (goal: string, availableTools?: string[]) => ({
          plan_id: "plan_99",
          task: goal,
          steps: [
            {
              step_id: "s1",
              tool_name: availableTools?.[0] ?? "grep",
              description: "Search codebase",
              arguments: { pattern: "TODO" },
              depends_on: [],
              estimated_cost_usd: 0.001,
              estimated_time_ms: 100,
              fallback_tool: null,
            },
          ],
          execution_order: [["s1"]],
          total_estimated_cost_usd: 0.001,
          total_estimated_time_ms: 100,
          confidence: 0.95,
        }),
      },
      { goal: "Find TODO items", availableTools: ["grep"] },
    );
    expect(plan?.plan_id).toBe("plan_99");
    expect(window.shown.length).toBeGreaterThanOrEqual(6);
  });
});

describe("the extension's exports", () => {
  it("exports nothing in a production host, so no other extension can reach the chat", () => {
    const exported = activate(contextIn(ExtensionMode.Production));
    expect(exported).toBeUndefined();
    // The extension itself still came up: its commands are there.
    expect(commands.registered.has("matterwave.newChat")).toBe(true);
  });

  it("exports nothing in a development host either", () => {
    expect(activate(contextIn(ExtensionMode.Development))).toBeUndefined();
  });

  it("exports the chat seam under the test runner", () => {
    const exported = activate(contextIn(ExtensionMode.Test));
    expect(exported?.chat).toBeDefined();
    expect(typeof exported?.onHostMessage).toBe("function");
  });

  it("decides by the mode alone", () => {
    const api = {} as MatterWaveApi;
    expect(exportsFor(vscode.ExtensionMode.Production, api)).toBeUndefined();
    expect(exportsFor(vscode.ExtensionMode.Development, api)).toBeUndefined();
    expect(exportsFor(vscode.ExtensionMode.Test, api)).toBe(api);
  });
});
