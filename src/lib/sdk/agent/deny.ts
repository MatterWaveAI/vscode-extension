/**
 * The deny list and the refusal, with no filesystem in sight: the matching
 * rules every client applies, browser-safe. `confine` (in the Node-only
 * `@matterwave/sdk/agent` entry) builds on them.
 */

import { DEFAULT_DENY, PROTECTED, REFUSALS, type Refusal } from "./types.js";

const BOM = "\ufeff";

/**
 * The path is not one the agent may use. `reason` is the contract's code
 * (`empty`, `parent`, `outside`, `symlink`, `loop`, `denied`, `protected`,
 * and the Windows aliases `stream`, `trailing`, `device`, `unc`); `message`
 * is the sentence to return to the model as the tool's result.
 */
export class PathRefusedError extends Error {
  readonly reason: Refusal;
  readonly path: string;

  constructor(reason: Refusal, path: string) {
    super(REFUSALS[reason].split("{path}").join(path));
    this.name = "PathRefusedError";
    this.reason = reason;
    this.path = path;
  }
}

/** `c` escaped for a regular expression's source. */
export function escapeRegex(c: string): string {
  return c.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

/**
 * A glob the contract calls invalid: a `[...]` class with a range that runs
 * backwards (`[z-a]`). `glob` is the pattern. glob and grep turn it into the
 * `invalid_glob` ToolError; an ignore or deny file skips the line, as git
 * does.
 */
export class GlobError extends Error {
  readonly glob: string;

  constructor(glob: string) {
    super(`${JSON.stringify(glob)} has a [...] range that runs backwards`);
    this.name = "GlobError";
    this.glob = glob;
  }
}

/**
 * The regex for the `[...]` class at `glob[start]` and the index after it, or
 * null when no `]` closes it (the `[` is then literal). A `!` or `^` first
 * negates it, a `]` right after that (or right after the `[`) is literal,
 * `a-z` is a range and every other character is itself, each escaped, so
 * every regex dialect reads the class alike.
 */
function globClass(glob: string, start: number): [string, number] | null {
  let i = start + 1;
  const negate = i < glob.length && (glob[i] === "!" || glob[i] === "^");
  if (negate) i += 1;
  const bodyStart = i;
  if (glob[i] === "]") i += 1;
  const end = glob.indexOf("]", i);
  if (end === -1) return null;
  const body = glob.slice(bodyStart, end);
  let out = "";
  let k = 0;
  while (k < body.length) {
    if (k + 2 < body.length && body[k + 1] === "-") {
      const low = body[k]!;
      const high = body[k + 2]!;
      if (low.charCodeAt(0) > high.charCodeAt(0)) throw new GlobError(glob);
      out += `${escapeRegex(low)}-${escapeRegex(high)}`;
      k += 3;
    } else {
      out += escapeRegex(body[k]!);
      k += 1;
    }
  }
  return [`[${negate ? "^" : ""}${out}]`, end + 1];
}

/**
 * The regular expression source (to match whole) for one glob: `*` and `?`
 * stay within a segment, `**` followed by `/` spans any number of segments,
 * `[...]` is a class (`[!...]` or `[^...]` negated, a `]` first in it
 * literal), everything else is literal. `GlobError` when a class's range runs
 * backwards (`[z-a]`).
 */
export function globToRegex(glob: string): string {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob.startsWith("**", i)) {
        if (glob.startsWith("/", i + 2)) {
          out += "(?:.*/)?";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
        continue;
      }
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "[") {
      const found = globClass(glob, i);
      if (found !== null) {
        out += found[0];
        i = found[1];
        continue;
      }
      out += "\\[";
    } else {
      out += escapeRegex(c);
    }
    i += 1;
  }
  return out;
}

interface Pattern {
  regex: RegExp;
  dirOnly: boolean;
  anchored: boolean;
}

function compile(pattern: string): Pattern | null {
  let text = pattern.trim();
  if (text === "" || text.startsWith("#") || text.startsWith("!")) return null;
  const dirOnly = text.endsWith("/");
  text = text.replace(/\/+$/, "");
  const anchored = text.startsWith("/") || text.includes("/");
  text = text.replace(/^\/+/, "");
  if (text === "") return null;
  try {
    return { regex: new RegExp(`^(?:${globToRegex(text)})$`, "i"), dirOnly, anchored };
  } catch {
    return null;
  }
}

/**
 * Patterns a path may not match: the contract's defaults (`.env*`, `*.pem`,
 * `id_*`, `.git/`) plus the workspace's `.matterwaveignore` lines, which
 * `loadDenyList(root)` reads. The syntax is the contract's `pattern_syntax`,
 * a subset of .gitignore's without negation; a line whose pattern is invalid
 * (a `[...]` range that runs backwards) is skipped, as git skips it.
 */
