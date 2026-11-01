import * as vscode from "vscode";

/**
 * A commit message from the staged changes, written into the Source
 * Control input box. The diff comes from VS Code's own git extension (the
 * repository whose title bar was clicked), the style from the
 * `matterwave.commitMessageStyle` setting, and the answer from a one-off
 * turn that never enters the chat.
 */

/** The cap on the diff a prompt carries; a commit's shape survives the cut, its bulk does not need to. */
export const MAX_DIFF_CHARS = 60_000;

export const DEFAULT_COMMIT_STYLE =
  "A summary line of at most 72 characters in the imperative mood, a blank line, then a short body that says what changed and why, wrapped at 72 columns.";

/** The prompt: the style, the rules for the answer, then the staged diff fenced. */
export function commitMessagePrompt(diff: string, style: string): string {
  const clipped = diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n… (diff cut at ${MAX_DIFF_CHARS.toLocaleString()} characters)` : diff;
  const longestRun = Math.max(0, ...Array.from(clipped.matchAll(/`+/g), (m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return [
    "Write the git commit message for the staged changes below.",
    `Style: ${style.trim() || DEFAULT_COMMIT_STYLE}`,
    "Answer with the commit message alone: no commentary, no quotes, no code fence.",
    "",
    `${fence}diff`,
    clipped.trimEnd(),
    fence,
    "",
  ].join("\n");
}

/** The message in an answer: a fence or quotes the model put round it taken off, trailing space trimmed. */
export function commitMessageFrom(answer: string): string {
  let text = answer.replace(/\r\n/g, "\n").trim();
  const fenced = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1$/.exec(text);
  if (fenced) text = (fenced[2] ?? "").trim();
  if (/^"[\s\S]*"$/.test(text) && !text.slice(1, -1).includes('"')) text = text.slice(1, -1).trim();
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
}

/** The slice of the git extension's API this needs. */
export interface GitRepository {
  rootUri: vscode.Uri;
  inputBox: { value: string };
  diff(cached?: boolean): Promise<string>;
}

interface GitApi {
  repositories: GitRepository[];
  getRepository(uri: vscode.Uri): GitRepository | null;
}

/** The git extension's API, or null when it is disabled or not there. */
export async function gitApi(): Promise<GitApi | null> {
  const extension = vscode.extensions.getExtension<{ enabled: boolean; getAPI(version: 1): GitApi }>("vscode.git");
  if (!extension) return null;
  const exports = extension.isActive ? extension.exports : await extension.activate();
  return exports?.enabled ? exports.getAPI(1) : null;
}

/**
 * The repository a commit message is for: the one whose Source Control
 * title bar was clicked (VS Code passes its root), else the active
 * editor's, else the only one, else the person picks.
 */
export async function repositoryFor(api: GitApi, clicked: unknown): Promise<GitRepository | null> {
  const root = (clicked as { rootUri?: unknown } | undefined)?.rootUri;
  if (root instanceof vscode.Uri) {
    const found = api.getRepository(root);
    if (found) return found;
  }
  const document = vscode.window.activeTextEditor?.document;
  const active = document ? api.getRepository(document.uri) : null;
  if (active) return active;
  if (api.repositories.length === 1) return api.repositories[0] ?? null;
  if (api.repositories.length === 0) return null;
  const picked = await vscode.window.showQuickPick(
    api.repositories.map((repository) => ({ repository, label: vscode.workspace.asRelativePath(repository.rootUri, true) })),
    { title: "Commit message for which repository?" },
  );
  return picked?.repository ?? null;
}
