import { spawn, type ChildProcess } from "node:child_process";
import { sseEvents } from "../lib/matterwaveClient";
import type { Decision, ModeName } from "../lib/sdk/agent/types";
import { killTree } from "./shell";
import { failure, type ToolOutcome, type ToolSpec } from "./tools";

/**
 * The agent as an MCP client: servers from the person's and the
 * workspace's settings (`matterwave.agent.mcpServers`), over stdio (a
 * process the extension starts) or HTTP (Streamable HTTP, JSON or SSE
 * answers), plus MatterWave's own `/mcp` with the signed-in credential.
 *
 * Each server's tools reach the model as `mcp__<server>__<tool>`, only those
 * its `tools` allow-list names when it has one. They go through the same
 * approvals as the local tools: a tool the server marks read-only runs like
 * `read_file`; any other asks in `ask` and `auto-edit` (it can reach
 * anything, like a command), is not offered in `plan`, and runs unasked
 * only in `yolo` -- or always, for a server the person marked `trust`.
 */

export const PROTOCOL_VERSION = "2025-06-18";
const REQUEST_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 300_000;
const MAX_RESULT_CHARS = 100_000;

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** The tools the model may be offered; absent offers every tool the server lists. */
  tools?: string[];
  /** Run its tools without asking, outside `plan`. */
  trust?: boolean;
  disabled?: boolean;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

interface Transport {
  request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown>;
  notify(method: string, params: unknown): Promise<void>;
  close(): void;
}

export class McpError extends Error {}

function rpcError(error: unknown): McpError {
  const e = error as { message?: unknown; code?: unknown } | null;
  return new McpError(typeof e?.message === "string" ? e.message : `MCP error ${String(e?.code ?? "")}`.trim());
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new McpError(`${what} did not answer within ${Math.round(ms / 1000)}s.`)), ms);
    const onAbort = () => {
      clearTimeout(timer);
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** A server the extension starts: JSON-RPC, one message per line, on its stdin and stdout. */
export class StdioTransport implements Transport {
  private readonly child: ChildProcess;
  private nextId = 1;
  private buffered = "";
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private stderrTail = "";
  private exited: string | null = null;

  constructor(command: string, args: string[], options: { env?: Record<string, string>; cwd?: string }) {
    this.child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // A `.cmd` shim (npx on Windows) only runs through the shell.
      shell: process.platform === "win32" && !/\.(exe|com)$/i.test(command) && !command.includes("\\") && !command.includes("/"),
    });
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.take(chunk));
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-2000);
    });
    const gone = (why: string) => {
      this.exited = why;
      for (const { reject } of this.pending.values()) reject(new McpError(`${why}${this.stderrTail ? `: ${this.stderrTail.trim().split("\n").pop()}` : ""}`));
      this.pending.clear();
    };
    this.child.on("error", (error) => gone(`The server could not start (${error.message})`));
    this.child.on("exit", (code) => gone(`The server exited (code ${code ?? "none"})`));
  }

  private take(chunk: string): void {
    this.buffered += chunk;
    let newline: number;
    while ((newline = this.buffered.indexOf("\n")) !== -1) {
      const line = this.buffered.slice(0, newline).trim();
      this.buffered = this.buffered.slice(newline + 1);
      if (!line) continue;
      let message: { id?: unknown; method?: unknown; result?: unknown; error?: unknown };
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof message.method === "string") {
        // A request from the server (ping, roots/list): answered, never acted on.
        if (message.id !== undefined) {
          const reply =
            message.method === "ping"
              ? { jsonrpc: "2.0", id: message.id, result: {} }
              : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Not supported by this client" } };
          this.write(reply);
        }
        continue;
      }
      const waiter = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
      if (!waiter) continue;
      this.pending.delete(message.id as number);
      if (message.error) waiter.reject(rpcError(message.error));
      else waiter.resolve(message.result);
    }
  }

  private write(message: unknown): void {
    this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (this.exited) return Promise.reject(new McpError(this.exited));
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.write({ jsonrpc: "2.0", id, method, params });
    return withTimeout(result, timeoutMs, method, signal).finally(() => this.pending.delete(id));
  }

  async notify(method: string, params: unknown): Promise<void> {
    this.write({ jsonrpc: "2.0", method, params });
  }

  close(): void {
    this.child.stdin?.end();
    killTree(this.child);
  }
}

/** A server at a URL: one POST per message, the answer as JSON or as an event stream (Streamable HTTP). */
export class HttpTransport implements Transport {
  private nextId = 1;
  private session: string | null = null;
  private protocol: string | null = null;

