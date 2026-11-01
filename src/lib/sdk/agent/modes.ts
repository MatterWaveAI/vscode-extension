/** The approval check, the tools a mode offers, and the agent-mode system prompt rendered for one run. */

import type { Tool } from "../types.js";
import { isProtected } from "./deny.js";
import { fill } from "./fill.js";
import {
  APPROVAL_REFUSALS,
  CONTRACT,
  KIND_DECISIONS,
  MODE_NAMES,
  MODES_BY_NAME,
  READ_ONLY_DECISIONS,
  REFUSALS,
  SHELLS,
  SYSTEM_PROMPT_TEMPLATE,
  TOOL_KINDS,
  TOOLS,
  TOOLS_BY_NAME,
  type AgentTool,
  type AnyToolKind,
  type ApprovalMode,
  type ContextFile,
  type Decision,
  type ExtraTool,
  type RefusalCode,
} from "./types.js";

/** The mode called `name`; a name the contract does not know throws, since guessing a mode would guess at what may run. */
export function mode(name: string): ApprovalMode {
  const found = (MODES_BY_NAME as Record<string, ApprovalMode | undefined>)[name];
  if (found === undefined) {
    throw new RangeError(`unknown approval mode "${name}"; one of ${MODE_NAMES.join(", ")}`);
  }
  return found;
}

/**
 * Whether `tool` may run in `modeName` without asking (`allow`), only after
 * the user approves it (`ask`), or not at all (`deny`).
 *
 * A contract tool is decided by the mode's lists, whatever `kind` says. A
 * client's own tool (web_fetch, an MCP server's tool, todo_write) is decided
 * by its `kind` (`read`, `write`, `shell`, `network`, `mcp`, `meta`);
 * `readOnly: true` turns plan mode's deny of a `network` or `mcp` tool into
 * ask. A tool with neither a contract name nor a kind is denied: a model that
 * invents one gets a refusal, not a prompt.
 *
 * `path`, the file a write tool would change (relative to the root), turns an
 * allow into ask when the path is protected (`PROTECTED`: the deny file, the
 * agent's settings folder, a context file, a shell startup file such as
 * `.bashrc`, the `.ssh/` and `.aws/` folders, or `.config/matterwave` at any
 * depth), in every mode, yolo included.
 */
export function allowed(
  tool: string,
  modeName: string,
  kind?: AnyToolKind | null,
  options: { readOnly?: boolean; path?: string } = {},
): Decision {
  const m = mode(modeName);
  const contractTool = (TOOLS_BY_NAME as Record<string, AgentTool | undefined>)[tool];
  let toolKind: string;
  let decision: Decision;
  if (contractTool !== undefined) {
    toolKind = contractTool.kind;
    decision = (m.allow as readonly string[]).includes(tool)
      ? "allow"
      : (m.ask as readonly string[]).includes(tool)
        ? "ask"
        : "deny";
  } else if (kind !== undefined && kind !== null) {
    if (!(TOOL_KINDS as readonly string[]).includes(kind)) {
      throw new RangeError(`unknown tool kind "${kind}"; one of ${TOOL_KINDS.join(", ")}`);
    }
    toolKind = kind;
    decision = KIND_DECISIONS[m.name][kind];
    if (decision === "deny" && options.readOnly) {
      decision = READ_ONLY_DECISIONS[m.name]?.[kind] ?? "deny";
    }
  } else {
    return "deny";
  }
  if (decision === "allow" && toolKind === "write" && options.path && isProtected(options.path)) return "ask";
  return decision;
}

function toOpenAI(name: string, description: string, parameters: unknown): Tool {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: JSON.parse(JSON.stringify(parameters)) as Record<string, unknown>,
    },
  };
}

const EMPTY_OBJECT = { type: "object", properties: {}, additionalProperties: false };

/**
 * The `tools` to send to `/v1` in this mode: every contract tool the mode
 * does not deny, in contract order, then each of the client's own `extra`
 * tools its kind does not deny, in the order given, as plain mutable JSON.
 * `plan` gets the read-only tools (and the client's read and meta ones)
 * alone, so the model is never offered a write or a command.
 */
export function toolsForMode(modeName: string, extra: readonly ExtraTool[] = []): Tool[] {
  const offered = TOOLS.filter((t) => allowed(t.name, modeName) !== "deny").map((t) =>
    toOpenAI(t.name, t.description, t.parameters),
  );
  for (const tool of extra) {
    if (Object.prototype.hasOwnProperty.call(TOOLS_BY_NAME, tool.name)) {
      throw new RangeError(`${tool.name} is a contract tool; a client's own tool needs its own name`);
    }
    if (allowed(tool.name, modeName, tool.kind, { readOnly: tool.read_only ?? false }) !== "deny") {
      offered.push(toOpenAI(tool.name, tool.description, tool.parameters ?? EMPTY_OBJECT));
    }
  }
  return offered;
}

/**
 * The contract's sentence for a refusal, with `tool`, `mode` and `path`
 * filled in: a confinement code (`outside`, `denied`, ...) or an approval one
 * (`mode`, `unknown_tool`, `rejected`, `headless`, `needs_approval`).
 */
