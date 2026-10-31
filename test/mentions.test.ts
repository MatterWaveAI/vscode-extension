import { describe, expect, it } from "vitest";
import { hasMentions, MENTION_KINDS, parseMentions } from "../src/chat/mentions";

describe("parseMentions", () => {
  it("recognises every provider kind as its own word", () => {
    expect(parseMentions("Explain @file then @folder with @terminal, @git and @docs")).toEqual([
      { kind: "file", token: "@file" },
      { kind: "folder", token: "@folder" },
      { kind: "terminal", token: "@terminal" },
      { kind: "git", token: "@git" },
      { kind: "docs", token: "@docs" },
    ]);
    expect(MENTION_KINDS).toHaveLength(5);
  });

  it("is case-insensitive and keeps first appearance order", () => {
    expect(parseMentions("@GIT first, then @Docs and @File")).toEqual([
      { kind: "git", token: "@git" },
      { kind: "docs", token: "@docs" },
      { kind: "file", token: "@file" },
    ]);
  });

  it("mentions each kind once however many times it is typed", () => {
    expect(parseMentions("@file and @file again, plus @file")).toEqual([{ kind: "file", token: "@file" }]);
  });

  it("leaves emails, unknown kinds and words containing @ as text", () => {
    expect(parseMentions("mail ada@example.com and ask @unknown about @filex")).toEqual([]);
    expect(hasMentions("mail ada@example.com")).toBe(false);
  });

  it("finds a mention at the very start and after punctuation", () => {
    expect(parseMentions("@git what changed?")).toEqual([{ kind: "git", token: "@git" }]);
    expect(parseMentions("(@file) review this")).toEqual([{ kind: "file", token: "@file" }]);
    expect(hasMentions("no context here")).toBe(false);
  });
});
