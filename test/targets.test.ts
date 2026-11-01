import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { applyToFile, registerApplyContentProvider } from "../src/apply";
import { isInside, relativeSegments, resolveInFolder, whereItLands } from "../src/targets";
import { commands, window, workspace } from "./vscode-mock";

const ROOT = vscode.Uri.file("/workspace");

describe("relativeSegments", () => {
  it("keeps a plain relative path, with . and inner .. resolved", () => {
    expect(relativeSegments("src/a.ts")).toEqual(["src", "a.ts"]);
    expect(relativeSegments("./src/./a.ts")).toEqual(["src", "a.ts"]);
    expect(relativeSegments("src/lib/../a.ts")).toEqual(["src", "a.ts"]);
    expect(relativeSegments("src\\win\\a.ts")).toEqual(["src", "win", "a.ts"]);
  });

  it("refuses a path that climbs out with ../, by either separator", () => {
    expect(relativeSegments("../a.ts")).toBeNull();
    expect(relativeSegments("../../home/user/.bashrc")).toBeNull();
    expect(relativeSegments("src/../../a.ts")).toBeNull();
    expect(relativeSegments("..\\..\\Windows\\win.ini")).toBeNull();
    expect(relativeSegments("src\\..\\..\\a.ts")).toBeNull();
  });

  it("refuses absolute, UNC, drive-letter and URI paths", () => {
    expect(relativeSegments("/etc/hosts")).toBeNull();
    expect(relativeSegments("\\Windows\\win.ini")).toBeNull();
    expect(relativeSegments("\\\\server\\share\\a.ts")).toBeNull();
    expect(relativeSegments("C:\\Windows\\win.ini")).toBeNull();
    expect(relativeSegments("c:/Windows/win.ini")).toBeNull();
    expect(relativeSegments("file:///etc/hosts")).toBeNull();
  });

  it("refuses a colon inside a segment, and a path that is nothing", () => {
    expect(relativeSegments("src/a.ts:stream")).toBeNull();
    expect(relativeSegments("")).toBeNull();
    expect(relativeSegments("./")).toBeNull();
    expect(relativeSegments("src/..")).toBeNull();
  });
});

describe("resolveInFolder", () => {
  it("resolves inside the folder", () => {
    expect(resolveInFolder(ROOT, "src/a.ts")?.toString()).toBe("file:///workspace/src/a.ts");
  });

  it("returns null for every escape", () => {
    for (const raw of ["../a.ts", "/etc/hosts", "C:/x.ts", "..\\..\\x.ts", "a/../../x.ts"]) {
      expect(resolveInFolder(ROOT, raw), raw).toBeNull();
    }
  });

  it("keeps a remote folder's host", () => {
    const remote = vscode.Uri.parse("vscode-remote://ssh-remote+box/home/ada/project");
    const uri = resolveInFolder(remote, "src/a.ts");
    expect(uri?.authority).toBe("ssh-remote+box");
    expect(uri?.toString()).toBe("vscode-remote://ssh-remote+box/home/ada/project/src/a.ts");
  });
});

describe("isInside", () => {
  it("is true for the folder and below it, false for a sibling with the same prefix", () => {
    expect(isInside(ROOT, ROOT)).toBe(true);
    expect(isInside(ROOT, vscode.Uri.file("/workspace/a/b.ts"))).toBe(true);
    expect(isInside(ROOT, vscode.Uri.file("/workspace-other/a.ts"))).toBe(false);
  });

  it("is false on another host or scheme", () => {
    const remote = vscode.Uri.parse("vscode-remote://ssh-remote+box/workspace/a.ts");
    expect(isInside(ROOT, remote)).toBe(false);
  });
});

describe("the confirm names where the write lands", () => {
  beforeEach(() => {
    workspace.files.clear();
    window.informationAnswers.length = 0;
    window.shown.length = 0;
    commands.executed.length = 0;
    commands.commandArgs.length = 0;
    workspace.workspaceFolders = [{ uri: ROOT, name: "workspace", index: 0 }];
    registerApplyContentProvider();
  });

  it("shows the resolved path in the Apply dialog", async () => {
    const target = resolveInFolder(ROOT, "src/lib/../a.ts");
    expect(target).not.toBeNull();
    window.informationAnswers.push(undefined);
    await applyToFile(target as vscode.Uri, "code\n", { title: "t" });
    const dialog = window.shown.find((s) => s.message.startsWith("Apply this code"));
    const options = (dialog?.options as unknown[])[0] as { detail: string };
    expect(options.detail).toContain(`Writes to ${whereItLands(target as vscode.Uri)}`);
    expect(options.detail).toContain("/workspace/src/a.ts");
  });
});
