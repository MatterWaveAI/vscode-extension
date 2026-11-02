import { describe, expect, it } from "vitest";
import { tokenize } from "../src/webview/highlight";
import { suggestionsAt } from "../src/webview/suggest";

const kinds = (code: string, language: string | null) =>
  tokenize(code, language)
    .filter((t) => t.kind !== "text")
    .map((t) => `${t.kind}:${t.text}`);

describe("tokenize", () => {
  it("finds a C-family language's keywords, strings, numbers and both comment forms", () => {
    expect(kinds('const n = 42; // the answer\n/* note */ return "x";', "ts")).toEqual([
      "keyword:const",
      "number:42",
      "comment:// the answer",
      "comment:/* note */",
      "keyword:return",
      'string:"x"',
    ]);
  });

  it("knows Python's # comments, triple quotes and keywords", () => {
    expect(kinds('def f():\n    """doc"""\n    return None  # nothing', "python")).toEqual([
      "keyword:def",
      'string:"""doc"""',
      "keyword:return",
      "keyword:None",
      "comment:# nothing",
    ]);
  });

  it("reads SQL keywords in any case", () => {
    expect(kinds("SELECT id FROM t -- all", "sql")).toEqual(["keyword:SELECT", "keyword:FROM", "comment:-- all"]);
  });

  it("keeps escapes inside a string, and a number inside a word as part of the word", () => {
    expect(kinds('"a\\"b" x2 2x 7', "js")).toEqual(['string:"a\\"b"', "number:7"]);
  });

  it("gives back exactly the code, and plain text for a language it does not know", () => {
    const code = 'let a = "q";\n// c\n';
    expect(tokenize(code, "ts").map((t) => t.text).join("")).toBe(code);
    expect(tokenize("anything at all", "brainfuck")).toEqual([{ kind: "text", text: "anything at all" }]);
    expect(tokenize("x", null)).toEqual([{ kind: "text", text: "x" }]);
  });
});

describe("suggestionsAt", () => {
  it("offers the context providers for an @ word, anywhere in the text", () => {
    expect(suggestionsAt("compare @f", 10, [])).toEqual({
      start: 8,
      end: 10,
      items: [
        { insert: "@file", detail: "a file's contents" },
        { insert: "@folder", detail: "a folder's tree" },
      ],
    });
    expect(suggestionsAt("@", 1, [])?.items.map((i) => i.insert)).toEqual(["@file", "@folder", "@terminal", "@git", "@docs"]);
  });

  it("leaves emails and finished mentions alone", () => {
    expect(suggestionsAt("ada@ex", 6, [])).toBeNull();
    expect(suggestionsAt("@file", 5, [])).toBeNull();
  });

  it("offers commands and saved prompts for a / at the start", () => {
    expect(suggestionsAt("/c", 2, ["code-review", "clear"])?.items).toEqual([
      { insert: "/clear", detail: "start a new chat" },
      { insert: "/compact", detail: "summarise earlier turns" },
      { insert: "/context", detail: "what the next request carries" },
      { insert: "/code-review", detail: "saved prompt" },
    ]);
    expect(suggestionsAt("text /c", 7, ["code-review"])).toBeNull();
  });
});
