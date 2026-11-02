import { allowed, refusal, toolsForMode } from "../lib/sdk/agent/modes";
import { TOOLS_BY_NAME, type AnyToolKind, type Decision, type JsonSchema, type ModeName } from "../lib/sdk/agent/types";
import type { Tool, ToolCall } from "./wire";

/**
 * One tool the agent can offer the model, local or not: its kind, its `/v1`
 * definition, and how it runs. Every decision is the SDK's `allowed()`: the
 * seven contract tools by the mode's own lists, the extension's (todo_write
 * and task are `meta`, web_fetch is `network`, an MCP server's tool is `mcp`)
 * by their kind; and the `tools` a step offers are the SDK's `toolsForMode`.
 */

export interface ToolOutcome {
  /** What goes back to the model as the `tool` message. */
  content: string;
  isError: boolean;
  /** Set when the person said no: the run goes on, and the view marks the call. */
  rejected?: boolean;
  /** What the view shows instead of `content`, when that says more to a person (an applied diff). */
  display?: string;
}

/** A change a write tool proposes: the file as it is and as it would be. */
export interface ChangeRequest {
  tool: string;
  /** Root-relative, `/`-separated: what the view and the diff title show. */
  relative: string;
  absolute: string;
  /** Null when the file does not exist yet. */
  before: string | null;
  after: string;
  /** The unified diff, the SDK's, for the view and the model. */
  diff: string;
  /**
   * Checked just before the change is written: why writing it now would be
   * wrong (the file changed, or its path leads elsewhere, since the diff was
   * made), or null. Absent, nothing is checked.
   */
  stale?: () => Promise<string | null>;
}

export type ChangeOutcome =
  | { status: "applied"; content: string; edited: boolean }
  | { status: "rejected"; reason?: string }
  /** Accepted, or allowed, but not written: `reason` says why (see `ChangeRequest.stale`). */
  | { status: "failed"; reason: string };

export interface ConfirmRequest {
  kind: "shell" | "mcp" | "web" | "tool";
  tool: string;
  /** One line: what is being asked. */
  title: string;
  /** The thing itself, shown whole: the command, the URL, the arguments. */
  detail: string;
}

/** Where a tool gets the person's answer and applies a change; the agent session implements it. */
export interface Approvals {
  /**
   * Show `change` and, when `ask`, wait for Accept or Reject (with the
   * proposal possibly edited); then apply it -- the only way a file is
   * written. Without `ask` it is applied at once.
   */
  change(change: ChangeRequest, ask: boolean, signal: AbortSignal): Promise<ChangeOutcome>;
  confirm(request: ConfirmRequest, signal: AbortSignal): Promise<{ approved: boolean; reason?: string }>;
}

export interface ToolContext {
  root: string;
  mode: ModeName;
  signal: AbortSignal;
  approvals: Approvals;
  call: ToolCall;
  /** Output of a running command, as it arrives. */
  onOutput?: (text: string) => void;
}

export interface ToolSpec {
  name: string;
  /** What the contract decides it by: a contract tool's own kind, or `network`, `mcp` or `meta`. */
  kind: AnyToolKind;
  /** The tool's claim to change nothing, which in plan mode turns a `network` or `mcp` deny into ask. */
  readOnly?: boolean;
  /** For the extension's own tools: what the model reads in the tool's definition and the prompt. */
  description: string;
  parameters?: JsonSchema;
  /** `allowed(name, mode, kind, { readOnly })`: what the mode decides before the call's arguments are known. */
  decide(mode: ModeName): Decision;
  run(args: Record<string, unknown>, decision: Decision, ctx: ToolContext): Promise<ToolOutcome>;
  /** One line for the view: what this call does, from its arguments. */
  label?(args: Record<string, unknown>): string;
}

/** A spec whose `decide` is the SDK's `allowed` for its name and kind. */
export function toolSpec(spec: Omit<ToolSpec, "decide">): ToolSpec {
  return { ...spec, decide: (mode) => allowed(spec.name, mode, spec.kind, { readOnly: spec.readOnly ?? false }) };
}

/** Whether `name` is one of the contract's seven tools. */
export function isContractTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(TOOLS_BY_NAME, name);
}

/**
 * The `tools` a step offers in `mode`, through the SDK's `toolsForMode`: the
 * contract's that `specs` has and the mode does not deny, in contract order,
 * then the extension's own that their kind lets through.
 */
export function offeredTools(specs: readonly ToolSpec[], mode: ModeName): Tool[] {
  const names = new Set(specs.map((s) => s.name));
  const extra = specs
    .filter((s) => !isContractTool(s.name))
    .map((s) => ({ name: s.name, kind: s.kind, description: s.description, read_only: s.readOnly ?? false, ...(s.parameters ? { parameters: s.parameters } : {}) }));
  return toolsForMode(mode, extra).filter((t) => names.has(t.function.name));
}

/** The extension's own tools `mode` offers, for the prompt's "More tools" section. */
export function promptTools(specs: readonly ToolSpec[], mode: ModeName): { name: string; description: string }[] {
  return specs.filter((s) => !isContractTool(s.name) && s.decide(mode) !== "deny").map((s) => ({ name: s.name, description: s.description }));
}

/**
 * The person said no: the contract's `rejected` sentence, an ordinary result
 * rather than an error, with what they said after it.
 */
export function rejectedOutcome(tool: string, reason?: string): ToolOutcome {
  const said = reason?.trim() ? ` They said: ${reason.trim()}` : "";
  return { content: `${refusal("rejected", { tool })}${said}`, isError: false, rejected: true };
}

export function ok(content: string): ToolOutcome {
  return { content, isError: false };
}

export function failure(content: string): ToolOutcome {
  return { content, isError: true };
}

/** The tool's arguments as an object, or the sentence to send back when they are not one. */
export function parseArguments(raw: string): Record<string, unknown> | string {
  if (raw.trim() === "") return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    return "The tool's arguments must be a JSON object.";
  } catch {
    return "The tool's arguments are not valid JSON. Send them again as one JSON object.";
  }
}

/** A required string argument, or the sentence to send back. */
export function stringArg(args: Record<string, unknown>, key: string, required = true): string | undefined | ToolOutcome {
  const value = args[key];
  if (value === undefined || value === null) return required ? failure(`Missing the required argument "${key}".`) : undefined;
  if (typeof value !== "string") return failure(`The argument "${key}" must be a string.`);
  return value;
}

export function intArg(args: Record<string, unknown>, key: string): number | undefined | ToolOutcome {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) return failure(`The argument "${key}" must be an integer.`);
  return value;
}

export function isOutcome(value: unknown): value is ToolOutcome {
  return typeof value === "object" && value !== null && "isError" in value && "content" in value;
}
