/**
 * Syntax highlighting for code blocks in answers: a small tokenizer that
 * knows comments, strings, numbers and keywords for the language families
 * answers carry, and nothing more. Pure -- tokens in, tokens out -- so the
 * webview builds the spans with `textContent` (never HTML) and the colours
 * come from the editor's own theme variables in the page's stylesheet.
 */

export type TokenKind = "comment" | "string" | "number" | "keyword" | "text";

export interface Token {
  kind: TokenKind;
  text: string;
}

interface Grammar {
  lineComment: string[];
  blockComment: [string, string] | null;
  strings: string[];
  keywords: Set<string>;
  caseInsensitive: boolean;
}

const words = (list: string) => new Set(list.split(/\s+/).filter(Boolean));

const C_LIKE = words(`
  abstract as async await break case catch class const continue default defer delete do else enum export extends
  false final finally fn for from func function go if impl implements import in instanceof interface internal is
  let match mod module mut namespace new nil null object of override package private protected pub public readonly
  return self static struct super switch this throw throws trait true try type typeof undefined union unsafe use
  val var void when where while with yield`);
const PYTHON = words(`
  and as assert async await break class continue def del elif else except False finally for from global if import
  in is lambda None nonlocal not or pass raise return True try while with yield match case self`);
const RUBY = words(`
  alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo
  rescue retry return self super then true undef unless until when while yield`);
const SHELL = words(`
  if then else elif fi case esac for while until do done in function return local export readonly declare set unset
  echo exit source`);
const SQL = words(`
  select from where and or not insert into values update set delete create table drop alter add index join left
  right inner outer on group by order having limit offset as distinct union all null is in exists like between case
  when then else end primary key foreign references default begin commit rollback with returning`);

const GRAMMARS: Record<string, Grammar> = {
  c: { lineComment: ["//"], blockComment: ["/*", "*/"], strings: ['"', "'", "`"], keywords: C_LIKE, caseInsensitive: false },
  python: { lineComment: ["#"], blockComment: null, strings: ['"""', "'''", '"', "'"], keywords: PYTHON, caseInsensitive: false },
  ruby: { lineComment: ["#"], blockComment: null, strings: ['"', "'"], keywords: RUBY, caseInsensitive: false },
  shell: { lineComment: ["#"], blockComment: null, strings: ['"', "'"], keywords: SHELL, caseInsensitive: false },
  sql: { lineComment: ["--"], blockComment: ["/*", "*/"], strings: ["'", '"'], keywords: SQL, caseInsensitive: true },
  json: { lineComment: [], blockComment: null, strings: ['"'], keywords: words("true false null"), caseInsensitive: false },
  yaml: { lineComment: ["#"], blockComment: null, strings: ['"', "'"], keywords: words("true false null yes no on off"), caseInsensitive: true },
};

const FAMILY: Record<string, keyof typeof GRAMMARS> = {
  js: "c", javascript: "c", jsx: "c", ts: "c", typescript: "c", tsx: "c", mjs: "c", cjs: "c", java: "c", c: "c",
  h: "c", cpp: "c", "c++": "c", cc: "c", hpp: "c", cs: "c", csharp: "c", go: "c", golang: "c", rust: "c", rs: "c",
  swift: "c", kotlin: "c", kt: "c", scala: "c", php: "c", dart: "c",
  python: "python", py: "python",
  ruby: "ruby", rb: "ruby",
  sh: "shell", bash: "shell", zsh: "shell", shell: "shell", console: "shell", fish: "shell", powershell: "shell", ps1: "shell",
  sql: "sql", postgres: "sql", postgresql: "sql", mysql: "sql", sqlite: "sql",
  json: "json", jsonc: "c",
  yaml: "yaml", yml: "yaml", toml: "yaml", ini: "yaml",
};

/** The grammar for a fence's language word; null for one this does not know, which stays plain. */
function grammarFor(language: string | null): Grammar | null {
  const family = language ? FAMILY[language.toLowerCase()] : undefined;
  return family ? (GRAMMARS[family] ?? null) : null;
}

/** The code as tokens; adjacent plain text is one token, and the tokens' text is exactly the code. */
export function tokenize(code: string, language: string | null): Token[] {
  const grammar = grammarFor(language);
  if (!grammar) return code ? [{ kind: "text", text: code }] : [];
  const tokens: Token[] = [];
  const push = (kind: TokenKind, text: string) => {
    const last = tokens.at(-1);
    if (kind === "text" && last?.kind === "text") last.text += text;
    else tokens.push({ kind, text });
  };
  let i = 0;
  while (i < code.length) {
    const rest = code.slice(i);
    const line = grammar.lineComment.find((marker) => rest.startsWith(marker));
    if (line) {
      const end = code.indexOf("\n", i);
      const stop = end < 0 ? code.length : end;
      push("comment", code.slice(i, stop));
      i = stop;
      continue;
    }
    if (grammar.blockComment && rest.startsWith(grammar.blockComment[0])) {
      const end = code.indexOf(grammar.blockComment[1], i + grammar.blockComment[0].length);
      const stop = end < 0 ? code.length : end + grammar.blockComment[1].length;
      push("comment", code.slice(i, stop));
      i = stop;
      continue;
    }
    const quote = grammar.strings.find((q) => rest.startsWith(q));
    if (quote) {
      let j = i + quote.length;
      while (j < code.length && !code.startsWith(quote, j)) {
        // A newline ends a one-character-quoted string that was never closed.
        if (quote.length === 1 && quote !== "`" && code[j] === "\n") break;
        j += code[j] === "\\" ? 2 : 1;
      }
      const stop = Math.min(code.length, code.startsWith(quote, j) ? j + quote.length : j);
      push("string", code.slice(i, stop));
      i = stop;
      continue;
    }
    const number = /^(?:0[xX][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/.exec(rest);
    if (number && !/[\w$]/.test(code[i - 1] ?? "")) {
      push("number", number[0]);
      i += number[0].length;
      continue;
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (word) {
      const key = grammar.caseInsensitive ? word[0].toLowerCase() : word[0];
      push(grammar.keywords.has(key) ? "keyword" : "text", word[0]);
      i += word[0].length;
      continue;
    }
    push("text", code[i] ?? "");
    i += 1;
  }
  return tokens;
}
