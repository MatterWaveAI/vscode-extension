import { describe, expect, it } from "vitest";
import { fileAttachment, fitsContentCap, imageAttachment, imageContentType, MAX_CONTENT_CHARS, selectionContent } from "../src/context";

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

describe("image attachments", () => {
  it("knows the types the vision models read, by extension, case-insensitively", () => {
    expect(imageContentType("shot.PNG")).toBe("image/png");
    expect(imageContentType("a/photo.jpeg")).toBe("image/jpeg");
    expect(imageContentType("a/anim.gif")).toBe("image/gif");
    expect(imageContentType("a/pic.webp")).toBe("image/webp");
    expect(imageContentType("notes.md")).toBeNull();
    expect(imageContentType("noext")).toBeNull();
  });

  it("carries its own bytes under its own type", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const { blob, filename } = imageAttachment(bytes, "img/one.png", "image/png");
    expect(filename).toBe("img/one.png");
    expect(blob.type).toBe("image/png");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  });
});
