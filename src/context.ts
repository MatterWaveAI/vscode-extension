/**
 * Turning editor context into what a turn sends. Pure, so the exact `content`
 * and attachment naming are testable without an editor.
 */

/** `SendMessage.content`'s cap on the API. */
export const MAX_CONTENT_CHARS = 100_000;

export interface SelectionContext {
  question: string;
  code: string;
  languageId: string;
  /** Workspace-relative where there is a workspace, so no home path leaks into a prompt. */
  path: string;
  startLine: number;
  endLine: number;
}

/**
 * The question, then the selection as a fenced block tagged with the language
 * id and the path. The fence is one backtick longer than the longest run in
 * the code, so a selection containing a fence cannot close ours early.
 */
export function selectionContent(ctx: SelectionContext): string {
  const longestRun = Math.max(0, ...Array.from(ctx.code.matchAll(/`+/g), (m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const lines = ctx.startLine === ctx.endLine ? `line ${ctx.startLine}` : `lines ${ctx.startLine}-${ctx.endLine}`;
  const code = ctx.code.endsWith("\n") ? ctx.code : `${ctx.code}\n`;
  return `${ctx.question.trim()}\n\n\`${ctx.path}\` (${lines}):\n\n${fence}${ctx.languageId} ${ctx.path}\n${code}${fence}\n`;
}

/** Whether the selection fits the API's content cap once wrapped. */
export function fitsContentCap(content: string): boolean {
  return content.length <= MAX_CONTENT_CHARS;
}

/**
 * The upload for "ask about file". Sent as `text/plain` because that is a
 * type the API extracts as text; the real file type rides in the filename,
 * which is the workspace-relative path the model needs anyway.
 */
export function fileAttachment(text: string, path: string): { blob: Blob; filename: string } {
  return { blob: new Blob([text], { type: "text/plain" }), filename: path };
}
