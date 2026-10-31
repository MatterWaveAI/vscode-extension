import { parseCodeBlocks } from "./chat/codeBlocks";

/**
 * The inline editor's prompt and its answer's replacement: pure, so the
 * exact prompt the selection produces and what counts as the replacement
 * are testable without an editor.
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
    "Answer with the replacement code only, in one fenced code block, with no commentary.",
    "",
    `${fence}${ctx.languageId} ${ctx.path}`,
    `${code}${fence}`,
    "",
  ].join("\n");
}

/**
 * The replacement the answer carries: its one fenced block, or the whole
 * trimmed answer when the model answered without a fence. Null when the
 * answer says nothing, was cut before it finished, or names more than one
 * block -- an ambiguous replacement is not applied, it is read in the chat.
 */
export function replacementFromAnswer(answer: string, truncated = false): string | null {
  if (!answer.trim() || truncated) return null;
  const blocks = parseCodeBlocks(answer).filter((block) => block.code.trim());
  if (blocks.length > 1) return null;
  if (blocks.length === 1) return blocks[0]!.code;
  return answer.trim();
}
