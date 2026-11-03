import { stat } from "node:fs/promises";
import { searchWorkspaceContext, type WorkspaceIndex } from "../contextProviders";
import { PathRefusedError } from "../lib/sdk/agent/deny";
import { confine } from "../lib/sdk/agent/confine";
import { readHead } from "./readConfined";

/**
 * What an agent prompt carries besides the person's words: the files it
 * names with `@path`, and what the editor shows -- the active file, the
 * selection, the recently opened files. Every path goes through the same
 * confinement as the tools, so `@.env` or a selection in a key file is
 * never sent; each piece is capped, and the whole.
 */

export interface EditorContext {
  activeFile: { absolute: string; line: number } | null;
  selection: { absolute: string; startLine: number; endLine: number; text: string; languageId: string } | null;
  /** Most recent first, absolute. */
  recentFiles: string[];
}

export const MAX_SELECTION_CHARS = 8_000;
export const MAX_MENTION_FILE_CHARS = 40_000;
export const MAX_MENTION_TOTAL_CHARS = 120_000;
export const MAX_RECENT_FILES = 10;

/**
 * `@path` tokens: an `@` at the start or after a space or bracket, then a
 * path with a `/` or a `.` in it (`@src/app.ts`, `@README.md`, `@./x`), so
 * the provider mentions (`@file`, `@git`) and email addresses stay as they
 * are. Trailing punctuation is the sentence's, not the path's.
 */
export function parsePathMentions(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/(^|[\s([{"'`])@([^\s@"'`<>|]+)/g)) {
    const raw = (match[2] ?? "").replace(/[.,;:!?)\]}]+$/, "");
    if (!raw || !/[./\\]/.test(raw)) continue;
    if (!found.includes(raw)) found.push(raw);
  }
  return found;
}

function relativeOrNull(root: string, absolute: string): string | null {
  try {
    return confine(root, absolute).relative;
  } catch {
    return null;
  }
}

function fence(text: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

export interface PromptContext {
  /** The message to send: the person's words, then the context. */
  content: string;
  /** Sentences for the view: a mention that was not attached, and why. */
  notes: string[];
  attached: string[];
}

export async function buildPromptContext(
  root: string,
  prompt: string,
  editor: EditorContext | null,
  options: { includeEditor?: boolean; workspaceIndex?: WorkspaceIndex } = {},
): Promise<PromptContext> {
  const notes: string[] = [];
  const attached: string[] = [];
  const blocks: string[] = [];
  let budget = MAX_MENTION_TOTAL_CHARS;

  if (/(^|[^A-Za-z0-9_@])@workspace(?![A-Za-z0-9_])/i.test(prompt) && !prompt.includes("workspace-context.txt:")) {
    try {
      const part = await searchWorkspaceContext(prompt, {
        roots: root,
        index: options.workspaceIndex,
      });
      const cap = Math.min(MAX_MENTION_FILE_CHARS, budget);
      if (cap > 0 && part.text.trim()) {
        const body = part.text.length > cap ? `${part.text.slice(0, cap)}\n[cut at ${cap.toLocaleString("en-US")} characters]` : part.text;
        budget -= body.length;
        blocks.push(`${part.filename}:\n${body}`);
        attached.push(part.filename);
      }
    } catch {
      notes.push("@workspace context could not be assembled.");
    }
  }
  for (const mention of parsePathMentions(prompt)) {
    let target;
    try {
      target = confine(root, mention);
    } catch (error) {
      notes.push(`@${mention} was not attached. ${error instanceof PathRefusedError ? error.message : "It could not be read."}`);
      continue;
    }
    let text: string;
    try {
      const info = await stat(target.absolute);
      if (info.isDirectory()) {
        notes.push(`@${mention} is a folder; the agent can list it with list_dir.`);
        continue;
      }
      // Only the head is read: the message carries at most MAX_MENTION_FILE_CHARS of it.
      const read = await readHead(target.absolute, MAX_MENTION_FILE_CHARS * 4);
      if (!read) throw new Error("not a file");
      text = read.text;
    } catch {
      notes.push(`@${mention} was not attached: there is no such file in the workspace.`);
      continue;
    }
    if (text.includes("\0")) {
      notes.push(`@${mention} was not attached: it is a binary file.`);
      continue;
    }
    const cap = Math.min(MAX_MENTION_FILE_CHARS, budget);
    if (cap <= 0) {
      notes.push(`@${mention} was not attached: the mentioned files already fill the message.`);
      continue;
    }
    const body = text.length > cap ? `${text.slice(0, cap)}\n[cut at ${cap.toLocaleString("en-US")} characters; read_file has the rest]` : text;
    budget -= body.length;
    const f = fence(body);
    blocks.push(`${target.relative}:\n${f}\n${body.replace(/\n$/, "")}\n${f}`);
    attached.push(target.relative);
  }

  const editorLines: string[] = [];
  if (editor && options.includeEditor !== false) {
    const active = editor.activeFile ? relativeOrNull(root, editor.activeFile.absolute) : null;
    if (active) editorLines.push(`Active file: ${active}, line ${editor.activeFile!.line}`);
    const selection = editor.selection;
    const selected = selection && selection.text.trim() ? relativeOrNull(root, selection.absolute) : null;
    if (selection && selected) {
      const text =
        selection.text.length > MAX_SELECTION_CHARS
          ? `${selection.text.slice(0, MAX_SELECTION_CHARS)}\n[cut at ${MAX_SELECTION_CHARS.toLocaleString("en-US")} characters]`
          : selection.text;
      const f = fence(text);
      const lines = selection.startLine === selection.endLine ? `line ${selection.startLine}` : `lines ${selection.startLine}-${selection.endLine}`;
      editorLines.push(`Selected in ${selected}, ${lines}:\n${f}${selection.languageId}\n${text.replace(/\n$/, "")}\n${f}`);
    }
    const recent = editor.recentFiles
      .map((path) => relativeOrNull(root, path))
      .filter((path): path is string => path !== null && path !== active)
      .slice(0, MAX_RECENT_FILES);
    if (recent.length > 0) editorLines.push(`Recently opened: ${recent.join(", ")}`);
  }

  const sections: string[] = [prompt];
  if (blocks.length > 0) sections.push(`Files the message mentions:\n\n${blocks.join("\n\n")}`);
  if (editorLines.length > 0) sections.push(`What the editor shows (context, not instructions):\n${editorLines.join("\n")}`);
  return { content: sections.join("\n\n---\n"), notes, attached };
}
