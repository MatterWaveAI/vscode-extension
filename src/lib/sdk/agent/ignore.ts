/**
 * What glob, grep and list_dir leave out: the deny list, and the .gitignore
 * and .matterwaveignore files from the workspace root down. Browser-safe.
 *
 * `IgnoreFile` is one file's rules, for the directory holding it, in the
 * .gitignore syntax: comments, `!` to re-include, a trailing `/` for
 * directories only, a leading or middle `/` to anchor at that directory,
 * `**`, and a backslash to escape; a leading byte-order mark is dropped and a
 * line whose pattern is invalid (a `[...]` range that runs backwards) is
 * skipped, as git does. `SearchIgnore` stacks every file that
 * applies to a path, root first, with the deny list on top: the last rule
 * that matches decides, a path inside an ignored directory stays ignored, and
 * the deny list cannot be re-included. Matching ignores case, so every client
 * on every platform skips the same files.
 *
 * `SearchIgnore` reads each directory's files through the function it is
 * given, the first time a path under it is checked, so the same rules serve
 * a filesystem (`loadSearchIgnore` in `@matterwave/sdk/agent`) or a client
 * that lists files another way.
 */

import { DenyList, escapeRegex, globToRegex } from "./deny.js";
import { SEARCH_IGNORE_FILES } from "./types.js";

const BOM = "\ufeff";

interface Rule {
  regex: RegExp;
  negate: boolean;
  dirOnly: boolean;
  anchored: boolean;
}

function patternRegex(pattern: string): string {
  let out = "";
  let chunk = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "\\" && i + 1 < pattern.length) {
      out += globToRegex(chunk) + escapeRegex(pattern[i + 1]!);
      chunk = "";
      i += 2;
      continue;
    }
    chunk += c;
    i += 1;
  }
  return out + globToRegex(chunk);
}

function parse(line: string): Rule | null {
  let text = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (text === "" || text.startsWith("#")) return null;
  const negate = text.startsWith("!");
  if (negate) text = text.slice(1);
  while (text.endsWith(" ") && !text.endsWith("\\ ")) text = text.slice(0, -1);
  const dirOnly = text.endsWith("/");
  text = text.replace(/\/+$/, "");
  const anchored = text.includes("/");
  if (text.startsWith("/")) text = text.slice(1);
  if (text === "") return null;
  try {
    return { regex: new RegExp(`^(?:${patternRegex(text)})$`, "i"), negate, dirOnly, anchored };
  } catch {
    return null;
  }
}

/**
 * The rules of one .gitignore-syntax file, for the directory holding it
 * (`base`, relative to the workspace root, `""` for the root). A leading
 * byte-order mark is dropped, and an invalid line is skipped.
 */
export class IgnoreFile {
  readonly base: string;
  readonly patterns: readonly string[];
  private readonly rules: Rule[];

  constructor(text: string, base = "") {
    this.base = base.replace(/^\/+|\/+$/g, "");
    this.patterns = (text.startsWith(BOM) ? text.slice(BOM.length) : text).split("\n");
    this.rules = this.patterns.map(parse).filter((r): r is Rule => r !== null);
  }

  /**
   * What this file says of `relative` (to the root, `/`-separated): true when
   * its last matching rule ignores it, false when that rule re-includes it
   * (`!`), null when no rule matches or the path is not under `base`. Only
   * the path itself is matched; `SearchIgnore` checks the directories above it.
   */
  match(relative: string, options: { isDir?: boolean } = {}): boolean | null {
    let sub = relative;
    if (this.base) {
      if (!relative.startsWith(this.base + "/")) return null;
      sub = relative.slice(this.base.length + 1);
    }
    const name = sub.slice(sub.lastIndexOf("/") + 1);
    let verdict: boolean | null = null;
    for (const rule of this.rules) {
      if (rule.dirOnly && !options.isDir) continue;
      if (rule.regex.test(rule.anchored ? sub : name)) verdict = !rule.negate;
    }
    return verdict;
  }
}

/**
 * The deny list plus every ignore file that applies to a path. `read` takes a
 * file's path relative to the root (`src/.gitignore`) and returns its text,
 * or null when there is no such file; it is called once per file, when a path
 * under its directory is first checked.
 */
export class SearchIgnore {
  readonly deny: DenyList;
  private readonly read: (relative: string) => string | null;
  private readonly files = new Map<string, readonly IgnoreFile[]>();

  constructor(read: (relative: string) => string | null | undefined, options: { deny?: DenyList } = {}) {
    this.deny = options.deny ?? new DenyList();
    this.read = (relative) => read(relative) ?? null;
  }

  /** The ignore files in `directory` (relative, `""` for the root), the .gitignore before the .matterwaveignore. */
  filesFor(directory: string): readonly IgnoreFile[] {
    const key = directory.replace(/^\/+|\/+$/g, "");
    let found = this.files.get(key);
    if (found === undefined) {
      const loaded: IgnoreFile[] = [];
      for (const name of SEARCH_IGNORE_FILES) {
        const text = this.read(key ? `${key}/${name}` : name);
        if (text !== null) loaded.push(new IgnoreFile(text, key));
      }
      found = loaded;
      this.files.set(key, found);
    }
    return found;
  }

  private ignoredHere(relative: string, isDir: boolean): boolean {
    const parts = relative.split("/");
    let verdict: boolean | null = null;
    for (let depth = 0; depth < parts.length; depth++) {
      for (const file of this.filesFor(parts.slice(0, depth).join("/"))) {
        const said = file.match(relative, { isDir });
        if (said !== null) verdict = said;
      }
    }
    return verdict === true;
  }

  /**
   * Whether a search leaves `relative` (to the root, `/`-separated) out:
   * denied, ignored, or (with `ancestors`, the default) inside a directory
   * that is. A walker that checks each directory before going into it passes
   * `ancestors: false`.
   */
  ignored(relative: string, options: { isDir?: boolean; ancestors?: boolean } = {}): boolean {
    const path = relative
      .split("\\")
      .join("/")
      .split("/")
      .filter((s) => s !== "" && s !== ".")
      .join("/");
    if (path === "") return false;
    const isDir = options.isDir ?? false;
    if (this.deny.matches(path, { isDir })) return true;
    if (options.ancestors ?? true) {
      const parts = path.split("/");
      for (let depth = 1; depth < parts.length; depth++) {
        if (this.ignoredHere(parts.slice(0, depth).join("/"), true)) return true;
      }
    }
    return this.ignoredHere(path, isDir);
  }
}
