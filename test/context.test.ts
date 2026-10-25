import { describe, expect, it } from "vitest";
import { fileAttachment, fitsContentCap, MAX_CONTENT_CHARS, selectionContent } from "../src/context";

describe("selectionContent", () => {
  it("puts the question first and fences the selection with its language and path", () => {
    const content = selectionContent({
      question: "  Why is this slow?  ",
      code: "for x in xs:\n    work(x)",
      languageId: "python",
      path: "api/jobs.py",
      startLine: 10,
      endLine: 11,
    });
    expect(content).toBe(
      "Why is this slow?\n\n`api/jobs.py` (lines 10-11):\n\n```python api/jobs.py\nfor x in xs:\n    work(x)\n```\n",
    );
  });

  it("uses a longer fence than any backtick run inside the selection", () => {
    const content = selectionContent({
      question: "Explain",
      code: "doc = '''\n```js\nx\n```\n'''\n",
      languageId: "python",
      path: "a.py",
      startLine: 3,
      endLine: 3,
    });
    expect(content).toContain("(line 3)");
    expect(content).toContain("````python a.py\n");
    expect(content.trimEnd().endsWith("````")).toBe(true);
  });

  it("knows the API's content cap", () => {
    expect(fitsContentCap("x".repeat(MAX_CONTENT_CHARS))).toBe(true);
    expect(fitsContentCap("x".repeat(MAX_CONTENT_CHARS + 1))).toBe(false);
  });
});

describe("fileAttachment", () => {
  it("is text/plain named by the workspace path", async () => {
    const { blob, filename } = fileAttachment("export const a = 1;\n", "src/a.ts");
    expect(filename).toBe("src/a.ts");
    expect(blob.type).toBe("text/plain");
    expect(await blob.text()).toBe("export const a = 1;\n");
  });
});
