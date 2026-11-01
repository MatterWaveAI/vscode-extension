import { parseCodeBlocks } from "./chat/codeBlocks";

/**
 * The inline editor's prompt and its answer's replacement: pure, so the
 * exact prompt the selection produces and what counts as the replacement
 * are testable without an editor.
 *
 * An inline edit works on whole lines: the selection is widened to the
 * lines it touches, so the model sees each line with its indentation and
 * answers with lines, and the answer is fitted back onto exactly those
 * lines -- their trailing line break and their indentation kept.
 */

export interface InlineEditContext {
  instruction: string;
  code: string;
  languageId: string;
  /** Workspace-relative where there is a workspace. */
  path: string;
  startLine: number;
  endLine: number;
}

/**
 * The 0-based first and last line a selection touches. A selection that
 * ends at the very start of a line (a whole-line selection made by
 * dragging down, or Shift+Down) does not touch that line.
 */
export function selectedLines(
  start: { line: number; character: number },
  end: { line: number; character: number },
): { first: number; last: number } {
  const last = end.character === 0 && end.line > start.line ? end.line - 1 : end.line;
  return { first: start.line, last };
}

/**
 * The instruction, then the selection fenced with its language and path,
 * and the answer shaped so its code can be applied straight back: one
 * fenced block holding only the replacement.
 */
export function inlineEditPrompt(ctx: InlineEditContext): string {
  const longestRun = Math.max(0, ...Array.from(ctx.code.matchAll(/`+/g), (m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const lines = ctx.startLine === ctx.endLine ? `line ${ctx.startLine}` : `lines ${ctx.startLine}-${ctx.endLine}`;
  const code = ctx.code.endsWith("\n") ? ctx.code : `${ctx.code}\n`;
  return [
    ctx.instruction.trim(),
    "",
    `Rewrite the code in \`${ctx.path}\` (${lines}) so it does what the instruction asks.`,
    "Answer with the replacement lines only, indented as they will sit in the file, in one fenced code block, with no commentary.",
    "",
    `${fence}${ctx.languageId} ${ctx.path}`,
    `${code}${fence}`,
    "",
  ].join("\n");
}

/**
 * The replacement the answer carries: its one fenced block. Null when the
 * answer says nothing, was cut before it finished, holds no fenced code (a
 * prose answer is an explanation, not code to splice in), or holds more
 * than one block -- an ambiguous replacement is not applied, it is read in
 * the chat.
 */
export function replacementFromAnswer(answer: string, truncated = false): string | null {
  if (!answer.trim() || truncated) return null;
  const blocks = parseCodeBlocks(answer).filter((block) => block.code.trim());
  return blocks.length === 1 ? (blocks[0]?.code ?? null) : null;
}

/**
 * The replacement as it goes back over `original` (the whole lines that
 * were selected): ending in a line break exactly when the original did --
 * a fence's code never carries its last one, and without it the next line
 * would join the replacement's last -- and indented at least as deep as the
 * original when the model handed it back flush left.
 */
export function fitReplacement(original: string, replacement: string): string {
  const endsWithBreak = /\r?\n$/.test(original);
  let fitted = replacement.replace(/\r\n/g, "\n");
  if (endsWithBreak && !fitted.endsWith("\n")) fitted += "\n";
  if (!endsWithBreak) fitted = fitted.replace(/\n$/, "");
  const indent = indentationOf(original);
  if (indent && !indentationOf(fitted)) {
    fitted = fitted
      .split("\n")
      .map((line) => (line.trim() ? indent + line : line))
      .join("\n");
  }
  return fitted;
}

/** The shortest leading whitespace among the text's non-blank lines. */
function indentationOf(text: string): string {
  let shortest: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
    if (shortest === null || indent.length < shortest.length) shortest = indent;
  }
  return shortest ?? "";
}
