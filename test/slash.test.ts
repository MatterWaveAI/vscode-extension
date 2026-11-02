import { describe, expect, it } from "vitest";
import { BUILT_IN_COMMANDS, parseSlashCommand } from "../src/chat/slash";

describe("parseSlashCommand", () => {
  it("recognises every built-in, with and without arguments", () => {
    expect(BUILT_IN_COMMANDS).toEqual([
      "model", "clear", "compact", "share", "export",
      "help", "approval-mode", "context", "restore", "init", "resume",
    ]);
    expect(parseSlashCommand("/approval-mode auto-edit")).toEqual({ kind: "built-in", command: "approval-mode", args: "auto-edit" });
    expect(parseSlashCommand("/clear")).toEqual({ kind: "built-in", command: "clear", args: "" });
    expect(parseSlashCommand("/model grt-large")).toEqual({ kind: "built-in", command: "model", args: "grt-large" });
  });

  it("is case-insensitive and trims the message", () => {
    expect(parseSlashCommand("  /COMPACT  ")).toEqual({ kind: "built-in", command: "compact", args: "" });
  });

  it("keeps arguments verbatim, newlines included", () => {
    const parsed = parseSlashCommand("/explain this code:\nline two");
    expect(parsed).toEqual({ kind: "library", name: "explain", args: "this code:\nline two" });
  });

  it("treats anything else as a library prompt", () => {
    expect(parseSlashCommand("/review")).toEqual({ kind: "library", name: "review", args: "" });
    expect(parseSlashCommand("/code-review_2 fast")).toEqual({ kind: "library", name: "code-review_2", args: "fast" });
  });

  it("is not a command without a slash, name, or at a position other than first", () => {
    expect(parseSlashCommand("hello /clear")).toBeNull();
    expect(parseSlashCommand("/")).toBeNull();
    expect(parseSlashCommand("/1nvalid")).toBeNull();
    expect(parseSlashCommand("no command at all")).toBeNull();
  });

  it("does not take // as a command: that is the composer's escape", () => {
    expect(parseSlashCommand("//clear")).toBeNull();
  });
});