export class DenyList {
  readonly patterns: readonly string[];
  private readonly compiled: Pattern[];

  constructor(patterns: Iterable<string> = DEFAULT_DENY) {
    this.patterns = [...patterns];
    this.compiled = this.patterns.map(compile).filter((p): p is Pattern => p !== null);
  }

  /** The defaults plus every pattern line of a `.matterwaveignore`'s text, a leading byte-order mark dropped. */
  static withIgnoreFile(text: string): DenyList {
    const body = text.startsWith(BOM) ? text.slice(BOM.length) : text;
    return new DenyList([...DEFAULT_DENY, ...body.split(/\r?\n/)]);
  }

  /**
   * Whether `relative` (to the root, `/`-separated) is denied. A pattern
   * that matches a directory on the way denies everything under it; `isDir`
   * says whether the last segment is a directory.
   */
  matches(relative: string, options: { isDir?: boolean } = {}): boolean {
    const isDir = options.isDir ?? false;
    const segments = relative
      .split("\\")
      .join("/")
      .split("/")
      .filter((s) => s !== "" && s !== ".");
    const last = segments.length - 1;
    for (const pattern of this.compiled) {
      for (let index = 0; index < segments.length; index++) {
        const segmentIsDir = index < last || isDir;
        if (pattern.dirOnly && !segmentIsDir) continue;
        const subject = pattern.anchored ? segments.slice(0, index + 1).join("/") : segments[index]!;
        if (pattern.regex.test(subject)) return true;
      }
    }
    return false;
  }
}

/**
 * The protected paths (`PROTECTED`) as a matcher: the deny file, the agent's
 * settings folder (`.matterwave/`), the context files (MATTERWAVE.md,
 * AGENTS.md, MATTERWAVE.local.md), and what matters when the root is the home
 * folder or above it: the shell startup files (`.bashrc`, `.bash_profile`,
 * `.profile`, `.zshrc`, `.zprofile`), the credential folders (`.ssh/`,
 * `.aws/`) and `.config/matterwave` at any depth. They can be read; a write
 * to one asks the user first in every mode that allows writes, yolo included
 * (`allowed(..., { path })` says `ask`), and `confine` refuses it unless
 * `approved: true`.
 */
export const PROTECTED_LIST = new DenyList(PROTECTED);

/** Whether `relative` (to the root, `/`-separated) is one of the protected paths (`PROTECTED_LIST`), so a write to it needs the user's approval in every mode. */
export function isProtected(relative: string, options: { isDir?: boolean } = {}): boolean {
  return PROTECTED_LIST.matches(relative, options);
}

const DEVICE = /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3]|conin\$|conout\$)$/i;

function namesOf(path: string): string[] {
  return path.split(/[\\/]/).filter((n) => n !== "" && n !== ".");
}

/**
 * The refusal for a path Windows could read as something other than the file
 * it seems to name, or null: `unc` for a `\\?\`, `\\.\`, `\??\` or network
 * path, then, name by name, `stream` for a `:` (an alternate data stream, or a
 * drive-relative `C:x`), `trailing` for a name that ends in a dot or a space,
 * and `device` for CON, PRN, AUX, NUL, COM1-9, LPT1-9, CONIN$ or CONOUT$, in
 * any case and with or without an extension. `confine` applies it on every
 * platform, so the clients agree on what they refuse.
 *
 * With `root`, the names are those below the root: an absolute path whose
 * leading names are the root's (compared name by name, case ignored, `/` and
 * `\` both separators) is checked from the name after them, so a root inside
 * `/x/con/` still takes absolute paths into it. Any other path is checked
 * whole. Pure: nothing is read from disk.
 */
export function windowsAlias(path: string, root?: string): Refusal | null {
  if (path.length >= 2 && "\\/".includes(path[0]!) && "\\/".includes(path[1]!)) return "unc";
  if (["\\??\\", "/??/"].includes(path.slice(0, 4))) return "unc";
  let names: string[] | null = null;
  if (root !== undefined && isAbsolute(path)) {
    const rootNames = namesOf(root).map((n) => n.toLowerCase());
    const given = namesOf(path);
    if (rootNames.every((n, i) => given[i]?.toLowerCase() === n)) names = given.slice(rootNames.length);
  }
  for (const name of names ?? namesOf(path.replace(/^[A-Za-z]:(?=[\\/]|$)/, ""))) {
    if (name.includes(":")) return "stream";
    if (name.endsWith(".") || name.endsWith(" ")) return "trailing";
    if (DEVICE.test(name.split(".")[0]!.replace(/ +$/, ""))) return "device";
  }
  return null;
}

/**
 * Absolute on any platform: a leading `/` or `\`, or a drive letter (`C:`
 * and `C:\`), so a Windows path is not taken for a relative one on POSIX,
 * nor `/etc` for a relative one on Windows.
 */
export function isAbsolute(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path);
}
