import { homedir } from "node:os";
import * as nodePath from "node:path";
import { CONTEXT_FILES, type ContextFile } from "../lib/sdk/agent/types";
import { readConfined, readHead } from "./readConfined";

/**
 * The project's own notes for the agent: `MATTERWAVE.md` at the workspace
 * root (and `AGENTS.md`, the cross-tool name, when it is there), a personal
 * `MATTERWAVE.local.md` beside them that the person keeps out of git, and
 * `~/.matterwave/MATTERWAVE.md` for every project. They go into the system
 * prompt through the SDK's `systemPrompt(..., { contextFiles })`, which
 * fences each one, cuts it at the contract's length and puts them after the
 * contract's rules, the later winning where two disagree: the person's own
 * notes first, then the root's in the contract's `CONTEXT_FILES` order (the
 * shared ones, then the personal MATTERWAVE.local.md, which wins).
 *
 * A cloned repository's notes are whatever its author wrote, so they load
 * only in a folder the person has trusted; in an untrusted one they are
 * ignored and the view says so. Even trusted, each goes through the tools'
 * confinement: a note that is a link out of the workspace (to a key, say) is
 * refused, not sent.
 */

/** How the person's own notes are named in the prompt and the view. */
export const USER_CONTEXT_NAME = "~/.matterwave/MATTERWAVE.md";

export interface ProjectContext {
  /** The files for `systemPrompt`, in the order they apply; empty when nothing loaded. */
  contextFiles: ContextFile[];
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

export async function loadProjectContext(root: string, options: ContextFileOptions): Promise<ProjectContext> {
  const contextFiles: ContextFile[] = [];
  const files: string[] = [];
  const userFile = options.userFile === undefined ? defaultUserContextFile() : options.userFile;
  if (userFile) {
    const text = await readOrNull(userFile);
    if (text?.trim()) {
      contextFiles.push({ path: USER_CONTEXT_NAME, content: text, trusted: true });
      files.push(USER_CONTEXT_NAME);
    }
  }
  if (!options.trusted) {
    const present: string[] = [];
    for (const name of CONTEXT_FILES) if ((await readConfined(root, name)) !== null) present.push(name);
    return {
      contextFiles,
      files,
      notice:
        present.length > 0
          ? `${present.join(" and ")} ${present.length === 1 ? "was" : "were"} not loaded: this folder is not trusted. Trust it (Workspaces: Manage Workspace Trust) to use the project's notes.`
          : null,
    };
  }
  const refused: string[] = [];
  for (const name of CONTEXT_FILES) {
    const read = await readConfined(root, name);
    if (read && "refused" in read) {
      refused.push(name);
      continue;
    }
    const text = read?.text;
    if (!text?.trim()) continue;
    contextFiles.push({ path: name, content: text, trusted: true });
    files.push(name);
  }
  const notice =
    refused.length > 0
      ? `${refused.join(" and ")} ${refused.length === 1 ? "was" : "were"} not loaded: a link out of the workspace, or a path the deny list covers.`
      : null;
  return { contextFiles, files, notice };
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
