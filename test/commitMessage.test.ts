import { describe, expect, it } from "vitest";
import { commitMessageFrom, commitMessagePrompt, DEFAULT_COMMIT_STYLE, MAX_DIFF_CHARS } from "../src/commitMessage";

const DIFF = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";

describe("commitMessagePrompt", () => {
  it("states the style and the answer's rules, then fences the staged diff", () => {
    const prompt = commitMessagePrompt(DIFF, "Conventional Commits: type(scope): summary");
    expect(prompt).toMatch(/^Write the git commit message for the staged changes below\.\n/);
    expect(prompt).toContain("Style: Conventional Commits: type(scope): summary");
    expect(prompt).toContain("no code fence");
    expect(prompt).toContain(`\`\`\`diff\n${DIFF.trimEnd()}\n\`\`\``);
  });

  it("uses the default style when none is set", () => {
    expect(commitMessagePrompt(DIFF, "  ")).toContain(`Style: ${DEFAULT_COMMIT_STYLE}`);
  });

  it("cuts a huge diff and says so, and fences backticks in it with a longer fence", () => {
    const prompt = commitMessagePrompt(`+\`\`\`\n+${"x".repeat(MAX_DIFF_CHARS + 10)}\n`, "");
    expect(prompt).toContain(`(diff cut at ${MAX_DIFF_CHARS.toLocaleString()} characters)`);
    expect(prompt).toContain("````diff");
  });
});

describe("commitMessageFrom", () => {
  it("takes the answer as the message, trailing space trimmed", () => {
    expect(commitMessageFrom("Fix the clock  \n\nIt ran fast.  \n")).toBe("Fix the clock\n\nIt ran fast.");
  });

  it("takes off a fence or quotes the model put round it", () => {
    expect(commitMessageFrom("```\nAdd retries\n\nBecause.\n```")).toBe("Add retries\n\nBecause.");
    expect(commitMessageFrom('"Add retries"')).toBe("Add retries");
    expect(commitMessageFrom('Say "hi" to "them"')).toBe('Say "hi" to "them"');
  });
});
