/**
 * What the read tools and run_shell return to the model, as the contract's
 * `outputs` spell it, with no filesystem in sight (browser-safe): the client
 * reads the file or runs the command, and these turn the result into the
 * tool's text, so every client numbers lines, marks a cut and words an error
 * the same way.
 *
 * `ToolError` carries the contract's sentence for a tool that cannot answer
 * (a missing file, a bad line range, an invalid regex); return its `message`
 * as the tool's result with the error flag set.
 */

import { globToRegex } from "./deny.js";
import { fill } from "./fill.js";
import { LIMITS, OUTPUTS, TOOL_ERRORS, type LimitName, type ToolFailure } from "./types.js";

/** Overrides for the contract's limits, by name. */
export type Limits = Partial<Record<LimitName, number>>;

/**
 * The tool cannot answer, and nothing was read or run. `reason` is the
 * contract's code; `message` is its sentence for the model with `values`
 * filled in.
 */
export class ToolError extends Error {
  readonly reason: ToolFailure;
  readonly values: Readonly<Record<string, string | number>>;

  constructor(reason: ToolFailure, values: Record<string, string | number> = {}) {
    super(fill(TOOL_ERRORS[reason], Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)]))));
    this.name = "ToolError";
    this.reason = reason;
    this.values = values;
  }
}

/** `LIMITS[name]`, or the override `limits` gives for it. */
export function limit(name: LimitName, limits?: Limits): number {
  return limits?.[name] ?? LIMITS[name];
}

const encoder = new TextEncoder();

function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

/** The longest start of `text` whose UTF-8 fits in `maxBytes`. */
export function utf8Head(text: string, maxBytes: number): string {
  const data = utf8(text);
  if (data.length <= maxBytes) return text;
  let cut = Math.max(maxBytes, 0);
  while (cut > 0 && (data[cut]! & 0xc0) === 0x80) cut -= 1;
  return decodeUtf8(data.subarray(0, cut));
}

/** The longest end of `text` whose UTF-8 fits in `maxBytes`. */
export function utf8Tail(text: string, maxBytes: number): string {
  const data = utf8(text);
  if (data.length <= maxBytes) return text;
  let start = data.length - Math.max(maxBytes, 0);
  while (start < data.length && (data[start]! & 0xc0) === 0x80) start += 1;
  return decodeUtf8(data.subarray(start));
}

/** Whether a file whose bytes start with `data` is binary: a NUL byte in its first `binary_sniff_bytes`. */
export function isBinary(data: Uint8Array, limits?: Limits): boolean {
  const end = Math.min(data.length, limit("binary_sniff_bytes", limits));
  for (let i = 0; i < end; i++) if (data[i] === 0) return true;
  return false;
}

/** A text file's bytes as text: UTF-8, an invalid byte becoming U+FFFD, a byte-order mark kept. */
export function decodeText(data: Uint8Array): string {
  return decodeUtf8(data);
}

/** The lines of `text` as the read tools count them: split at LF, each line's trailing CR dropped, and a final LF starting no further line. */
export function textLines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.map((p) => (p.endsWith("\r") ? p.slice(0, -1) : p));
}

/** Code-point order, as Python compares strings (UTF-16 order differs past the BMP). */
export function compareCodePoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i)!;
    const cb = b.codePointAt(j)!;
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  return i < a.length ? 1 : j < b.length ? -1 : 0;
}

/** The argument errors read_file checks before it looks at the file: `bad_line` for a line number under 1, then `end_before_start`. */
export function checkLines(startLine?: number, endLine?: number): void {
  for (const [name, value] of [
    ["start_line", startLine],
    ["end_line", endLine],
  ] as const) {
    if (value !== undefined && value < 1) throw new ToolError("bad_line", { name, value });
  }
  if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
    throw new ToolError("end_before_start", { start_line: startLine, end_line: endLine });
  }
}

/**
 * read_file's result for a file whose text is `text`: the lines from
 * `startLine` to `endLine`, numbered, cut at the read limits with the
 * contract's marker. `ToolError` for a bad range.
 */
