import { describe, expect, it } from "vitest";
import { codeBlockAt, parseCodeBlocks } from "../src/chat/codeBlocks";

describe("parseCodeBlocks", () => {
  it("reads the language and the file out of the info string", () => {
    const [block] = parseCodeBlocks("Use this:\n\n```python api/jobs.py\nprint(1)\n```\n");
    expect(block).toEqual({ index: 0, language: "python", filename: "api/jobs.py", code: "print(1)" });
  });

  it("accepts the shorthand and bare-path forms", () => {
    expect(parseCodeBlocks("```ts:src/a.ts\nconst a = 1;\n```")[0]).toMatchObject({ language: null, filename: "src/a.ts" });
    expect(parseCodeBlocks("```ts src/a.ts\nconst a = 1;\n```")[0]).toMatchObject({ language: "ts", filename: "src/a.ts" });
    expect(parseCodeBlocks("```src/a.ts\nconst a = 1;\n```")[0]).toMatchObject({ language: null, filename: "src/a.ts" });
  });

  it("leaves a bare language unassociated, and so for no info at all", () => {
    expect(parseCodeBlocks("```python\nprint(1)\n```")[0]).toMatchObject({ language: "python", filename: null });
    expect(parseCodeBlocks("```\nprint(1)\n```")[0]).toMatchObject({ language: null, filename: null });
    expect(parseCodeBlocks("~~~\nprint(1)\n~~~")[0]).toMatchObject({ language: null, filename: null });
  });

  it("indexes blocks in order across the whole answer", () => {
    const blocks = parseCodeBlocks("```js a.js\none();\n```\ntext\n\n```py b.py\ntwo()\n```");
    expect(blocks.map((b) => [b.index, b.filename])).toEqual([
      [0, "a.js"],
      [1, "b.py"],
    ]);
  });

  it("keeps an unterminated block, as the renderer does", () => {
    expect(parseCodeBlocks("```go main.go\nfmt.Println(1)")[0]).toMatchObject({ filename: "main.go", code: "fmt.Println(1)" });
  });

  it("keeps a fence inside a block by needing a longer marker to close", () => {
    const [block] = parseCodeBlocks("````md doc.md\n```js\nx();\n```\n````\n");
    expect(block?.code).toBe("```js\nx();\n```");
  });

  it("does not take a fenced block inside a quote for a top-level one", () => {
    expect(parseCodeBlocks("> ```js\n> x();\n> ```")).toEqual([]);
  });
});

describe("codeBlockAt", () => {
  it("answers the block at an index and null past the end", () => {
    const text = "```js a.js\none();\n```";
    expect(codeBlockAt(text, 0)?.code).toBe("one();");
    expect(codeBlockAt(text, 1)).toBeNull();
  });
});
