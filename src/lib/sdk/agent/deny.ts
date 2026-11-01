/**
 * The deny list and the refusal, with no filesystem in sight: the matching
 * rules every client applies, browser-safe. `confine` (in the Node-only
 * `@matterwave/sdk/agent` entry) builds on them.
 */

import { DEFAULT_DENY, PROTECTED, REFUSALS, type Refusal } from "./types.js";

/**
 * The path is not one the agent may use. `reason` is the contract's code
 * (`empty`, `parent`, `outside`, `symlink`, `denied`, `protected`); `message`
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

function escapeRegex(c: string): string {
  return c.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

/**
 * The regular expression source (to match whole) for one glob: `*` and `?`
 * stay within a segment, `**` followed by `/` spans any number of segments,
 * `[...]` is a class (`[!...]` negated), everything else is literal.
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
      const end = glob.indexOf("]", i + 2);
      if (end === -1) {
        out += "\\[";
      } else {
        let body = glob.slice(i + 1, end);
        if (body.startsWith("!")) body = "^" + body.slice(1);
        out += "[" + body.split("\\").join("\\\\") + "]";
        i = end + 1;
        continue;
      }
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
  return { regex: new RegExp(`^(?:${globToRegex(text)})$`, "i"), dirOnly, anchored };
}

/**
 * Patterns a path may not match: the contract's defaults (`.env*`, `*.pem`,
 * `id_*`, `.git/`) plus the workspace's `.matterwaveignore` lines, which
 * `loadDenyList(root)` reads. The syntax is the contract's `pattern_syntax`,
 * a subset of .gitignore's without negation.
 */
export class DenyList {
  readonly patterns: readonly string[];
  private readonly compiled: Pattern[];

  constructor(patterns: Iterable<string> = DEFAULT_DENY) {
    this.patterns = [...patterns];
    this.compiled = this.patterns.map(compile).filter((p): p is Pattern => p !== null);
  }

  /** The defaults plus every pattern line of a `.matterwaveignore`'s text. */
  static withIgnoreFile(text: string): DenyList {
    return new DenyList([...DEFAULT_DENY, ...text.split(/\r?\n/)]);
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

/** The paths the agent can read but never write. */
export const PROTECTED_LIST = new DenyList(PROTECTED);

/**
 * Absolute on any platform: a leading `/` or `\`, or a drive letter (`C:`
 * and `C:\`), so a Windows path is not taken for a relative one on POSIX,
 * nor `/etc` for a relative one on Windows.
 */
export function isAbsolute(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path);
}
