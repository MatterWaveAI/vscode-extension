import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { commands, window, workspace } from "./vscode-mock";
import { applyToFile, registerApplyContentProvider } from "../src/apply";
import {
  CheckpointStore,
  MAX_CHECKPOINTS,
  MAX_CHECKPOINTS_PER_CHAT,
  MAX_SNAPSHOT_CHARS,
  MAX_TOTAL_CHARS,
  type SnapshotFiles,
} from "../src/checkpoints";
import { snapshotFolder } from "../src/snapshotFiles";
import type { Memento } from "../src/promptLibrary";

const FILE = vscode.Uri.file("/workspace/src/a.ts");

/** A file's identity as a checkpoint keeps it: its full URI and the path the list shows. */
function at(path: string): { uri: string; path: string } {
  return { uri: vscode.Uri.joinPath(vscode.Uri.file("/workspace"), path).toString(), path };
}

function fakeMemento(initial: Record<string, unknown> = {}): Memento & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>(Object.entries(initial));
  return {
    values,
    get<T>(key: string): T | undefined {
      return values.get(key) as T | undefined;
    },
    update(key: string, value: unknown): Promise<void> {
      if (value === undefined) values.delete(key);
      else values.set(key, value);
      return Promise.resolve();
    },
  };
}

function memoryFiles(): SnapshotFiles & { texts: Map<string, string> } {
  const texts = new Map<string, string>();
  return {
    texts,
    async write(id, text) {
      texts.set(id, text);
    },
    async read(id) {
      return texts.get(id) ?? null;
    },
    async delete(id) {
      texts.delete(id);
    },
    async list() {
      return [...texts.keys()];
    },
  };
}

function store(state = fakeMemento(), files = memoryFiles()) {
  let n = 0;
  const clock = () => new Date(1_700_000_000_000 + n++ * 1_000);
  return { checkpoints: new CheckpointStore(state, files, clock), state, files };
}

describe("CheckpointStore", () => {
  it("round-trips a snapshot: record, list, content", async () => {
    const { checkpoints, files } = store();
    const row = await checkpoints.record("c_1", at("src/a.ts"), "before", "Apply");
    expect(row).toMatchObject({
      conversationId: "c_1",
      uri: "file:///workspace/src/a.ts",
      path: "src/a.ts",
      isNew: false,
      size: 6,
      label: "Apply",
    });
    expect((await checkpoints.list("c_1")).map((r) => r.path)).toEqual(["src/a.ts"]);
    expect(await checkpoints.content(row?.id ?? "")).toBe("before");
    // The snapshot is a file, not part of the index the editor loads at start.
    expect(files.texts.get(row?.id ?? "")).toBe("before");
  });

  it("keeps the snapshot out of the editor's state, which holds only the small index", async () => {
    const { checkpoints, state } = store();
    await checkpoints.record("c_1", at("a.ts"), "x".repeat(50_000), "Apply");
    expect(JSON.stringify([...state.values.values()]).length).toBeLessThan(1_000);
  });

  it("lists newest first, per chat, and keeps other chats out of the list", async () => {
    const { checkpoints } = store();
    await checkpoints.record("c_1", at("a.ts"), "1", "Apply");
    await checkpoints.record("c_1", at("b.ts"), "2", "Inline edit");
    await checkpoints.record("c_2", at("c.ts"), "3", "Apply");
    expect((await checkpoints.list("c_1")).map((r) => r.path)).toEqual(["b.ts", "a.ts"]);
    expect((await checkpoints.list("c_2")).map((r) => r.path)).toEqual(["c.ts"]);
    expect((await checkpoints.list(null)).map((r) => r.path)).toEqual(["c.ts", "b.ts", "a.ts"]);
  });

  it("keeps a file that was new as a contentless checkpoint, and refuses one too large to restore", async () => {
    const { checkpoints, files } = store();
    const fresh = await checkpoints.record("c_1", at("new.ts"), null, "Apply");
    expect(fresh).toMatchObject({ isNew: true, size: 0 });
    expect(files.texts.has(fresh?.id ?? "")).toBe(false);
    expect(await checkpoints.record("c_1", at("huge.ts"), "x".repeat(MAX_SNAPSHOT_CHARS + 1), "Apply")).toBeNull();
    expect((await checkpoints.list("c_1")).map((r) => r.path)).toEqual(["new.ts"]);
  });

  it("keeps only the newest per chat, deleting the dropped snapshots", async () => {
    const { checkpoints, files } = store();
    for (let i = 0; i < MAX_CHECKPOINTS_PER_CHAT + 5; i++) await checkpoints.record("c_1", at(`f${i}.ts`), `${i}`, "Apply");
    await checkpoints.record("c_2", at("other.ts"), "x", "Apply");
    const chatRows = await checkpoints.list("c_1");
    expect(chatRows).toHaveLength(MAX_CHECKPOINTS_PER_CHAT);
    expect(chatRows[0]).toMatchObject({ path: `f${MAX_CHECKPOINTS_PER_CHAT + 4}.ts` });
    expect(chatRows.at(-1)).toMatchObject({ path: "f5.ts" });
    expect((await checkpoints.list("c_2")).map((r) => r.path)).toEqual(["other.ts"]);
    expect(files.texts.size).toBe(MAX_CHECKPOINTS_PER_CHAT + 1);
  });

  it("caps the whole store in rows however many chats there are, least recently used first", async () => {
    const { checkpoints, files } = store();
    const first = await checkpoints.record("chat-0", at("f0.ts"), "0", "Apply");
    for (let i = 1; i < MAX_CHECKPOINTS + 10; i++) {
      await checkpoints.record(`chat-${i}`, at(`f${i}.ts`), `${i}`, "Apply");
      // The first one keeps being restored, so it is never the least recently used.
      if (i % 50 === 0) await checkpoints.content(first?.id ?? "");
    }
    const rows = await checkpoints.list(null);
    expect(rows).toHaveLength(MAX_CHECKPOINTS);
    expect(files.texts.size).toBe(MAX_CHECKPOINTS);
    expect(rows.some((r) => r.id === first?.id)).toBe(true);
    expect(rows.some((r) => r.path === "f1.ts")).toBe(false);
  });

  it("caps the whole store in size", async () => {
    const { checkpoints, files } = store();
    const big = "x".repeat(MAX_SNAPSHOT_CHARS);
    const count = Math.floor(MAX_TOTAL_CHARS / MAX_SNAPSHOT_CHARS) + 5;
    for (let i = 0; i < count; i++) await checkpoints.record(`chat-${i}`, at(`f${i}.ts`), big, "Apply");
    const total = [...files.texts.values()].reduce((sum, text) => sum + text.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_CHARS);
    expect((await checkpoints.list(null))[0]?.path).toBe(`f${count - 1}.ts`);
  });

  it("removes one row and its file, and leaves the rest", async () => {
    const { checkpoints, files } = store();
    const first = await checkpoints.record("c_1", at("a.ts"), "1", "Apply");
    await checkpoints.record("c_1", at("b.ts"), "2", "Apply");
    await checkpoints.remove(first?.id ?? "");
    expect((await checkpoints.list("c_1")).map((r) => r.path)).toEqual(["b.ts"]);
    expect(await checkpoints.get(first?.id ?? "")).toBeNull();
    expect(files.texts.has(first?.id ?? "")).toBe(false);
  });

  it("says null for a snapshot whose file is gone", async () => {
    const { checkpoints, files } = store();
    const row = await checkpoints.record("c_1", at("a.ts"), "1", "Apply");
    files.texts.clear();
    expect(await checkpoints.content(row?.id ?? "")).toBeNull();
  });

  it("moves an older release's snapshots out of the editor's state into files", async () => {
    const state = fakeMemento({
      "matterwave.checkpoints": [
        { id: "old-1", conversationId: "c_1", path: "src/a.ts", content: "kept", createdAt: "2026-10-30T10:00:00.000Z", label: "Apply" },
        { id: "old-2", conversationId: "c_1", path: "new.ts", content: null, createdAt: "2026-10-30T11:00:00.000Z", label: "Apply" },
      ],
    });
    const { checkpoints, files } = store(state);
    const rows = await checkpoints.list("c_1");
    expect(rows.map((r) => [r.id, r.isNew])).toEqual([
      ["old-2", true],
      ["old-1", false],
    ]);
    expect(await checkpoints.content("old-1")).toBe("kept");
    expect(files.texts.get("old-1")).toBe("kept");
    expect(state.values.has("matterwave.checkpoints")).toBe(false);
  });

  it("sweeps snapshot files the index does not name", async () => {
    const files = memoryFiles();
    files.texts.set("stray", "left by a write the index never recorded");
    const { checkpoints } = store(fakeMemento(), files);
    await checkpoints.list(null);
    expect(files.texts.has("stray")).toBe(false);
  });
});

