import { describe, expect, it } from "vitest";
import { fitReplacement, inlineEditPrompt, replacementFromAnswer, selectedLines } from "../src/inlineEdit";

describe("inlineEditPrompt", () => {
  it("leads with the instruction and fences the selection with its language and path", () => {
    const prompt = inlineEditPrompt({
      instruction: "  Add error handling.  ",
      code: "work(x)",
      languageId: "python",
      path: "api/jobs.py",
      startLine: 4,
      endLine: 5,
    });
    expect(prompt).toContain("Add error handling.");
    expect(prompt).toContain("`api/jobs.py` (lines 4-5)");
    expect(prompt).toContain("```python api/jobs.py\nwork(x)\n```");
    expect(prompt).toContain("replacement lines only, indented as they will sit in the file");
  });

  it("uses a longer fence than any backtick run inside the selection", () => {
    const prompt = inlineEditPrompt({
      instruction: "keep the docs",
      code: "s = '''\n```js\n```\n'''",
      languageId: "python",
      path: "a.py",
      startLine: 1,
      endLine: 5,
    });
    expect(prompt).toContain("````python a.py\n");
    expect(prompt.trimEnd().endsWith("````")).toBe(true);
  });
});

describe("replacementFromAnswer", () => {
  it("takes the one fenced block's code", () => {
    expect(replacementFromAnswer("Here you go:\n\n```python api/jobs.py\nwork(x)\n```\n")).toBe("work(x)");
  });

  it("refuses an answer with no fence: prose is read in the chat, not spliced in as code", () => {
    expect(replacementFromAnswer("  just this line  ")).toBeNull();
    expect(replacementFromAnswer("You could wrap it in a try block.")).toBeNull();
  });

  it("refuses an empty answer, a cut one, and an ambiguous multi-block one", () => {
    expect(replacementFromAnswer("   ")).toBeNull();
    expect(replacementFromAnswer("half an ans", true)).toBeNull();
    expect(replacementFromAnswer("```a\n1\n```\n```b\n2\n```")).toBeNull();
  });

  it("ignores empty blocks when counting", () => {
    expect(replacementFromAnswer("```\n```\n\n```py x.py\nreal()\n```")).toBe("real()");
  });

  it("keeps the code's own indentation, first line included", () => {
    expect(replacementFromAnswer("```ts\n    a();\n    b();\n```")).toBe("    a();\n    b();");
  });
});

describe("selectedLines", () => {
  it("is the lines a selection touches", () => {
    expect(selectedLines({ line: 3, character: 4 }, { line: 5, character: 2 })).toEqual({ first: 3, last: 5 });
  });

  it("leaves out the line a whole-line selection ends at the start of", () => {
    expect(selectedLines({ line: 3, character: 0 }, { line: 6, character: 0 })).toEqual({ first: 3, last: 5 });
  });

  it("keeps a selection inside one line on that line", () => {
    expect(selectedLines({ line: 2, character: 1 }, { line: 2, character: 5 })).toEqual({ first: 2, last: 2 });
  });
});

describe("fitReplacement", () => {
  /** What the document becomes: the lines before, the fitted replacement, the lines after. */
  function splice(document: string, original: string, replacement: string): string {
    const at = document.indexOf(original);
    return document.slice(0, at) + fitReplacement(original, replacement) + document.slice(at + original.length);
  }

  it("keeps the selected lines' trailing line break, so the next line does not join the last", () => {
    const document = "function f() {\n  a();\n  b();\n}\n";
    // A fence's code never ends in a line break.
    expect(splice(document, "  a();\n  b();\n", "  a();\n  c();")).toBe("function f() {\n  a();\n  c();\n}\n");
  });

  it("puts the indentation back when the model answered flush left", () => {
    const document = "class A {\n    run() {\n        go();\n    }\n}\n";
    const original = "    run() {\n        go();\n    }\n";
    expect(splice(document, original, "run() {\n    go(1);\n}")).toBe("class A {\n    run() {\n        go(1);\n    }\n}\n");
  });

  it("leaves an answer that is already indented alone", () => {
    expect(fitReplacement("    a();\n", "    b();\n")).toBe("    b();\n");
    expect(fitReplacement("\tx\n", "\ty")).toBe("\ty\n");
  });

  it("adds no line break to a last line that had none", () => {
    expect(fitReplacement("last()", "changed()\n")).toBe("changed()");
    expect(fitReplacement("last()", "changed()")).toBe("changed()");
  });

  it("keeps blank lines blank when re-indenting", () => {
    expect(fitReplacement("  a\n\n  b\n", "a\n\nb")).toBe("  a\n\n  b\n");
  });

  it("fits a CRLF selection with LF code; the apply path turns the endings into the document's", () => {
    expect(fitReplacement("  a\r\n", "a")).toBe("  a\n");
  });
});
