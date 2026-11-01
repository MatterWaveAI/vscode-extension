import { afterEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { MCP_PROVIDER_ID, mcpProvider, registerMcpServer, type McpDeps, type McpHttpDefinition } from "../src/mcp";
import * as mock from "./vscode-mock";

class Definition implements McpHttpDefinition {
  constructor(
    readonly label: string,
    readonly uri: vscode.Uri,
    public headers: Record<string, string> = {},
    readonly version?: string,
  ) {}
}

function deps(token: string | null, base = "https://mw.test/"): McpDeps {
  return { baseUrl: () => base, getToken: async () => token, version: "0.3.0", onDidChange: new mock.EventEmitter<void>().event };
}

describe("the MCP server definition", () => {
  it("names the deployment's /mcp while signed in, with no credential in the definition", async () => {
    const [server] = await mcpProvider(deps("mw_abcdefgh_key"), Definition).provideMcpServerDefinitions();
    expect(server).toMatchObject({ label: "MatterWave", headers: {}, version: "0.3.0" });
    expect(server?.uri.toString()).toBe("https://mw.test/mcp");
  });

  it("offers nothing while signed out", async () => {
    expect(await mcpProvider(deps(null), Definition).provideMcpServerDefinitions()).toEqual([]);
  });

  it("adds the bearer only when VS Code starts the server, and starts nothing once signed out", async () => {
    const server = new Definition("MatterWave", vscode.Uri.parse("https://mw.test/mcp"));
    const resolved = await mcpProvider(deps("mw_abcdefgh_key"), Definition).resolveMcpServerDefinition(server);
    expect(resolved?.headers).toEqual({ Authorization: "Bearer mw_abcdefgh_key" });
    expect(await mcpProvider(deps(null), Definition).resolveMcpServerDefinition(server)).toBeUndefined();
  });
});

describe("registerMcpServer", () => {
  const editor = mock as unknown as Record<string, unknown>;
  afterEach(() => {
    delete editor.lm;
    delete editor.McpHttpServerDefinition;
  });

  it("registers nothing in an editor without the API", () => {
    expect(registerMcpServer(deps("k"))).toBeUndefined();
  });

  it("registers the provider under its id where the editor has the API", async () => {
    const registered: { id: string; provider: unknown }[] = [];
    editor.lm = { registerMcpServerDefinitionProvider: (id: string, provider: unknown) => (registered.push({ id, provider }), { dispose() {} }) };
    editor.McpHttpServerDefinition = Definition;
    expect(registerMcpServer(deps("k"))).toBeDefined();
    expect(registered[0]?.id).toBe(MCP_PROVIDER_ID);
  });
});
