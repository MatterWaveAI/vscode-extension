import { createHash } from "node:crypto";
import type { McpServerConfig } from "./mcp";

/**
 * Which MCP servers the agent starts, from the settings' layers. The
 * person's own settings are theirs to run. A workspace's settings
 * (`.vscode/settings.json`, a `.code-workspace` file) come with the
 * repository, so a server they add -- a process started as the person, or a
 * URL handed their files -- starts only once the person has approved that
 * exact definition for this workspace, and a workspace can never mark its
 * own servers `trust` (tools that run without asking). MatterWave's own
 * `/mcp` is added by the extension, and only a server at exactly that URL is
 * given the person's credential.
 */

export const MATTERWAVE_MCP = "matterwave";

/** One project server waiting for the person's approval: `key` names its exact definition. */
export interface PendingServer {
  name: string;
  config: McpServerConfig;
  key: string;
}

export interface McpLayers {
  /** The person's settings (`globalValue`). */
  user?: unknown;
  /** The workspace's and the folder's settings, the folder's winning. */
  project?: unknown[];
}

export interface ResolveOptions {
  /** The deployment's base URL, for MatterWave's own `/mcp`; null leaves it out. */
  matterwaveBase: string | null;
  /** Whether this exact project definition was approved before (kept by the caller, outside the repository). */
  approved(key: string): boolean;
  /** Ask about the new project servers; resolves to the keys the person approved. */
  approve(pending: PendingServer[]): Promise<string[]>;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) if (typeof item === "string") out[key] = item;
  return out;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

/** A server's settings entry with only the fields this client reads, each of its type; null when it is not an object. */
export function cleanConfig(raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const config: McpServerConfig = {};
  if (typeof r.command === "string") config.command = r.command;
  const args = stringList(r.args);
  if (args) config.args = args;
  const env = stringRecord(r.env);
  if (env) config.env = env;
  if (typeof r.cwd === "string") config.cwd = r.cwd;
  if (typeof r.url === "string") config.url = r.url;
  const headers = stringRecord(r.headers);
  if (headers) config.headers = headers;
  const tools = stringList(r.tools);
  if (tools) config.tools = tools;
  if (r.trust === true) config.trust = true;
  if (r.disabled === true) config.disabled = true;
  return config;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The approval key for one project server: its name and definition, so any change asks again. */
export function serverKey(name: string, config: McpServerConfig): string {
  return createHash("sha256").update(canonical({ name, config })).digest("hex");
}

/**
 * Whether `url` is MatterWave's own `/mcp` on `base`: the same scheme, host
 * and port, the path `/mcp` under the base's, and no user name or password.
 * A prefix match is not enough: `https://app.example.dev.evil.test/mcp` and
 * `https://app.example.dev@evil.test/mcp` both start with the base.
 */
export function isMatterWaveMcp(url: string | undefined, base: string): boolean {
  if (!url) return false;
  let given: URL;
  let expected: URL;
  try {
    given = new URL(url);
    expected = new URL(`${base.replace(/\/+$/, "")}/mcp`);
  } catch {
    return false;
  }
  if (given.username || given.password) return false;
  return given.protocol === expected.protocol && given.host === expected.host && given.pathname.replace(/\/+$/, "") === expected.pathname;
}

/** The servers to sync, after asking about any project server not yet approved. */
export async function resolveMcpServers(layers: McpLayers, options: ResolveOptions): Promise<Record<string, McpServerConfig>> {
  const servers: Record<string, McpServerConfig> = {};
  const user = layers.user && typeof layers.user === "object" ? (layers.user as Record<string, unknown>) : {};
  for (const [name, raw] of Object.entries(user)) {
    const config = cleanConfig(raw);
    if (config) servers[name] = config;
  }
  const project: Record<string, McpServerConfig> = {};
  for (const layer of layers.project ?? []) {
    if (!layer || typeof layer !== "object") continue;
    for (const [name, raw] of Object.entries(layer as Record<string, unknown>)) {
      const config = cleanConfig(raw);
      if (!config) continue;
      // A repository cannot let its own servers' tools run unasked.
      delete config.trust;
      project[name] = config;
    }
  }
  const pending: PendingServer[] = [];
  for (const [name, config] of Object.entries(project)) {
    if (servers[name] && canonical(servers[name]) === canonical(config)) continue;
    // Turning a server off starts nothing: a workspace may do that unasked.
    if (config.disabled) {
      servers[name] = config;
      continue;
    }
    const key = serverKey(name, config);
    if (options.approved(key)) servers[name] = config;
    else pending.push({ name, config, key });
  }
  if (pending.length > 0) {
    const approved = new Set(await options.approve(pending));
    for (const server of pending) if (approved.has(server.key)) servers[server.name] = server.config;
  }
  if (options.matterwaveBase && !servers[MATTERWAVE_MCP]) {
    servers[MATTERWAVE_MCP] = { url: `${options.matterwaveBase.replace(/\/+$/, "")}/mcp` };
  }
  return servers;
}

/** One line per server for the approval prompt: what it starts or where it connects, shown whole. */
export function describeServer(server: PendingServer): string {
  const { config } = server;
  const what = config.url
    ? `connects to ${config.url}${config.headers && Object.keys(config.headers).length ? ` (headers: ${Object.keys(config.headers).join(", ")})` : ""}`
    : `runs ${[config.command ?? "", ...(config.args ?? [])].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}${config.cwd ? ` in ${config.cwd}` : ""}${config.env && Object.keys(config.env).length ? ` (env: ${Object.keys(config.env).join(", ")})` : ""}`;
  return `${server.name}: ${what}`;
}
