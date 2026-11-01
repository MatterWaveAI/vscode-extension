import { globToRegex } from "../lib/sdk/agent/deny";

/**
 * `.gitignore` for the agent's searches (`list_dir`, `glob`, `grep`), the
 * part of the contract's `search_ignore_files` the deny list does not
 * cover: negation (`!keep.log`) re-includes, the last matching rule wins,
 * and each file's rules apply from the directory it sits in. The glob
 * translation is the SDK's (`globToRegex`), so `*`, `?`, `[...]` and `**`
 * read the same as the deny list's.
 *
 * Search only: an ignored file can still be read by name, as in git. The
 * deny list (secrets, keys, `.git`) is what refuses a path outright.
 */

interface Rule {
  regex: RegExp;
  negate: boolean;
  dirOnly: boolean;
  anchored: boolean;
  /** The directory the rule's file sits in, root-relative with `/`; empty for the root. */
  base: string;
}

function compile(line: string, base: string, caseless: boolean): Rule | null {
  let text = line.replace(/\r$/, "");
  if (text === "" || text.startsWith("#")) return null;
  // Trailing spaces are dropped unless escaped.
  text = text.replace(/(?<!\\)\s+$/, "");
  let negate = false;
  if (text.startsWith("!")) {
    negate = true;
    text = text.slice(1);
  } else if (text.startsWith("\\!") || text.startsWith("\\#")) {
    text = text.slice(1);
  }
  const dirOnly = text.endsWith("/");
  text = text.replace(/\/+$/, "");
  const anchored = text.includes("/");
  text = text.replace(/^\/+/, "");
  if (text === "") return null;
  return { regex: new RegExp(`^(?:${globToRegex(text)})$`, caseless ? "i" : ""), negate, dirOnly, anchored, base };
}

export class IgnoreRules {
  private constructor(
    private readonly rules: readonly Rule[],
    private readonly caseless: boolean,
  ) {}

  static empty(caseless = process.platform === "win32"): IgnoreRules {
    return new IgnoreRules([], caseless);
  }

  /** These rules plus a `.gitignore`'s text found in `base` (root-relative; empty for the root). */
  with(text: string, base: string): IgnoreRules {
    const added = text
      .split("\n")
      .map((line) => compile(line, base, this.caseless))
      .filter((rule): rule is Rule => rule !== null);
    return added.length === 0 ? this : new IgnoreRules([...this.rules, ...added], this.caseless);
  }

  /**
   * Whether `relative` (root-relative, `/`-separated) is ignored by the rules
   * in force. Callers walk top-down and skip an ignored directory whole, so
   * a parent's exclusion is never re-included from below, as in git.
   */
  ignored(relative: string, isDir: boolean): boolean {
    let result = false;
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDir) continue;
      let subject = relative;
      if (rule.base) {
        if (!relative.startsWith(`${rule.base}/`)) continue;
        subject = relative.slice(rule.base.length + 1);
      }
      const target = rule.anchored ? subject : (subject.split("/").pop() ?? subject);
      if (rule.regex.test(target)) result = !rule.negate;
    }
    return result;
  }
}

/**
 * Whether a root-relative path matches a search glob: against the path
 * under the search base, or, for a pattern with no `/`, against the file's
 * name at any depth (so `*.ts` finds every TypeScript file, as the model
 * usually means).
 */
export function globMatcher(pattern: string, caseless = process.platform === "win32"): (relativeToBase: string) => boolean {
  const cleaned = pattern.trim().replace(/^\.\//, "").replace(/^\/+/, "");
  const regex = new RegExp(`^(?:${globToRegex(cleaned)})$`, caseless ? "i" : "");
  const byName = !cleaned.includes("/");
  return (path) => regex.test(path) || (byName && regex.test(path.split("/").pop() ?? path));
}
