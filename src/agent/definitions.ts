import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as nodePath from "node:path";

/**
 * Markdown definition files: custom commands (`.matterwave/commands/*.md`)
 * and subagents (`.matterwave/agents/*.md`), in the person's home and in
 * the workspace. Each is a Markdown body under an optional front matter
 * block of `key: value` lines (a value may be a `[a, b]` list or `- item`
 * lines). A workspace's files load only when the folder is trusted: they
 * are prompts a cloned repository could have written.
 */

export interface FrontMatter {
  meta: Record<string, string | string[]>;
  body: string;
}

export function parseFrontMatter(text: string): FrontMatter {
  // A byte-order mark (U+FEFF) first would hide the front matter's opening line.
  const normalized = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (!match) return { meta: {}, body: normalized.trim() };
  const meta: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  for (const line of (match[1] ?? "").split("\n")) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      const list = meta[listKey];
      meta[listKey] = [...(Array.isArray(list) ? list : []), unquote(item[1] ?? "")];
      continue;
    }
    const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!pair) continue;
    const key = pair[1]!.toLowerCase();
    const value = (pair[2] ?? "").trim();
    if (value === "") {
      listKey = key;
      meta[key] = [];
    } else if (value.startsWith("[") && value.endsWith("]")) {
      listKey = null;
      meta[key] = value
        .slice(1, -1)
        .split(",")
        .map((v) => unquote(v.trim()))
        .filter(Boolean);
    } else {
      listKey = null;
      meta[key] = unquote(value);
    }
  }
  return { meta, body: normalized.slice(match[0].length).trim() };
}

function unquote(value: string): string {
  return /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
}

/** A front-matter value as a list: a `[a, b]` list, `- item` lines, or one comma-separated string. */
export function listOf(value: string | string[] | undefined): string[] | null {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value;
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

export interface DefinitionDir {
  path: string;
  /** Where the files came from, as the view names it: "user" or "workspace". */
  scope: "user" | "workspace";
}

/** The definition folders for `kind` ("commands" or "agents"): the person's, then the workspace's when it is trusted. */
export function definitionDirs(kind: "commands" | "agents", root: string | null, trusted: boolean, home = homedir()): DefinitionDir[] {
  const dirs: DefinitionDir[] = [{ path: nodePath.join(home, ".matterwave", kind), scope: "user" }];
  if (root && trusted) dirs.push({ path: nodePath.join(root, ".matterwave", kind), scope: "workspace" });
  return dirs;
}

/** Every `*.md` in the folders, `name` from the file name; a later folder's file replaces an earlier one's of the same name. */
export async function readDefinitions(dirs: DefinitionDir[]): Promise<{ name: string; scope: DefinitionDir["scope"]; file: string; parsed: FrontMatter }[]> {
  const byName = new Map<string, { name: string; scope: DefinitionDir["scope"]; file: string; parsed: FrontMatter }>();
  for (const dir of dirs) {
    let names: string[];
    try {
      names = (await readdir(dir.path)).filter((n) => n.toLowerCase().endsWith(".md")).sort();
    } catch {
      continue;
    }
    for (const fileName of names) {
      const name = fileName.slice(0, -3).toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name)) continue;
      const file = nodePath.join(dir.path, fileName);
      try {
        byName.set(name, { name, scope: dir.scope, file, parsed: parseFrontMatter(await readFile(file, "utf8")) });
      } catch {
        // An unreadable file is skipped, not fatal.
      }
    }
  }
  return [...byName.values()];
}

// --- custom commands -----------------------------------------------------------

export interface CustomCommand {
  name: string;
  description: string;
  body: string;
  scope: DefinitionDir["scope"];
}

export async function loadCustomCommands(dirs: DefinitionDir[]): Promise<CustomCommand[]> {
  return (await readDefinitions(dirs))
    .filter((d) => d.parsed.body.trim())
    .map((d) => ({
      name: d.name,
      description: typeof d.parsed.meta.description === "string" ? d.parsed.meta.description : d.parsed.body.split("\n", 1)[0]!.slice(0, 80),
      body: d.parsed.body,
      scope: d.scope,
    }));
}

/** The command's text with `$ARGUMENTS` (or `{{args}}`) replaced by what followed `/name`; appended when it names neither. */
export function expandCommand(command: CustomCommand, args: string): string {
  if (/\$ARGUMENTS|\{\{\s*args\s*\}\}/.test(command.body)) {
    return command.body.replace(/\$ARGUMENTS|\{\{\s*args\s*\}\}/g, () => args);
  }
  return args ? `${command.body}\n\n${args}` : command.body;
}

// --- subagents -------------------------------------------------------------------

export interface SubagentDefinition {
  name: string;
  description: string;
  /** The tools it may use; null is every tool its parent has (but `task`). */
  tools: string[] | null;
  prompt: string;
  scope: DefinitionDir["scope"];
}

export async function loadSubagents(dirs: DefinitionDir[]): Promise<SubagentDefinition[]> {
  return (await readDefinitions(dirs))
    .filter((d) => d.parsed.body.trim())
    .map((d) => ({
      name: d.name,
      description:
        typeof d.parsed.meta.description === "string" ? d.parsed.meta.description : d.parsed.body.split("\n", 1)[0]!.slice(0, 120),
      tools: listOf(d.parsed.meta.tools),
      prompt: d.parsed.body,
      scope: d.scope,
    }));
}
