import { describe, expect, it } from "vitest";
import { hasMentions, MENTION_KINDS, mentionTitle, parseMentions } from "../src/chat/mentions";

const one = (kind: string) => ({ kind, token: `@${kind}`, ordinal: 1, of: 1 });

describe("parseMentions", () => {
  it("recognises every provider kind as its own word", () => {
    expect(parseMentions("Explain @file then @folder with @workspace, @terminal, @git and @docs")).toEqual([
      one("file"),
      one("folder"),
      one("workspace"),
      one("terminal"),
      one("git"),
      one("docs"),
    ]);
    expect(MENTION_KINDS).toHaveLength(6);
  });

  it("is case-insensitive and keeps the order typed", () => {
    expect(parseMentions("@GIT first, then @Docs and @File")).toEqual([one("git"), one("docs"), one("file")]);
  });

  it("makes every mention its own, numbered among those of its kind", () => {
    expect(parseMentions("compare @file with @file, then @git and @file")).toEqual([
      { kind: "file", token: "@file", ordinal: 1, of: 3 },
      { kind: "file", token: "@file", ordinal: 2, of: 3 },
      { kind: "git", token: "@git", ordinal: 1, of: 1 },
      { kind: "file", token: "@file", ordinal: 3, of: 3 },
    ]);
  });

  it("leaves emails, unknown kinds and words containing @ as text", () => {
    expect(parseMentions("mail ada@example.com and ask @unknown about @filex")).toEqual([]);
    expect(hasMentions("mail ada@example.com")).toBe(false);
  });

  it("finds a mention at the very start and after punctuation", () => {
    expect(parseMentions("@git what changed?")).toEqual([one("git")]);
    expect(parseMentions("(@file) review this")).toEqual([one("file")]);
    expect(hasMentions("no context here")).toBe(false);
  });
});

describe("mentionTitle", () => {
  it("names the mention, and which of several it is", () => {
    const [first, second] = parseMentions("@file and @file");
    expect(mentionTitle(first!)).toBe("@file (1 of 2)");
    expect(mentionTitle(second!)).toBe("@file (2 of 2)");
    expect(mentionTitle(parseMentions("@git")[0]!)).toBe("@git");
  });
});
