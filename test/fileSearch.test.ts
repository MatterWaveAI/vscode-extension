import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { EXCLUDED, fileSearchGlob, pickWorkspaceFile, SEARCH_RESULTS, searchWorkspaceFiles } from "../src/fileSearch";
import { window, workspace } from "./vscode-mock";

describe("fileSearchGlob", () => {
  it("matches a file name or a directory name holding the text, in either case", () => {
    expect(fileSearchGlob("ab")).toBe("{**/*[aA][bB]*,**/*[aA][bB]*/**}");
  });

  it("keeps digits, dots and dashes as they are, and turns a backslash into a slash", () => {
    expect(fileSearchGlob("v1.2-x")).toBe("{**/*[vV]1.2-[xX]*,**/*[vV]1.2-[xX]*/**}");
    expect(fileSearchGlob("src\\a")).toBe("{**/*[sS][rR][cC]/[aA]*,**/*[sS][rR][cC]/[aA]*/**}");
  });

  it("takes glob syntax in the query literally", () => {
    expect(fileSearchGlob("*{x}")).toBe("{**/*[*][{][xX][}]*,**/*[*][{][xX][}]*/**}");
  });

  it("is null for nothing typed", () => {
    expect(fileSearchGlob("   ")).toBeNull();
    expect(fileSearchGlob("/")).toBeNull();
  });
});

describe("searchWorkspaceFiles", () => {
  beforeEach(() => {
    workspace.findFilesCalls.length = 0;
    workspace.findFilesAnswer = null;
  });

  it("asks the editor's search with the query's glob, build output excluded, and orders by path", async () => {
    workspace.findFilesAnswer = () => [vscode.Uri.file("/ws/b.ts"), vscode.Uri.file("/ws/a.ts")];
    const found = await searchWorkspaceFiles("ctrl");
    expect(found.map((u) => u.path)).toEqual(["/ws/a.ts", "/ws/b.ts"]);
    expect(workspace.findFilesCalls[0]).toEqual({ include: fileSearchGlob("ctrl"), exclude: EXCLUDED, max: SEARCH_RESULTS });
  });

  it("lists everything (up to the cap) for an empty query", async () => {
    await searchWorkspaceFiles("");
    expect(workspace.findFilesCalls[0]?.include).toBe("**/*");
  });
});

describe("pickWorkspaceFile", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.quickPicks.length = 0;
    workspace.findFilesCalls.length = 0;
    workspace.findFilesAnswer = (include) =>
      include === "**/*" ? [vscode.Uri.file("/ws/first.ts")] : [vscode.Uri.file("/ws/deep/file-0599.ts")];
  });

  it("searches again as the person types, and resolves with the accepted file", async () => {
    const picked = pickWorkspaceFile("Pick", (uri) => uri.path.slice(4));
    const pick = window.quickPicks[0];
    expect(pick?.shown).toBe(true);
    await vi.runAllTimersAsync();
    expect(pick?.items.map((i) => i.label)).toEqual(["first.ts"]);

    pick?.type("0599");
    await vi.runAllTimersAsync();
    expect(workspace.findFilesCalls.at(-1)?.include).toBe(fileSearchGlob("0599"));
    expect(pick?.items.map((i) => i.label)).toEqual(["deep/file-0599.ts"]);

    pick?.accept(pick.items[0] as { label: string });
    expect((await picked)?.path).toBe("/ws/deep/file-0599.ts");
    expect(pick?.disposed).toBe(true);
    vi.useRealTimers();
  });

  it("searches once per pause in typing", async () => {
    void pickWorkspaceFile("Pick", (uri) => uri.path);
    const pick = window.quickPicks[0];
    await vi.runAllTimersAsync();
    pick?.type("f");
    pick?.type("fi");
    pick?.type("fil");
    await vi.runAllTimersAsync();
    expect(workspace.findFilesCalls.map((c) => c.include)).toEqual(["**/*", fileSearchGlob("fil")]);
    pick?.hide();
    vi.useRealTimers();
  });

  it("resolves null when the person backs out", async () => {
    const picked = pickWorkspaceFile("Pick", (uri) => uri.path);
    window.quickPicks[0]?.hide();
    expect(await picked).toBeNull();
    vi.useRealTimers();
  });
});
