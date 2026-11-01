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
export type ToolKind = ContractTool["kind"];
export type ModeName = ContractMode["name"];
export type Decision = "allow" | "ask" | "deny";
export type Refusal = keyof typeof CONTRACT.confinement.refusals;
export type EditFailure = keyof typeof CONTRACT.edit.errors;

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

export const DEFAULT_DENY: readonly string[] = CONTRACT.confinement.deny;
export const DENY_FILE: string = CONTRACT.confinement.deny_file;
export const SEARCH_IGNORE_FILES: readonly string[] = CONTRACT.confinement.search_ignore_files;
export const PROTECTED: readonly string[] = CONTRACT.confinement.protected;
export const REFUSALS: Readonly<Record<Refusal, string>> = CONTRACT.confinement.refusals;

export const EDIT_CRLF_FALLBACK: boolean = CONTRACT.edit.crlf_fallback;
export const EDIT_ERRORS: Readonly<Record<EditFailure, string>> = CONTRACT.edit.errors;

export const DIFF_CONTEXT_LINES: number = CONTRACT.diff.context_lines;
export const DIFF_MAX_EDIT_DISTANCE: number = CONTRACT.diff.max_edit_distance;

export const LIMITS: Readonly<Record<keyof typeof CONTRACT.limits, number>> = CONTRACT.limits;
export const SHELLS: Readonly<Record<"posix" | "windows", { readonly name: string; readonly argv: readonly string[] }>> =
  CONTRACT.shell;

export const SYSTEM_PROMPT_VERSION: number = CONTRACT.system_prompt.version;
export const SYSTEM_PROMPT_TEMPLATE: string = CONTRACT.system_prompt.template.join("\n");