describe("snapshotFolder", () => {
  beforeEach(() => {
    workspace.files.clear();
  });

  it("keeps each snapshot as a file in the folder, and lists and deletes them", async () => {
    const folder = vscode.Uri.file("/storage/checkpoints");
    const files = snapshotFolder(folder);
    await files.write("abc-1", "text");
    expect(new TextDecoder().decode(workspace.files.get("file:///storage/checkpoints/abc-1.txt"))).toBe("text");
    expect(await files.read("abc-1")).toBe("text");
    expect(await files.list()).toEqual(["abc-1"]);
    await files.delete("abc-1");
    expect(await files.read("abc-1")).toBeNull();
    await files.delete("abc-1");
  });

  it("refuses an id that is not the store's own", async () => {
    const files = snapshotFolder(vscode.Uri.file("/storage/checkpoints"));
    await expect(files.write("../escape", "x")).rejects.toThrow("not a checkpoint id");
  });
});

describe("snapshot and restore round-trip", () => {
  beforeEach(() => {
    workspace.files.clear();
    workspace.documents.clear();
    window.informationAnswers.length = 0;
    commands.executed.length = 0;
    commands.commandArgs.length = 0;
    workspace.workspaceFolders = [{ uri: vscode.Uri.file("/workspace"), name: "workspace", index: 0 }];
    registerApplyContentProvider();
  });

  it("puts the recorded contents back through the apply path", async () => {
    // The apply that took the checkpoint.
    workspace.files.set(FILE.toString(), new TextEncoder().encode("before"));
    window.informationAnswers.push("Apply");
    const { checkpoints } = store();
    let recorded: string | null = null;
    await applyToFile(FILE, "after", {
      title: "t",
      onSnapshot: async (before) => {
        recorded = before;
        await checkpoints.record("c_1", at("src/a.ts"), before, "Apply");
      },
    });
    expect(recorded).toBe("before");
    expect(new TextDecoder().decode(workspace.files.get(FILE.toString()))).toBe("after");

    // The restore: the checkpoint's contents, back through the same path.
    const row = (await checkpoints.list("c_1"))[0];
    window.informationAnswers.length = 0;
    window.informationAnswers.push("Apply");
    await applyToFile(FILE, (await checkpoints.content(row?.id ?? "")) ?? "", { title: "restore" });
    expect(new TextDecoder().decode(workspace.files.get(FILE.toString()))).toBe("before");
  });
});
