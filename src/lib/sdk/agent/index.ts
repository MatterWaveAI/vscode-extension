/**
 * The agent tool contract and the pure helpers a coding client builds on,
 * browser-safe. The main entry re-exports this as the `agent` namespace:
 *
 *     import { agent } from "@matterwave/sdk";
 *     agent.CONTRACT_VERSION;                  // "1.2.0"
 *     const tools = agent.toolsForMode("plan"); // the `tools` for /v1: read-only
 *     agent.allowed("edit", "ask");            // "ask"
 *     agent.allowed("web_fetch", "ask", "network");            // "ask": a client's own tool, by kind
 *     agent.allowed("edit", "auto-edit", null, { path: "AGENTS.md" }); // "ask": a protected file
 *     agent.formatReadFile(text, "src/app.ts", { startLine: 10 }); // read_file's text, as every client prints it
 *
 * Path confinement and the search walker read the filesystem, so they are in
 * the Node-only entry, `@matterwave/sdk/agent`, which exports all of this plus
 * `confine`, `loadDenyList`, `resolveLinks`, `walk`, `loadSearchIgnore`, the
 * read tools `runReadFile`, `runListDir`, `runGlob` and `runGrep`, and the
 * async `walkAsync`, `runGlobAsync` and `runGrepAsync`.
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
  EDIT_CRLF_FALLBACK,
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
  APPROVAL_REFUSALS,
  CONTEXT_FILES,
  KIND_DECISIONS,
  OUTPUTS,
  READ_ONLY_DECISIONS,
  SETTINGS_DIR,
  TOOL_ERRORS,
  TOOL_KINDS,
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
  AnyToolKind,
  ApprovalRefusal,
  ContextFile,
  ExtraTool,
  ExtraToolKind,
  LimitName,
  RefusalCode,
  ToolFailure,
} from "./types.js";
export { allowed, mode, platformName, refusal, shellFor, systemPrompt, toolsForMode } from "./modes.js";
export type { PromptTool } from "./modes.js";
export { EditError, applyEdit, occurrences } from "./edit.js";
export { NO_NEWLINE, splitLines, unifiedDiff } from "./diff.js";
export {
  DenyList,
  GlobError,
  PROTECTED_LIST,
  PathRefusedError,
  globToRegex,
  isAbsolute,
  isProtected,
  windowsAlias,
} from "./deny.js";
export { fill } from "./fill.js";
export { IgnoreFile, SearchIgnore } from "./ignore.js";
export {
  ToolError,
  checkLines,
  compareCodePoints,
  decodeText,
  formatGlob,
  formatGrep,
  formatListDir,
  formatReadFile,
  formatShell,
  globMatches,
  grepLine,
  isBinary,
  limit,
  textLines,
  utf8Head,
  utf8Tail,
} from "./output.js";
export type { Limits } from "./output.js";
