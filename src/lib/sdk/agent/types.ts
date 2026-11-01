/**
 * The contract's typed constants. Every value comes from `CONTRACT`, the
 * copy generated from the Python SDK's contract.json; nothing here restates
 * one, so a regenerated contract retypes these with it.
 */

import { CONTRACT } from "./contract.js";

export { CONTRACT, CONTRACT_SHA256 } from "./contract.js";

/** The contract's own version, semver: `CONTRACT.contract_version`. */
export const CONTRACT_VERSION: string = CONTRACT.contract_version;

type ContractTool = (typeof CONTRACT.tools)[number];
type ContractMode = (typeof CONTRACT.approval_modes)[number];

export type ToolName = ContractTool["name"];
/** The kinds of the contract's own seven tools. */
export type ToolKind = ContractTool["kind"];
/** Every kind a tool may have: the contract's three, then `network`, `mcp` and `meta`. */
export type AnyToolKind = keyof typeof CONTRACT.tool_kinds;
/** The kinds a client's own tools may have beyond the contract's: web_fetch (`network`), an MCP server's tool (`mcp`), todo_write, leaving plan mode or dispatching a subagent (`meta`). */
export type ExtraToolKind = Exclude<AnyToolKind, ToolKind>;
export type ModeName = ContractMode["name"];
export type Decision = "allow" | "ask" | "deny";
export type Refusal = keyof typeof CONTRACT.confinement.refusals;
export type ApprovalRefusal = keyof typeof CONTRACT.approval.refusals;
/** Every refusal `refusal()` words: the confinement codes and the approval ones. */
export type RefusalCode = Refusal | ApprovalRefusal;
export type EditFailure = keyof typeof CONTRACT.edit.errors;
export type ToolFailure = keyof typeof CONTRACT.outputs.errors;
export type LimitName = keyof typeof CONTRACT.limits;

/** A JSON Schema, as the contract spells one. */
export type JsonSchema = { readonly [key: string]: unknown };

/**
 * One local tool: its name, what it reads or changes (`kind`), and the JSON
 * Schema of its arguments. `read_only` tools are the ones `plan` offers.
 */
export interface AgentTool {
  readonly name: ToolName;
  readonly kind: ToolKind;
  readonly read_only: boolean;
  readonly description: string;
  readonly parameters: JsonSchema;
}

/**
 * What a mode lets through without asking (`allow`) and what it asks the
 * user about first (`ask`); every other tool is denied and not offered to
 * the model. `yolo` needs a flag each session (`requires_flag`) and is never
 * saved as a default (`persistable`).
 */
export interface ApprovalMode {
  readonly name: ModeName;
  readonly summary: string;
  readonly allow: readonly ToolName[];
  readonly ask: readonly ToolName[];
  readonly persistable: boolean;
  readonly requires_flag: boolean;
}

/**
 * A client's own tool, beyond the contract's seven: web_fetch, an MCP
 * server's tool, todo_write. `kind` decides it in each mode (see `allowed`);
 * `read_only` is the tool's claim to change nothing, which in `plan` turns a
 * `network` or `mcp` deny into ask. The name must not be a contract tool's.
 */
export interface ExtraTool {
  readonly name: string;
  readonly kind: AnyToolKind;
  readonly description: string;
  /** The JSON Schema of its arguments; an empty object schema when left out. */
  readonly parameters?: JsonSchema;
  readonly read_only?: boolean;
}

/**
 * A file of instructions for the agent (MATTERWAVE.md, AGENTS.md,
 * MATTERWAVE.local.md) for `systemPrompt`: where it is, its text, and
 * whether the user trusts it. An untrusted file is left out of the prompt.
 * Pass them from the most shared to the most personal (`CONTEXT_FILES`
 * order, MATTERWAVE.local.md last): the later file wins where two disagree.
 */
export interface ContextFile {
  readonly path: string;
  readonly content: string;
  readonly trusted: boolean;
}