export function refusal(code: RefusalCode, values: { tool?: string; mode?: string; path?: string } = {}): string {
  const template =
    (REFUSALS as Record<string, string | undefined>)[code] ?? (APPROVAL_REFUSALS as Record<string, string | undefined>)[code];
  if (template === undefined) throw new RangeError(`unknown refusal "${code}"`);
  return fill(template, { tool: values.tool ?? "", mode: values.mode ?? "", path: values.path ?? "" });
}

function currentPlatform(): string {
  return typeof process !== "undefined" && typeof process.platform === "string" ? process.platform : "linux";
}

/** `windows`, `macos` or `linux` (any other POSIX reads as linux), from Node's `process.platform` or Python's `sys.platform` spelling. */
export function platformName(platform?: string): "windows" | "macos" | "linux" {
  const value = platform ?? currentPlatform();
  if (value.startsWith("win")) return "windows";
  if (value === "darwin" || value === "macos") return "macos";
  return "linux";
}

/** The shell `run_shell` uses on this platform: its name, as the prompt gives it to the model, and the argv to put before the command. */
export function shellFor(platform?: string): { name: string; argv: readonly string[] } {
  const entry = SHELLS[platformName(platform) === "windows" ? "windows" : "posix"];
  return { name: entry.name, argv: entry.argv };
}

/** An extra tool as `systemPrompt` takes it: its name and description (an `ExtraTool` will do). */
export interface PromptTool {
  readonly name: string;
  readonly description: string;
}

const EXTRA = CONTRACT.system_prompt.extra_tools;
const FILES = CONTRACT.system_prompt.context_files;

function codePoints(text: string): string[] {
  return Array.from(text);
}

function oneLine(description: string): string {
  const text = description.replace(/[ \t\n\r\f\v]+/g, " ").replace(/^ +| +$/g, "");
  const chars = codePoints(text);
  if (chars.length > EXTRA.description_max_chars) {
    return chars.slice(0, EXTRA.description_max_chars - 1).join("") + "…";
  }
  return text;
}

function attribute(value: string): string {
  return value
    .split("&").join("&amp;")
    .split('"').join("&quot;")
    .split("<").join("&lt;")
    .split(">").join("&gt;")
    .split("\r").join("&#13;")
    .split("\n").join("&#10;");
}

function contextBlock(file: ContextFile): string {
  let body = file.content.replace(/[\r\n]+$/, "");
  const chars = codePoints(body);
  if (chars.length > FILES.max_chars) {
    body = chars.slice(0, FILES.max_chars).join("") + "\n" + fill(FILES.cut, { path: file.path, max_chars: String(FILES.max_chars) });
  }
  body = body.replace(/<(\/?project-instructions)/gi, (_, tag: string) => "<\\" + tag);
  const lines = [fill(FILES.open, { path: attribute(file.path) })];
  if (body) lines.push(body);
  lines.push(FILES.close);
  return lines.join("\n");
}

/**
 * The agent-mode system prompt for one run: the contract's template with the
 * workspace root, the platform and its shell, the mode and the tools the mode
 * offers filled in. Placeholders are replaced literally, in one pass, so a
 * brace in `root` stays as it is.
 *
 * `extraTools` are the client's own tools offered in this mode (filter them
 * with `allowed` or `toolsForMode` first): their names join the tool list and
 * a "More tools" section gives each its one-line description. `contextFiles`
 * are the instruction files the client read; the trusted ones follow in a
 * "Project instructions" section, in the order given (later wins), each
 * fenced so its text cannot end it. Give them from the most shared to the
 * most personal, as `CONTEXT_FILES` lists the project's (MATTERWAVE.md,
 * AGENTS.md, then MATTERWAVE.local.md), so the user's own file wins. With
 * neither, the prompt is the template alone.
 */
export function systemPrompt(
  modeName: string,
  root: string,
  options: { platform?: string; extraTools?: readonly PromptTool[]; contextFiles?: readonly ContextFile[] } = {},
): string {
  const m = mode(modeName);
  const extras = (options.extraTools ?? []).map((t) => ({ name: t.name, description: oneLine(t.description) }));
  const names = [...toolsForMode(m.name).map((t) => t.function.name), ...extras.map((t) => t.name)];
  const values: Record<string, string> = {
    root,
    platform: platformName(options.platform),
    shell: shellFor(options.platform).name,
    mode: m.name,
    mode_summary: m.summary,
    tools: names.join(", "),
  };
  const sections = [fill(SYSTEM_PROMPT_TEMPLATE, values)];
  if (extras.length > 0) {
    sections.push([...EXTRA.heading, ...extras.map((t) => fill(EXTRA.line, { name: t.name, description: t.description }))].join("\n"));
  }
  const trusted = (options.contextFiles ?? []).filter((f) => f.trusted);
  if (trusted.length > 0) {
    sections.push(FILES.heading.join("\n") + "\n\n" + trusted.map(contextBlock).join("\n\n"));
  }
  return sections.join("\n\n");
}
