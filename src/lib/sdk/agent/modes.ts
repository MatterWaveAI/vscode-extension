/** The approval check, the tools a mode offers, and the agent-mode system prompt rendered for one run. */

import type { Tool } from "../types.js";
import {
  MODE_NAMES,
  MODES_BY_NAME,
  SHELLS,
  SYSTEM_PROMPT_TEMPLATE,
  TOOLS,
  type ApprovalMode,
  type Decision,
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
 * the user approves it (`ask`), or not at all (`deny`). A tool the contract
 * does not name is denied: a model that invents one gets a refusal, not a
 * prompt.
 */
export function allowed(tool: string, modeName: string): Decision {
  const m = mode(modeName);
  if ((m.allow as readonly string[]).includes(tool)) return "allow";
  if ((m.ask as readonly string[]).includes(tool)) return "ask";
  return "deny";
}

/**
 * The `tools` to send to `/v1` in this mode: every tool the mode does not
 * deny, in contract order, as plain mutable JSON. `plan` gets the read-only
 * tools alone, so the model is never offered a write or a command.
 */
export function toolsForMode(modeName: string): Tool[] {
  return TOOLS.filter((t) => allowed(t.name, modeName) !== "deny").map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: JSON.parse(JSON.stringify(t.parameters)) as Record<string, unknown>,
    },
  }));
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

/**
 * The agent-mode system prompt for one run: the contract's template with the
 * workspace root, the platform and its shell, the mode and the tools the mode
 * offers filled in. Placeholders are replaced literally, in one pass, so a
 * brace in `root` stays as it is.
 */
export function systemPrompt(modeName: string, root: string, options: { platform?: string } = {}): string {
  const m = mode(modeName);
  const values: Record<string, string> = {
    root,
    platform: platformName(options.platform),
    shell: shellFor(options.platform).name,
    mode: m.name,
    mode_summary: m.summary,
    tools: toolsForMode(m.name)
      .map((t) => t.function.name)
      .join(", "),
  };
  return fill(SYSTEM_PROMPT_TEMPLATE, values);
}

function fill(template: string, values: Record<string, string>): string {
  let out = "";
  let i = 0;
  while (i < template.length) {
    if (template[i] === "{") {
      const end = template.indexOf("}", i);
      const key = end !== -1 ? template.slice(i + 1, end) : "";
      if (Object.prototype.hasOwnProperty.call(values, key)) {
        out += values[key];
        i = end + 1;
        continue;
      }
    }
    out += template[i];
    i += 1;
  }
  return out;
}
