/**
 * `edit`'s exact-replace semantics, on text, with no file in sight: the
 * client reads the file, calls `applyEdit`, shows the diff, and writes the
 * result only once it is approved.
 */

import { EDIT_CRLF_FALLBACK, EDIT_ERRORS, type EditFailure } from "./types.js";

/**
 * The edit cannot be applied, and the text is unchanged. `reason` is the
 * contract's code for why; `message` is the contract's sentence for the
 * model, with the path filled in.
 */
export class EditError extends Error {
  readonly reason: EditFailure;
  readonly path: string;
  readonly count: number;

  constructor(reason: EditFailure, path = "", count = 0) {
    super(EDIT_ERRORS[reason].split("{path}").join(path).split("{count}").join(String(count)));
    this.name = "EditError";
    this.reason = reason;
    this.path = path;
    this.count = count;
  }
}

function lfToCrlf(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
}

/** How many places `needle` starts in `text`, overlapping ones counted: "aa" occurs twice in "aaa", so an edit of it is not unique. */
export function occurrences(text: string, needle: string): number {
  let count = 0;
  let at = text.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = text.indexOf(needle, at + 1);
  }
  return count;
}

/**
 * `text` with the one occurrence of `oldString` replaced by `newString`.
 * `EditError` when `oldString` is empty, equals `newString`, is not in
 * `text`, or is in it more than once. When it is not found as given and
 * `text` uses CRLF line endings, the lone LFs of both strings become CRLF and
 * the match is tried once more, so a model that writes LF still edits a
 * Windows file without mixing endings.
 */
export function applyEdit(text: string, oldString: string, newString: string, options: { path?: string } = {}): string {
  const path = options.path ?? "";
  if (oldString === "") throw new EditError("empty", path);
  if (oldString === newString) throw new EditError("unchanged", path);
  let count = occurrences(text, oldString);
  if (count === 0 && EDIT_CRLF_FALLBACK && text.includes("\r\n")) {
    const crlfOld = lfToCrlf(oldString);
    if (crlfOld !== oldString) {
      oldString = crlfOld;
      newString = lfToCrlf(newString);
      count = occurrences(text, oldString);
    }
  }
  if (count === 0) throw new EditError("not_found", path);
  if (count > 1) throw new EditError("not_unique", path, count);
  // Sliced, not String.replace: a `$&` in the new text is text, not a pattern.
  const at = text.indexOf(oldString);
  return text.slice(0, at) + newString + text.slice(at + oldString.length);
}
