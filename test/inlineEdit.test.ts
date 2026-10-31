import { describe, expect, it } from "vitest";
import { inlineEditPrompt, replacementFromAnswer } from "../src/inlineEdit";

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
    expect(prompt).toContain("replacement code only");
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

  it("takes the whole trimmed answer when there is no fence", () => {
    expect(replacementFromAnswer("  just this line  ")).toBe("just this line");
  });

  it("refuses an empty answer, a cut one, and an ambiguous multi-block one", () => {
    expect(replacementFromAnswer("   ")).toBeNull();
    expect(replacementFromAnswer("half an ans", true)).toBeNull();
    expect(replacementFromAnswer("```a\n1\n```\n```b\n2\n```")).toBeNull();
  });

  it("ignores empty blocks when counting", () => {
    expect(replacementFromAnswer("```\n```\n\n```py x.py\nreal()\n```")).toBe("real()");
  });
});
