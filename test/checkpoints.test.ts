import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { commands, window, workspace } from "./vscode-mock";
import { applyToFile, registerApplyContentProvider } from "../src/apply";
import { CheckpointStore, MAX_CHECKPOINTS_PER_CHAT, MAX_SNAPSHOT_CHARS, type Checkpoint } from "../src/checkpoints";
import type { Memento } from "../src/promptLibrary";

const FILE = vscode.Uri.file("/workspace/src/a.ts");

function fakeMemento(): Memento & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    get<T>(key: string): T | undefined {
      return values.get(key) as T | undefined;
    },
    update(key: string, value: unknown): Promise<void> {
      values.set(key, value);
      return Promise.resolve();
    },
  };
}

function store(tick = 0): { store: CheckpointStore; now: () => Date } {
  let n = tick;
  return { store: new CheckpointStore(fakeMemento(), () => new Date(1_700_000_000_000 + n++ * 1_000)), now: () => new Date() };
}

const ROW = (over: Partial<Checkpoint> = {}): Checkpoint => ({
  id: "x",
  conversationId: "c_1",
  path: "src/a.ts",
  content: "before",
  createdAt: "2026-10-31T10:00:00.000Z",
  label: "Apply",
  ...over,
});

describe("CheckpointStore", () => {
  it("round-trips a snapshot: record, list, get", async () => {
    const { store: checkpoints } = store();
    const row = await checkpoints.record("c_1", "src/a.ts", "before", "Apply");
    expect(row).toMatchObject({ conversationId: "c_1", path: "src/a.ts", content: "before", label: "Apply" });
    expect((await checkpoints.list("c_1")).map((r) => r.path)).toEqual(["src/a.ts"]);
    expect(await checkpoints.get(row?.id ?? "")).toEqual(row);
  });

  it("lists newest first, per chat, and keeps other chats out of the list", async () => {
    const { store: checkpoints } = store();
    await checkpoints.record("c_1", "a.ts", "1", "Apply");
    await checkpoints.record("c_1", "b.ts", "2", "Inline edit");
    await checkpoints.record("c_2", "c.ts", "3", "Apply");
    expect((await checkpoints.list("c_1")).map((r) => r.path)).toEqual(["b.ts", "a.ts"]);
    expect((await checkpoints.list("c_2")).map((r) => r.path)).toEqual(["c.ts"]);
    expect((await checkpoints.list(null)).map((r) => r.path)).toEqual(["c.ts", "b.ts", "a.ts"]);
  });

  it("keeps a file that was new as a contentless checkpoint, and refuses one too large to restore", async () => {
    const { store: checkpoints } = store();
    expect(await checkpoints.record("c_1", "new.ts", null, "Apply")).toMatchObject({ content: null });
    expect(await checkpoints.record("c_1", "huge.ts", "x".repeat(MAX_SNAPSHOT_CHARS + 1), "Apply")).toBeNull();
    expect((await checkpoints.list("c_1")).map((r) => r.path)).toEqual(["new.ts"]);
  });

  it("keeps only the newest per chat, so one busy chat cannot push the others out", async () => {
    const { store: checkpoints } = store();
    for (let i = 0; i < MAX_CHECKPOINTS_PER_CHAT + 5; i++) await checkpoints.record("c_1", `f${i}.ts`, `${i}`, "Apply");
    await checkpoints.record("c_2", "other.ts", "x", "Apply");
    const chatRows = await checkpoints.list("c_1");
    expect(chatRows).toHaveLength(MAX_CHECKPOINTS_PER_CHAT);
    expect(chatRows[0]).toMatchObject({ path: `f${MAX_CHECKPOINTS_PER_CHAT + 4}.ts` });
    expect(chatRows.at(-1)).toMatchObject({ path: `f5.ts` });
    expect(await checkpoints.get("other")).toBeNull();
    expect((await checkpoints.list("c_2")).map((r) => r.path)).toEqual(["other.ts"]);
  });

  it("removes one row and leaves the rest", async () => {
    const { store: checkpoints } = store();
    const first = await checkpoints.record("c_1", "a.ts", "1", "Apply");
    await checkpoints.record("c_1", "b.ts", "2", "Apply");
    await checkpoints.remove(first?.id ?? "");
    expect((await checkpoints.list("c_1")).map((r) => r.path)).toEqual(["b.ts"]);
    expect(await checkpoints.get(first?.id ?? "")).toBeNull();
  });

  it("accepts the shape a memento already holds without mangling it", async () => {
    const memento = fakeMemento();
    await memento.update("matterwave.checkpoints", [ROW({ id: "kept" })]);
    const checkpoints = new CheckpointStore(memento);
    expect((await checkpoints.list(null)).map((r) => r.id)).toEqual(["kept"]);
  });
});

describe("snapshot and restore round-trip", () => {
  beforeEach(() => {
    workspace.files.clear();
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
    const { store: checkpoints } = store();
    let recorded: string | null = null;
    await applyToFile(FILE, "after", {
      title: "t",
      onSnapshot: async (before) => {
        recorded = before;
        await checkpoints.record("c_1", "src/a.ts", before, "Apply");
      },
    });
    expect(recorded).toBe("before");
    expect(new TextDecoder().decode(workspace.files.get(FILE.toString()))).toBe("after");

    // The restore: the checkpoint's contents, back through the same path.
    const row = (await checkpoints.list("c_1"))[0];
    window.informationAnswers.length = 0;
    window.informationAnswers.push("Apply");
    await applyToFile(FILE, row?.content ?? "", { title: "restore" });
    expect(new TextDecoder().decode(workspace.files.get(FILE.toString()))).toBe("before");
  });
});