  constructor(
    private readonly url: string,
    private readonly headers: () => Promise<Record<string, string>>,
    private readonly fetchImpl: (input: string, init: RequestInit) => Promise<Response>,
  ) {}

  private async post(body: unknown, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(await this.headers()),
    };
    if (this.session) headers["Mcp-Session-Id"] = this.session;
    if (this.protocol) headers["MCP-Protocol-Version"] = this.protocol;
    const response = await this.fetchImpl(this.url, { method: "POST", headers, body: JSON.stringify(body), signal });
    const session = response.headers.get("mcp-session-id");
    if (session) this.session = session;
    return response;
  }

  async request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    const work = (async () => {
      const response = await this.post({ jsonrpc: "2.0", id, method, params }, signal);
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new McpError(`HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
      }
      const type = response.headers.get("content-type") ?? "";
      let message: { id?: unknown; result?: unknown; error?: unknown } | null = null;
      if (type.includes("text/event-stream") && response.body) {
        for await (const event of sseEvents(response.body)) {
          try {
            const parsed = JSON.parse(event.data) as { id?: unknown };
            if (parsed.id === id) {
              message = parsed;
              break;
            }
          } catch {
            // Not a JSON-RPC message.
          }
        }
      } else {
        message = (await response.json()) as typeof message;
      }
      if (!message) throw new McpError(`${method}: the server closed the stream without an answer.`);
      if (message.error) throw rpcError(message.error);
      if (method === "initialize") {
        const version = (message.result as { protocolVersion?: unknown } | null)?.protocolVersion;
        this.protocol = typeof version === "string" ? version : PROTOCOL_VERSION;
      }
      return message.result;
    })();
    return withTimeout(work, timeoutMs, method, signal);
  }

  async notify(method: string, params: unknown): Promise<void> {
    try {
      await this.post({ jsonrpc: "2.0", method, params });
    } catch {
      // A notification has no answer to wait for.
    }
  }

  close(): void {
    // Stateless from this side; a session the server holds expires on its own.
  }
}

export class McpClient {
  constructor(
    readonly name: string,
    private readonly transport: Transport,
  ) {}

  async connect(version: string): Promise<void> {
    await this.transport.request(
      "initialize",
      { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "matterwave-vscode", version } },
      REQUEST_TIMEOUT_MS,
    );
    await this.transport.notify("notifications/initialized", {});
  }

  async listTools(): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = (await this.transport.request("tools/list", cursor ? { cursor } : {}, REQUEST_TIMEOUT_MS)) as {
        tools?: unknown[];
        nextCursor?: unknown;
      } | null;
      for (const raw of result?.tools ?? []) {
        const t = raw as { name?: unknown; description?: unknown; inputSchema?: unknown; annotations?: { readOnlyHint?: unknown } };
        if (typeof t.name !== "string") continue;
        const schema = t.inputSchema && typeof t.inputSchema === "object" ? (t.inputSchema as Record<string, unknown>) : {};
        tools.push({
          name: t.name,
          description: typeof t.description === "string" ? t.description : "",
          inputSchema: { type: "object", properties: {}, ...schema },
          readOnly: t.annotations?.readOnlyHint === true,
        });
      }
      if (typeof result?.nextCursor !== "string" || !result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutcome> {
    const result = (await this.transport.request("tools/call", { name, arguments: args }, CALL_TIMEOUT_MS, signal)) as {
      content?: unknown[];
      structuredContent?: unknown;
      isError?: unknown;
    } | null;
    const text = (result?.content ?? [])
      .map((block) => {
        const b = block as { type?: unknown; text?: unknown; resource?: { text?: unknown; uri?: unknown } };
        if (b.type === "text" && typeof b.text === "string") return b.text;
        if (b.type === "resource" && typeof b.resource?.text === "string") return b.resource.text;
        return b.type ? `[${String(b.type)} content]` : "";
      })
      .filter(Boolean)
      .join("\n");
    const body = text || (result?.structuredContent ? JSON.stringify(result.structuredContent) : "(no output)");
    const clipped = body.length > MAX_RESULT_CHARS ? `${body.slice(0, MAX_RESULT_CHARS)}\n[cut at ${MAX_RESULT_CHARS.toLocaleString("en-US")} characters]` : body;
    return { content: clipped, isError: result?.isError === true };
  }

  close(): void {
    this.transport.close();
  }
}

/** The name the model sees for a server's tool: `mcp__server__tool`, in the characters `/v1` takes, at most 64. */
export function mcpToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  return `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64);
}

export function mcpDecision(tool: McpToolInfo, config: McpServerConfig, mode: ModeName): Decision {
  if (mode === "plan") return tool.readOnly ? "allow" : "deny";
  if (mode === "yolo" || config.trust === true || tool.readOnly) return "allow";
  return "ask";
}

export interface McpServerStatus {
  name: string;
  state: "connected" | "failed" | "starting";
  tools: number;
  /** Tools the server lists that its allow-list keeps from the model. */
  hidden: number;
  error: string | null;
}

export interface McpManagerOptions {
  version: string;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  /** Headers for an HTTP server, read per request (the MatterWave credential can change). */
  headersFor?: (name: string, config: McpServerConfig) => Promise<Record<string, string>>;
  /** The transport for a config; tests substitute their own. */
  transportFor?: (name: string, config: McpServerConfig) => Transport;
}

interface Connected {
  config: McpServerConfig;
  client: McpClient | null;
  tools: McpToolInfo[];
  status: McpServerStatus;
}

/**
 * The configured servers, connected on first use and kept until the
 * configuration changes: `sync(configs)` starts what is new, stops what is
 * gone, and leaves the rest running.
 */
export class McpManager {
  private servers = new Map<string, Connected>();
  private signatures = new Map<string, string>();

  constructor(private readonly options: McpManagerOptions) {}

  async sync(configs: Record<string, McpServerConfig>): Promise<void> {
    const wanted = Object.entries(configs).filter(([, c]) => c && !c.disabled && (c.command || c.url));
    const names = new Set(wanted.map(([name]) => name));
    for (const [name, server] of this.servers) {
      if (!names.has(name) || this.signatures.get(name) !== JSON.stringify(configs[name])) {
        server.client?.close();
        this.servers.delete(name);
        this.signatures.delete(name);
      }
    }
    await Promise.all(
      wanted
        .filter(([name]) => !this.servers.has(name))
        .map(async ([name, config]) => {
          this.signatures.set(name, JSON.stringify(config));
          const status: McpServerStatus = { name, state: "starting", tools: 0, hidden: 0, error: null };
          const entry: Connected = { config, client: null, tools: [], status };
          this.servers.set(name, entry);
          try {
            const client = new McpClient(name, this.transport(name, config));
            entry.client = client;
            await client.connect(this.options.version);
            const listed = await client.listTools();
            const allow = Array.isArray(config.tools) ? new Set(config.tools) : null;
            entry.tools = allow ? listed.filter((t) => allow.has(t.name)) : listed;
            status.state = "connected";
            status.tools = entry.tools.length;
            status.hidden = listed.length - entry.tools.length;
          } catch (error) {
            entry.client?.close();
            entry.client = null;
            status.state = "failed";
            status.error = error instanceof Error ? error.message : String(error);
          }
        }),
    );
  }

  private transport(name: string, config: McpServerConfig): Transport {
    if (this.options.transportFor) return this.options.transportFor(name, config);
    if (config.url) {
      return new HttpTransport(
        config.url,
        async () => ({ ...(config.headers ?? {}), ...((await this.options.headersFor?.(name, config)) ?? {}) }),
        this.options.fetch,
      );
    }
    return new StdioTransport(config.command!, config.args ?? [], { env: config.env, cwd: config.cwd });
  }

  status(): McpServerStatus[] {
    return [...this.servers.values()].map((s) => ({ ...s.status }));
  }

  /** The connected servers' allowed tools as specs the agent offers by mode. */
  specs(): ToolSpec[] {
    const specs: ToolSpec[] = [];
    for (const [server, entry] of this.servers) {
      const client = entry.client;
      if (!client || entry.status.state !== "connected") continue;
      for (const tool of entry.tools) {
        const name = mcpToolName(server, tool.name);
        specs.push({
          name,
          definition: {
            type: "function",
            function: { name, description: `[MCP ${server}] ${tool.description}`.slice(0, 1024), parameters: tool.inputSchema },
          },
          decide: (mode) => mcpDecision(tool, entry.config, mode),
          label: () => `${server} › ${tool.name}`,
          run: async (args, decision, ctx) => {
            if (decision === "ask") {
              const answer = await ctx.approvals.confirm(
                { kind: "mcp", tool: name, title: `Call ${tool.name} on the MCP server "${server}"`, detail: JSON.stringify(args, null, 2) },
                ctx.signal,
              );
              if (!answer.approved) return { content: "The person declined the call; it did not run.", isError: false, rejected: true };
            }
            try {
              return await client.callTool(tool.name, args, ctx.signal);
            } catch (error) {
              if (ctx.signal.aborted) throw error;
              return failure(`The MCP server "${server}" failed: ${error instanceof Error ? error.message : String(error)}`);
            }
          },
        });
      }
    }
    return specs;
  }

  dispose(): void {
    for (const server of this.servers.values()) server.client?.close();
    this.servers.clear();
    this.signatures.clear();
  }
}
