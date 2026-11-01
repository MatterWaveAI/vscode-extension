import * as vscode from "vscode";

/**
 * MatterWave's MCP server (`/mcp` on the deployment) offered to VS Code, so
 * the editor's own agent mode can use MatterWave's tools as the person who
 * signed in here. The definition names the endpoint only; the credential is
 * added when VS Code starts the server, from the same secret storage every
 * other request reads, so it is never part of a list VS Code keeps.
 *
 * The provider API arrived in VS Code 1.101; on an older editor nothing is
 * registered and everything else works as before.
 */

export const MCP_PROVIDER_ID = "matterwave.mcp";

/** The part of an MCP HTTP server definition this reads and writes. */
export interface McpHttpDefinition {
  label: string;
  uri: vscode.Uri;
  headers: Record<string, string>;
}

type DefinitionConstructor = new (label: string, uri: vscode.Uri, headers?: Record<string, string>, version?: string) => McpHttpDefinition;

interface McpProvider {
  onDidChangeMcpServerDefinitions: vscode.Event<void>;
  provideMcpServerDefinitions(): Promise<McpHttpDefinition[]>;
  resolveMcpServerDefinition(server: McpHttpDefinition): Promise<McpHttpDefinition | undefined>;
}

interface McpEditorApi {
  registerMcpServerDefinitionProvider(id: string, provider: McpProvider): vscode.Disposable;
}

export interface McpDeps {
  baseUrl: () => string;
  getToken: () => Promise<string | null>;
  version: string;
  /** Fires when the credential or the deployment changes, so VS Code asks again. */
  onDidChange: vscode.Event<void>;
}

/** The provider: one definition while signed in, none while signed out; the bearer added at start. */
export function mcpProvider(deps: McpDeps, Definition: DefinitionConstructor): McpProvider {
  return {
    onDidChangeMcpServerDefinitions: deps.onDidChange,
    async provideMcpServerDefinitions() {
      if (!(await deps.getToken())) return [];
      const endpoint = vscode.Uri.parse(`${deps.baseUrl().replace(/\/+$/, "")}/mcp`);
      return [new Definition("MatterWave", endpoint, {}, deps.version)];
    },
    async resolveMcpServerDefinition(server) {
      const token = await deps.getToken();
      // Signed out since the list was read: no server to start.
      if (!token) return undefined;
      server.headers = { ...server.headers, Authorization: `Bearer ${token}` };
      return server;
    },
  };
}

/** Register the provider where the editor has the API; undefined where it does not. */
export function registerMcpServer(deps: McpDeps): vscode.Disposable | undefined {
  const editor = vscode as unknown as { lm?: Partial<McpEditorApi>; McpHttpServerDefinition?: DefinitionConstructor };
  const register = editor.lm?.registerMcpServerDefinitionProvider;
  const Definition = editor.McpHttpServerDefinition;
  if (!register || !Definition) return undefined;
  return register.call(editor.lm, MCP_PROVIDER_ID, mcpProvider(deps, Definition));
}
