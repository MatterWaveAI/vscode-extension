/**
 * The @-mention context assemblers: what each provider kind turns into an
 * attachment's text.
 *
 * Everything here is pure over injected IO (a directory reader, a fetch, a
 * diff), so each provider's exact output is testable without an editor or a
 * repository. Sizes are clipped here rather than left to the server's
 * extraction, because a tree or a diff that overruns the context window is
 * noise, not signal.
 */

import type { MentionKind } from "./chat/mentions";

/** One provider's answer: an attachment's filename and its text. */
export interface ContextPart {
  filename: string;
  text: string;
}

/** The cap on any one provider's text; the model needs the shape, not the bulk. */
export const MAX_CONTEXT_CHARS = 100_000;

/** How deep the @folder tree walks, and how many entries it may list. */
export const MAX_TREE_DEPTH = 6;
export const MAX_TREE_ENTRIES = 2_000;

/**
 * Directories that are build output and vendored code: listed never, since
 * they bury the tree the person is asking about.
 */
export const SKIPPED_DIRS = new Set([".git", "node_modules", "dist", "out", "build", "__pycache__", ".venv", "venv"]);

/** Cut `text` at the cap, saying so where it was cut. */
export function clip(text: string, max = MAX_CONTEXT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (cut at ${max.toLocaleString()} characters)`;
}

/** The raw file as itself: the upload route extracts it, as Ask about File. */
export function fileContext(path: string, content: string): ContextPart {
  return { filename: path, text: clip(content) };
}

/** A folder's tree, with a header naming what was listed. */
export function folderContext(path: string, tree: string): ContextPart {
  return { filename: "folder-tree.txt", text: clip(`Directory tree of ${path}/:\n${tree}`) };
}

/** A terminal's buffer, headed by which terminal it came from. */
export function terminalContext(name: string, buffer: string): ContextPart {
  return { filename: "terminal.txt", text: clip(`Output of terminal “${name}”:\n${buffer}`) };
}

/** A git diff, headed by what range it covers. */
export function gitContext(label: string, diff: string): ContextPart {
  return { filename: "git-diff.diff", text: clip(`Git context: ${label}.\n${diff}`) };
}

/** A fetched documentation page, headed by where it came from. */
export function docsContext(url: string, title: string, text: string): ContextPart {
  return { filename: "docs.txt", text: clip(`Documentation from ${url}${title ? ` (${title})` : ""}:\n${text}`) };
}

/**
 * The names in one directory, directories marked with a trailing `/`.
 * Skipped names (`node_modules` and friends) are left out by the walker,
 * so a reader cannot forget them.
 */
export type DirReader = (path: string) => Promise<string[]>;

/**
 * The folder tree as an indented listing: directories end in `/`, deeper
 * levels indent two spaces, skipped directories never appear, and the walk
 * stops at the depth or entry cap with a line saying so.
 */
export async function folderTree(root: string, readDir: DirReader): Promise<string> {
  const lines: string[] = [`${root}/`];
  let entries = 0;
  let cut = false;
  const walk = async (path: string, prefix: string, depth: number): Promise<void> => {
    if (cut || depth > MAX_TREE_DEPTH) return;
    let names: string[];
    try {
      names = await readDir(path);
    } catch {
      lines.push(`${prefix}(unreadable)`);
      return;
    }
    for (const name of names) {
      const dir = name.endsWith("/");
      if (dir && SKIPPED_DIRS.has(name.slice(0, -1))) continue;
      if (entries >= MAX_TREE_ENTRIES) {
        cut = true;
        break;
      }
      entries++;
      lines.push(prefix + name);
      if (dir) await walk(`${path}/${name.slice(0, -1)}`, `${prefix}  `, depth + 1);
    }
  };
  await walk(root, "", 1);
  if (cut) lines.push(`… (tree cut at ${MAX_TREE_ENTRIES.toLocaleString()} entries)`);
  return lines.join("\n");
}

/**
 * A documentation page as text: HTML stripped to its words (scripts and
 * styles with their contents dropped, tags off, whitespace collapsed), any
 * other text type as itself. Rejects a non-2xx answer with its status.
 */
export async function fetchDocText(
  url: string,
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<{ title: string; text: string }> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const raw = await response.text();
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("html")) {
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw);
    const title = decodeEntities((titleMatch?.[1] ?? "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    const text = decodeEntities(
      raw
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<(?:p|div|br|li|h[1-6]|tr|section|article)(?:\s[^>]*)?>/gi, "\n")
        .replace(/<[^>]+>/g, " "),
    )
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return { title, text };
  }
  return { title: "", text: raw.trim() };
}

/** The entities an HTML page's text and title actually carry. */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** The provider's name in UI strings, e.g. a QuickPick title. */
export function mentionLabel(kind: MentionKind): string {
  switch (kind) {
    case "file":
      return "File contents";
    case "folder":
      return "Folder tree";
    case "terminal":
      return "Terminal output";
    case "git":
      return "Git changes";
    case "docs":
      return "Documentation page";
  }
}
