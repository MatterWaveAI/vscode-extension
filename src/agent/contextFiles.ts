import { homedir } from "node:os";
import * as nodePath from "node:path";
import { readConfined, readHead } from "./readConfined";

/**
 * The project's own notes for the agent: `MATTERWAVE.md` at the workspace
 * root (and `AGENTS.md`, the cross-tool name, when it is there), a personal
 * `MATTERWAVE.local.md` beside them that the person keeps out of git, and
 * `~/.matterwave/MATTERWAVE.md` for every project. They go into the system
 * prompt after the contract's rules.
 *
 * A cloned repository's notes are whatever its author wrote, so they load
 * only in a folder the person has trusted; in an untrusted one they are
 * ignored and the view says so. Even trusted, each goes through the tools'
 * confinement: a note that is a link out of the workspace (to a key, say) is
 * refused, not sent.
 */

export const PROJECT_CONTEXT_FILES = ["MATTERWAVE.md", "AGENTS.md"] as const;
export const PERSONAL_CONTEXT_FILE = "MATTERWAVE.local.md";
/** Each file is cut here: notes past it cost every step of every run. */
export const MAX_CONTEXT_FILE_CHARS = 32_000;

export interface ProjectContext {
  /** What goes into the system prompt; null when nothing loaded. */
  text: string | null;
  /** The files that loaded, as the view names them. */
  files: string[];
  /** A sentence for the view: why notes that exist were not loaded. */
  notice: string | null;
}

export interface ContextFileOptions {
  trusted: boolean;
  /** The person's own notes for every project; `~/.matterwave/MATTERWAVE.md` by default. */
  userFile?: string | null;
}

async function readOrNull(path: string): Promise<string | null> {
  return (await readHead(path))?.text ?? null;
}

export function defaultUserContextFile(): string {
  return nodePath.join(homedir(), ".matterwave", "MATTERWAVE.md");
}

function clipped(text: string): string {
  return text.length > MAX_CONTEXT_FILE_CHARS ? `${text.slice(0, MAX_CONTEXT_FILE_CHARS)}\n[cut: the file is longer than ${MAX_CONTEXT_FILE_CHARS.toLocaleString("en-US")} characters]` : text;
}

export async function loadProjectContext(root: string, options: ContextFileOptions): Promise<ProjectContext> {
  const sections: string[] = [];
  const files: string[] = [];
  const userFile = options.userFile === undefined ? defaultUserContextFile() : options.userFile;
  if (userFile) {
    const text = await readOrNull(userFile);
    if (text?.trim()) {
      sections.push(`Your notes for every project (${userFile}):\n\n${clipped(text.trim())}`);
      files.push("~/.matterwave/MATTERWAVE.md");
    }
  }
  const projectNames = [...PROJECT_CONTEXT_FILES, PERSONAL_CONTEXT_FILE];
  if (!options.trusted) {
    const present: string[] = [];
    for (const name of projectNames) if ((await readConfined(root, name)) !== null) present.push(name);
    return {
      text: sections.length > 0 ? sections.join("\n\n---\n\n") : null,
      files,
      notice:
        present.length > 0
          ? `${present.join(" and ")} ${present.length === 1 ? "was" : "were"} not loaded: this folder is not trusted. Trust it (Workspaces: Manage Workspace Trust) to use the project's notes.`
          : null,
    };
  }
  const refused: string[] = [];
  for (const name of projectNames) {
    const read = await readConfined(root, name);
    if (read && "refused" in read) {
      refused.push(name);
      continue;
    }
    const text = read?.text;
    if (!text?.trim()) continue;
    const role = name === PERSONAL_CONTEXT_FILE ? "your personal notes for this project, which take precedence over the project's" : "the project's notes";
    sections.push(`${name} (${role}):\n\n${clipped(text.trim())}`);
    files.push(name);
  }
  const notice =
    refused.length > 0
      ? `${refused.join(" and ")} ${refused.length === 1 ? "was" : "were"} not loaded: a link out of the workspace, or a path the deny list covers.`
      : null;
  if (sections.length === 0) return { text: null, files, notice };
  return {
    text: `Notes for this workspace follow. Follow them where they do not conflict with the rules above.\n\n${sections.join("\n\n---\n\n")}`,
    files,
    notice,
  };
}

/** What `/init` asks the agent to do: look at the repository and draft its MATTERWAVE.md. */
export function initPrompt(existing: string | null): string {
  return [
    existing
      ? "This repository already has a MATTERWAVE.md. Read it, look at the repository, and propose an improved version."
      : "Look at this repository and draft a MATTERWAVE.md at the workspace root for a coding agent working in it.",
    "Cover: what the project is, how it is laid out (the directories that matter), how to build, lint and test it (the exact commands), and the conventions a change must follow.",
    "Read the README, the build files and a few representative sources first; do not guess commands.",
    "Keep it under 120 lines of plain Markdown. Write it with write_file to MATTERWAVE.md, then say what you put in it.",
  ].join("\n");
}