export function formatReadFile(
  text: string,
  path: string,
  options: { startLine?: number; endLine?: number; limits?: Limits } = {},
): string {
  const spec = OUTPUTS.read_file;
  const { startLine, endLine, limits } = options;
  checkLines(startLine, endLine);
  const lines = textLines(text);
  const total = lines.length;
  if (total === 0) return fill(spec.empty, { path });
  const first = startLine ?? 1;
  if (first > total) throw new ToolError("past_end", { start_line: first, path, total });
  const lastWanted = Math.min(endLine ?? total, total);
  const maxLines = limit("read_max_lines", limits);
  const maxBytes = limit("read_max_bytes", limits);
  const out: string[] = [];
  let size = 0;
  for (let n = first; n <= lastWanted; n++) {
    const line = fill(spec.line, { n: String(n), text: lines[n - 1]! });
    const bytes = utf8(line).length;
    if (out.length === 0 && bytes > maxBytes) {
      const marker = fill(spec.line_cut, { line: String(n), max_bytes: String(maxBytes), next: String(n + 1) });
      return utf8Head(line, maxBytes) + "\n" + marker;
    }
    if (out.length > 0 && (out.length >= maxLines || size + bytes + 1 > maxBytes)) break;
    out.push(line);
    size += bytes + 1;
  }
  const last = first + out.length - 1;
  let body = out.join("\n");
  if (last < lastWanted) {
    body +=
      "\n" + fill(spec.cut, { first: String(first), last: String(last), total: String(total), next: String(last + 1) });
  }
  return body;
}

/**
 * list_dir's result for the `[name, isDir]` entries left once denied and
 * ignored ones are out: directories first, then files, each in code-point
 * order, cut at `list_max_entries`.
 */
export function formatListDir(
  path: string,
  entries: Iterable<readonly [string, boolean]>,
  options: { limits?: Limits } = {},
): string {
  const spec = OUTPUTS.list_dir;
  const pairs = [...entries];
  let lines = [
    ...pairs
      .filter(([, d]) => d)
      .map(([n]) => n)
      .sort(compareCodePoints)
      .map((n) => `${n}/`),
    ...pairs
      .filter(([, d]) => !d)
      .map(([n]) => n)
      .sort(compareCodePoints),
  ];
  if (lines.length === 0) return fill(spec.empty, { path });
  const cap = limit("list_max_entries", options.limits);
  if (lines.length > cap) lines = [...lines.slice(0, cap), fill(spec.cut, { more: String(lines.length - cap) })];
  return lines.join("\n");
}

/** glob's result: one path per line, or the no-match sentence; `truncated` adds the marker for a search that stopped at the limit. */
export function formatGlob(
  pattern: string,
  paths: Iterable<string>,
  options: { truncated?: boolean; limits?: Limits } = {},
): string {
  const spec = OUTPUTS.glob;
  const found = [...paths];
  if (found.length === 0) return fill(spec.none, { pattern });
  if (options.truncated) found.push(fill(spec.cut, { limit: String(limit("search_max_results", options.limits)) }));
  return found.join("\n");
}

/** A matching line as grep shows it: trailing whitespace gone, cut to `line_max_chars` code points with an ellipsis. */
export function grepLine(text: string): string {
  const trimmed = text.replace(/[ \t\r\f\v]+$/, "");
  const chars = Array.from(trimmed);
  const cap = OUTPUTS.grep.line_max_chars;
  return chars.length > cap ? chars.slice(0, cap).join("") + OUTPUTS.grep.ellipsis : trimmed;
}

