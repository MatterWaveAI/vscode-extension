/**
 * The agent tool contract and the pure helpers a coding client builds on,
 * browser-safe. The main entry re-exports this as the `agent` namespace:
 *
 *     import { agent } from "@matterwave/sdk";
 *     agent.CONTRACT_VERSION;                  // "1.0.0"
 *     const tools = agent.toolsForMode("plan"); // the `tools` for /v1: read-only
 *     agent.allowed("edit", "ask");            // "ask"
 *
 * Path confinement reads the filesystem, so it is in the Node-only entry,
 * `@matterwave/sdk/agent`, which exports all of this plus `confine`,
 * `loadDenyList` and `resolveLinks`.
 *
 * The contract is generated from the Python SDK's contract.json, the one
 * source both SDKs share.
 */

export {
  APPROVAL_MODES,
  CONTRACT,
  CONTRACT_SHA256,
  CONTRACT_VERSION,
  DEFAULT_DENY,
  DEFAULT_MODE,
  DENY_FILE,
  DIFF_CONTEXT_LINES,
  DIFF_MAX_EDIT_DISTANCE,
  EDIT_ERRORS,
  LIMITS,
  MODE_NAMES,
  MODES_BY_NAME,
  PROTECTED,
  READ_ONLY_TOOLS,
  REFUSALS,
  SEARCH_IGNORE_FILES,
  SHELLS,
  SYSTEM_PROMPT_TEMPLATE,
  SYSTEM_PROMPT_VERSION,
  TOOL_NAMES,
  TOOLS,
  TOOLS_BY_NAME,
} from "./types.js";
export type {
  AgentTool,
  ApprovalMode,
  Decision,
  EditFailure,
  JsonSchema,
  ModeName,
  Refusal,
  ToolKind,
  ToolName,
} from "./types.js";
export { allowed, mode, platformName, shellFor, systemPrompt, toolsForMode } from "./modes.js";
export { EditError, applyEdit, occurrences } from "./edit.js";
export { NO_NEWLINE, splitLines, unifiedDiff } from "./diff.js";
export { DenyList, PathRefusedError, globToRegex, isAbsolute } from "./deny.js";
