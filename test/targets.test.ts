import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { applyToFile, registerApplyContentProvider } from "../src/apply";
import {
  currentFolder,
  editorFolders,
  isInside,
  relativeSegments,
  resolveInFolder,
  resolveNamedFile,
  whereItLands,
  type FolderContext,
} from "../src/targets";
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

describe("resolveNamedFile in a multi-root workspace", () => {
  const ALPHA = { uri: vscode.Uri.file("/ws/alpha"), name: "alpha", index: 0 };
  const BETA = { uri: vscode.Uri.file("/ws/beta"), name: "beta", index: 1 };
  const folders = [ALPHA, BETA] as unknown as vscode.WorkspaceFolder[];
  const asked: string[] = [];
  const context = (active: unknown, answer?: unknown): FolderContext => ({
    folders,
    active: active as vscode.WorkspaceFolder | undefined,
    pick: async (placeHolder) => {
      asked.push(placeHolder);
      return answer as vscode.WorkspaceFolder | undefined;
    },
  });

  beforeEach(() => {
    asked.length = 0;
  });

  it("puts a path in the folder of the file the person is in, not the first folder", async () => {
    const named = await resolveNamedFile("src/shared.ts", context(BETA));
    expect(named).toEqual({ kind: "file", uri: vscode.Uri.file("/ws/beta/src/shared.ts") });
    expect(asked).toEqual([]);
  });

  it("follows a path that leads with a folder's name", async () => {
    const named = await resolveNamedFile("beta/src/shared.ts", context(ALPHA));
    expect(named).toEqual({ kind: "file", uri: vscode.Uri.file("/ws/beta/src/shared.ts") });
  });

  it("asks which folder when the person is in none, and stops when they back out", async () => {
    expect(await resolveNamedFile("src/a.ts", context(undefined, BETA))).toEqual({
      kind: "file",
      uri: vscode.Uri.file("/ws/beta/src/a.ts"),
    });
    expect(asked).toHaveLength(1);
    expect(await resolveNamedFile("src/a.ts", context(undefined, undefined))).toEqual({ kind: "none" });
  });

  it("refuses an escape whichever folder it starts from", async () => {
    expect(await resolveNamedFile("../alpha/src/a.ts", context(BETA))).toEqual({ kind: "outside" });
    expect(await resolveNamedFile("beta/../../x.ts", context(ALPHA))).toEqual({ kind: "outside" });
    expect(asked).toEqual([]);
  });

  it("uses the only folder without asking, and nothing when there is none", async () => {
    const one: FolderContext = { folders: [ALPHA] as unknown as vscode.WorkspaceFolder[], active: undefined, pick: async () => undefined };
    expect(await resolveNamedFile("src/a.ts", one)).toEqual({ kind: "file", uri: vscode.Uri.file("/ws/alpha/src/a.ts") });
    expect(await resolveNamedFile("src/a.ts", { ...one, folders: [] })).toEqual({ kind: "none" });
  });

  it("keeps a remote workspace's host", async () => {
    const remote = { uri: vscode.Uri.parse("vscode-remote://wsl+Ubuntu/home/ada/app"), name: "app", index: 0 };
    const named = await resolveNamedFile("src/new.ts", {
      folders: [remote] as unknown as vscode.WorkspaceFolder[],
      active: undefined,
      pick: async () => undefined,
    });
    expect(named.kind === "file" && named.uri.toString()).toBe("vscode-remote://wsl+Ubuntu/home/ada/app/src/new.ts");
  });

  it("currentFolder: the active folder, else the only one, else asks", async () => {
    expect(await currentFolder(context(BETA), "which?")).toBe(BETA);
    expect(await currentFolder(context(undefined, ALPHA), "which?")).toBe(ALPHA);
    expect(asked).toEqual(["which?"]);
  });
});

describe("editorFolders", () => {
  it("reads the active editor's folder from the editor", () => {
    workspace.workspaceFolders = [
      { uri: vscode.Uri.file("/ws/alpha"), name: "alpha", index: 0 },
      { uri: vscode.Uri.file("/ws/beta"), name: "beta", index: 1 },
    ];
    window.activeTextEditor = { document: { uri: vscode.Uri.file("/ws/beta/src/x.ts") } };
    try {
      expect(editorFolders().active?.name).toBe("beta");
    } finally {
      window.activeTextEditor = undefined;
    }
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