/** grep's result for `[path, lineNumber, lineText]` matches: one line each, or the no-match sentence; `truncated` adds the marker. */
export function formatGrep(
  pattern: string,
  matches: Iterable<readonly [string, number, string]>,
  options: { truncated?: boolean; limits?: Limits } = {},
): string {
  const spec = OUTPUTS.grep;
  const lines = [...matches].map(([p, n, t]) => fill(spec.match, { path: p, line: String(n), text: grepLine(t) }));
  if (lines.length === 0) return fill(spec.none, { pattern });
  if (options.truncated) lines.push(fill(spec.cut, { limit: String(limit("search_max_results", options.limits)) }));
  return lines.join("\n");
}

/**
 * run_shell's result: the status line (a timeout, a stop by the user, the
 * exit code, or an end by a signal when `exitCode` is null), then the
 * output, its middle cut out past `shell_output_max_bytes`.
 *
 * `omitted` is for a client that kept only the start and the end of a long
 * output: pass the two joined as `output` and the number of bytes dropped
 * from between them as `omitted`. The text is cut as though it were the
 * whole output, and the cut is always shown. Keep at least the first and the
 * last half of `shell_output_max_bytes` (whole characters) and the result is
 * the one the whole output would give.
 */
export function formatShell(
  output: string,
  options: {
    exitCode?: number | null;
    timedOut?: boolean;
    stopped?: boolean;
    timeoutS?: number;
    limits?: Limits;
    omitted?: number;
  } = {},
): string {
  const spec = OUTPUTS.shell;
  const omitted = options.omitted ?? 0;
  if (!(omitted >= 0)) throw new RangeError("omitted counts bytes and cannot be negative");
  let status: string;
  if (options.timedOut) {
    const seconds = options.timeoutS ?? limit("shell_timeout_s_default", options.limits);
    status = fill(spec.timeout, { timeout_s: String(seconds) });
  } else if (options.stopped) {
    status = spec.stopped;
  } else if (options.exitCode === undefined || options.exitCode === null) {
    status = spec.signal;
  } else {
    status = fill(spec.exit, { code: String(options.exitCode) });
  }
  if (output === "" && omitted === 0) return `${status}\n${spec.no_output}`;
  const cap = limit("shell_output_max_bytes", options.limits);
  const total = utf8(output).length + omitted;
  let body = output;
  if (total > cap || omitted > 0) {
    const half = Math.floor(cap / 2);
    const head = utf8Head(output, half);
    // The tail comes from what follows the head, so text a client kept short
    // of the cap is never shown twice.
    const tail = utf8Tail(output.slice(head.length), cap - half);
    const cut = total - utf8(head).length - utf8(tail).length;
    body = `${head}\n${fill(spec.cut, { omitted: String(cut) })}\n${tail}`;
  }
  return `${status}\n${body}`;
}

const GLOBS = new Map<string, { regex: RegExp; wholePath: boolean }>();

/** @internal glob's `pattern` compiled, or `ToolError` (`invalid_glob`). */
export function compileGlob(pattern: string): { regex: RegExp; wholePath: boolean } {
  let found = GLOBS.get(pattern);
  if (found === undefined) {
    let text = pattern.startsWith("./") ? pattern.slice(2) : pattern;
    const anchored = text.startsWith("/");
    text = text.replace(/^\/+/, "");
    let regex: RegExp;
    try {
      regex = new RegExp(`^(?:${globToRegex(text)})$`, "i");
    } catch {
      throw new ToolError("invalid_glob", { glob: pattern });
    }
    found = { regex, wholePath: anchored || text.includes("/") };
    if (GLOBS.size >= 256) GLOBS.clear();
    GLOBS.set(pattern, found);
  }
  return found;
}

/**
 * Whether glob's `pattern` matches a file at `relative` (to the search's
 * `path`, `/`-separated): the whole path when the pattern has a `/`,
 * otherwise the file's name at any depth. Case is ignored. `ToolError`
 * (`invalid_glob`) for a pattern whose `[...]` range runs backwards.
 */
export function globMatches(pattern: string, relative: string): boolean {
  const { regex, wholePath } = compileGlob(pattern);
  const subject = wholePath ? relative : relative.slice(relative.lastIndexOf("/") + 1);
  return regex.test(subject);
}
