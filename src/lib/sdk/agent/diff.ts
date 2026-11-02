/**
 * A unified diff of two texts, the one an approval shows before a write.
 *
 * A line-for-line port of the Python SDK's `matterwave_sdk.agent.diff`, so
 * both clients print the same diff for the same change: Myers' shortest
 * edit script over lines, after the common prefix and suffix are set aside,
 * with each run of changes printed as its removals and then its additions.
 * A change too large for the edit-distance cap is printed as one block of
 * removals and additions, which is still a correct diff, only not the
 * shortest.
 */

import { DIFF_CONTEXT_LINES, DIFF_MAX_EDIT_DISTANCE } from "./types.js";

export const NO_NEWLINE = "\\ No newline at end of file";

/** An opcode: tag, then a[i1:i2] and b[j1:j2]. */
type Opcode = [tag: "equal" | "change", i1: number, i2: number, j1: number, j2: number];
type Op = "e" | "d" | "i";

/**
 * The lines of `text`, each with its `\n`; the last keeps none when the text
 * does not end in one. Only LF splits a line: a CR stays part of its line,
 * so a CRLF file diffs as itself.
 */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  const lines = parts.slice(0, -1).map((part) => part + "\n");
  const last = parts[parts.length - 1]!;
  if (last !== "") lines.push(last);
  return lines;
}

function myers(a: string[], b: string[], maxD: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, maxD);
  const offset = limit + 1;
  const v = new Array<number>(2 * limit + 3).fill(0);
  const trace: number[][] = [];
  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
        x = v[offset + k + 1]!;
      } else {
        x = v[offset + k - 1]! + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m);
    }
  }
  return null;
}

function backtrack(trace: number[][], n: number, m: number): Op[] {
  let x = n;
  let y = m;
  const ops: Op[] = [];
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d]!;
    const base = d + 1;
    const k = x - y;
    const down = k === -d || (k !== d && vd[base + k - 1]! < vd[base + k + 1]!);
    const prevK = down ? k + 1 : k - 1;
    const prevX = vd[base + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push("e");
      x -= 1;
      y -= 1;
    }
    if (d > 0) {
      if (x === prevX) {
        ops.push("i");
        y -= 1;
      } else {
        ops.push("d");
        x -= 1;
      }
    }
  }
  return ops.reverse();
}

function opcodes(a: string[], b: string[], maxD: number): Opcode[] {
  const n = a.length;
  const m = b.length;
  let prefix = 0;
  while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && a[n - 1 - suffix] === b[m - 1 - suffix]) suffix += 1;
  const midA = a.slice(prefix, n - suffix);
  const midB = b.slice(prefix, m - suffix);
  let middle = myers(midA, midB, maxD);
  if (middle === null) {
    middle = [...new Array<Op>(midA.length).fill("d"), ...new Array<Op>(midB.length).fill("i")];
  }
  const ops: Op[] = [...new Array<Op>(prefix).fill("e"), ...middle, ...new Array<Op>(suffix).fill("e")];

  const codes: Opcode[] = [];
  let i = 0;
  let j = 0;
  let at = 0;
  while (at < ops.length) {
    const i1 = i;
    const j1 = j;
    if (ops[at] === "e") {
      while (at < ops.length && ops[at] === "e") {
        i += 1;
        j += 1;
        at += 1;
      }
      codes.push(["equal", i1, i, j1, j]);
    } else {
      while (at < ops.length && ops[at] !== "e") {
        if (ops[at] === "d") i += 1;
        else j += 1;
        at += 1;
      }
      codes.push(["change", i1, i, j1, j]);
    }
  }
  return codes;
}

/** The opcodes cut into hunks with `context` equal lines around each change, as difflib's `get_grouped_opcodes` cuts them. */
function groups(input: Opcode[], context: number): Opcode[][] {
  if (input.length === 0) return [];
  const codes = input.map((c) => [...c] as Opcode);
  const first = codes[0]!;
  if (first[0] === "equal") {
    codes[0] = ["equal", Math.max(first[1], first[2] - context), first[2], Math.max(first[3], first[4] - context), first[4]];
  }
  const last = codes[codes.length - 1]!;
  if (last[0] === "equal") {
    codes[codes.length - 1] = ["equal", last[1], Math.min(last[2], last[1] + context), last[3], Math.min(last[4], last[3] + context)];
  }
  const out: Opcode[][] = [];
  let group: Opcode[] = [];
  for (const code of codes) {
    const [tag, , i2, , j2] = code;
    let i1 = code[1];
    let j1 = code[3];
    if (tag === "equal" && i2 - i1 > 2 * context) {
      group.push([tag, i1, Math.min(i2, i1 + context), j1, Math.min(j2, j1 + context)]);
      out.push(group);
      group = [];
      i1 = Math.max(i1, i2 - context);
      j1 = Math.max(j1, j2 - context);
    }
    group.push([tag, i1, i2, j1, j2]);
  }
  if (group.length > 0 && !(group.length === 1 && group[0]![0] === "equal")) out.push(group);
  return out.filter((g) => g.some((code) => code[0] !== "equal"));
}

function range(start: number, stop: number): string {
  let beginning = start + 1;
  const length = stop - start;
  if (length === 1) return String(beginning);
  if (length === 0) beginning -= 1;
  return `${beginning},${length}`;
}

function emit(out: string[], prefix: string, line: string): void {
  if (line.endsWith("\n")) {
    out.push(prefix + line);
  } else {
    out.push(prefix + line + "\n");
    out.push(NO_NEWLINE + "\n");
  }
}

/** Internal: the edit-distance cap, overridable so a test can reach the fallback. */
export const diffSettings = { maxEditDistance: DIFF_MAX_EDIT_DISTANCE };

/**
 * The unified diff from `oldText` to `newText`, headed `--- a/<path>` and
 * `+++ b/<path>`, with `context` unchanged lines around each change (the
 * contract's 3 by default). Empty when the texts are equal. A last line
 * without a newline is marked the way `diff -u` marks it.
 */
export function unifiedDiff(oldText: string, newText: string, path = "file", options: { context?: number } = {}): string {
  if (oldText === newText) return "";
  const context = options.context ?? DIFF_CONTEXT_LINES;
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const out = [`--- a/${path}\n`, `+++ b/${path}\n`];
  for (const group of groups(opcodes(a, b, diffSettings.maxEditDistance), context)) {
    const first = group[0]!;
    const last = group[group.length - 1]!;
    out.push(`@@ -${range(first[1], last[2])} +${range(first[3], last[4])} @@\n`);
    for (const [tag, i1, i2, j1, j2] of group) {
      if (tag === "equal") {
        for (const line of a.slice(i1, i2)) emit(out, " ", line);
        continue;
      }
      for (const line of a.slice(i1, i2)) emit(out, "-", line);
      for (const line of b.slice(j1, j2)) emit(out, "+", line);
    }
  }
  return out.join("");
}