export const TOOLS: readonly AgentTool[] = CONTRACT.tools;
export const TOOLS_BY_NAME: Readonly<Record<ToolName, AgentTool>> = Object.fromEntries(
  TOOLS.map((t) => [t.name, t]),
) as Record<ToolName, AgentTool>;
export const TOOL_NAMES: readonly ToolName[] = TOOLS.map((t) => t.name);
export const READ_ONLY_TOOLS: readonly ToolName[] = TOOLS.filter((t) => t.read_only).map((t) => t.name);

export const APPROVAL_MODES: readonly ApprovalMode[] = CONTRACT.approval_modes;
export const MODES_BY_NAME: Readonly<Record<ModeName, ApprovalMode>> = Object.fromEntries(
  APPROVAL_MODES.map((m) => [m.name, m]),
) as Record<ModeName, ApprovalMode>;
export const MODE_NAMES: readonly ModeName[] = APPROVAL_MODES.map((m) => m.name);
export const DEFAULT_MODE: ModeName = CONTRACT.default_mode;

/** Every kind a tool may have: the contract's three, then network, mcp, meta. */
export const TOOL_KINDS: readonly AnyToolKind[] = Object.keys(CONTRACT.tool_kinds) as AnyToolKind[];
/** Per mode, the decision for a client's own tool of each kind. */
export const KIND_DECISIONS: Readonly<Record<ModeName, Readonly<Record<AnyToolKind, Decision>>>> =
  CONTRACT.approval.kind_decisions;
/** Per mode, what a read-only tool of a kind gets where its kind is denied. */
export const READ_ONLY_DECISIONS: Readonly<Partial<Record<ModeName, Readonly<Partial<Record<AnyToolKind, Decision>>>>>> =
  CONTRACT.approval.read_only_decisions;
export const APPROVAL_REFUSALS: Readonly<Record<ApprovalRefusal, string>> = CONTRACT.approval.refusals;

export const DEFAULT_DENY: readonly string[] = CONTRACT.confinement.deny;
export const DENY_FILE: string = CONTRACT.confinement.deny_file;
export const SEARCH_IGNORE_FILES: readonly string[] = CONTRACT.confinement.search_ignore_files;
export const PROTECTED: readonly string[] = CONTRACT.confinement.protected;
export const REFUSALS: Readonly<Record<Refusal, string>> = CONTRACT.confinement.refusals;
export const SETTINGS_DIR: string = CONTRACT.confinement.settings_dir;
/**
 * The context files a client reads from the root, in the order to pass them
 * to `systemPrompt`: the shared MATTERWAVE.md and AGENTS.md, then the user's
 * own MATTERWAVE.local.md last, so that it wins where they disagree.
 */
export const CONTEXT_FILES: readonly string[] = CONTRACT.confinement.context_files;

export const EDIT_CRLF_FALLBACK: boolean = CONTRACT.edit.crlf_fallback;
export const EDIT_ERRORS: Readonly<Record<EditFailure, string>> = CONTRACT.edit.errors;

export const DIFF_CONTEXT_LINES: number = CONTRACT.diff.context_lines;
export const DIFF_MAX_EDIT_DISTANCE: number = CONTRACT.diff.max_edit_distance;

export const LIMITS: Readonly<Record<LimitName, number>> = CONTRACT.limits;
export const SHELLS: Readonly<Record<"posix" | "windows", { readonly name: string; readonly argv: readonly string[] }>> =
  CONTRACT.shell;

export const SYSTEM_PROMPT_VERSION: number = CONTRACT.system_prompt.version;
export const SYSTEM_PROMPT_TEMPLATE: string = CONTRACT.system_prompt.template.join("\n");

/** The read tools' and run_shell's output formats, markers and messages. */
export const OUTPUTS = CONTRACT.outputs;
export const TOOL_ERRORS: Readonly<Record<ToolFailure, string>> = CONTRACT.outputs.errors;
