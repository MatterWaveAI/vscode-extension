/**
 * Fenced code blocks in a model answer, with the file each is for.
 *
 * The association comes from the info string the way this extension itself
 * writes selections (` ```python api/jobs.py `), the way the web app writes
 * fences, and the common ` ```ts:src/a.ts ` shorthand; a block with a bare
 * language or none at all has none, and the apply flow asks which file it
 * replaces. Pure, so the association rules are testable without a renderer.
 */

export interface CodeBlock {
  /** Position among all fenced blocks of the text, 0-based. */
  index: number;
  /** The info string's language, when it carries one. */
  language: string | null;
  /** The file the block replaces, when the model named one. */
  filename: string | null;
  code: string;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*(.*)$/;
/** A language word: no separators a path would carry. */
const LANGUAGE = /^[\w+#.-]{1,20}$/;
/** A path: `dir/name.ext`, or `name.ext`. */
const PATH = /^[\w@.-]+(?:\/[\w@.-]+)+$|^[\w@-]+\.[A-Za-z][\w.]{0,20}$/;

/** Every fenced block, in order, unterminated ones included. */
export function parseCodeBlocks(text: string): CodeBlock[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: CodeBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = FENCE.exec(lines[i] ?? "");
    if (!open) {
      i++;
      continue;
    }
    const marker = open[1] ?? "```";
    const association = associationOf(open[2] ?? "");
    const body: string[] = [];
    i++;
    while (i < lines.length && !(lines[i] ?? "").trim().startsWith(marker)) body.push(lines[i++] ?? "");
    i++; // the closing fence, or past the end of an unterminated block
    blocks.push({ index: blocks.length, ...association, code: body.join("\n") });
  }
  return blocks;
}

/** The block `index` names, or null when the text has no such block. */
export function codeBlockAt(text: string, index: number): CodeBlock | null {
  return parseCodeBlocks(text)[index] ?? null;
}

function associationOf(info: string): { language: string | null; filename: string | null } {
  const tokens = info.split(/\s+/).filter(Boolean);
  let language: string | null = null;
  let candidates = tokens;
  const first = tokens[0] ?? "";
  // The first word is the language when it reads as one; a path stays one.
  if (tokens.length > 0 && LANGUAGE.test(first) && !PATH.test(first)) {
    language = first;
    candidates = tokens.slice(1);
  }
  const filename =
    candidates
      .map((token) => token.replace(/:$/, "").replace(/^[\w+#.-]{1,12}:(?=\s*\S)/, ""))
      .find((token) => PATH.test(token)) ?? null;
  return { language, filename };
}
