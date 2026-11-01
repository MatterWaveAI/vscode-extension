import { describe, expect, it } from "vitest";
import type * as vscode from "vscode";
import { CODE_ACTION_COMMANDS, fixInstruction, MatterWaveCodeActions } from "../src/codeActions";
import { CodeActionKind, Position, Range, Uri } from "./vscode-mock";

const DOC = { uri: Uri.file("/ws/src/a.ts") } as unknown as vscode.TextDocument;
const at = (line: number, from: number, to: number) => new Range(new Position(line, from), new Position(line, to));

function provide(range: Range, diagnostics: { message: string; range: Range; source?: string; code?: unknown }[] = []) {
  return new MatterWaveCodeActions().provideCodeActions(
    DOC,
    range as unknown as vscode.Range,
    { diagnostics, triggerKind: 1, only: undefined } as unknown as vscode.CodeActionContext,
  ) as unknown as { title: string; kind: CodeActionKind; diagnostics?: unknown[]; command: { command: string; arguments: unknown[] } }[];
}

describe("MatterWaveCodeActions", () => {
  it("offers a Fix for each problem under the cursor, carrying its range and an instruction naming it", () => {
    const problem = { message: "Property 'lenght' does not exist on type 'string'.", range: at(3, 4, 10), source: "ts", code: 2339 };
    const [fix] = provide(at(3, 5, 5), [problem]);
    expect(fix?.title).toBe("Fix with MatterWave: Property 'lenght' does not exist on type 'string'.");
    expect(fix?.kind).toBe(CodeActionKind.QuickFix);
    expect(fix?.diagnostics).toEqual([problem]);
    expect(fix?.command.command).toBe(CODE_ACTION_COMMANDS.fix);
    expect(fix?.command.arguments).toEqual([
      DOC.uri,
      problem.range,
      "Fix this problem (ts 2339): Property 'lenght' does not exist on type 'string'. Change only what the fix needs.",
    ]);
  });

  it("offers at most three fixes, and shortens a long message", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ message: `${"x".repeat(80)} ${i}\nsecond line`, range: at(i, 0, 1) }));
    const actions = provide(at(0, 0, 0), many);
    expect(actions).toHaveLength(3);
    expect(actions[0]?.title.length).toBeLessThanOrEqual("Fix with MatterWave: ".length + 60);
    expect(actions[0]?.title).not.toContain("second line");
  });

  it("offers Explain, Generate Tests and Add Docs for a selection, and nothing for a bare cursor", () => {
    const selection = at(1, 0, 20);
    const actions = provide(selection);
    expect(actions.map((a) => a.title)).toEqual(["Explain with MatterWave", "Generate Tests with MatterWave", "Add Docs with MatterWave"]);
    expect(actions.map((a) => a.command.command)).toEqual([CODE_ACTION_COMMANDS.explain, CODE_ACTION_COMMANDS.tests, CODE_ACTION_COMMANDS.docs]);
    expect(actions.every((a) => a.kind.value === "refactor.matterwave")).toBe(true);
    expect(actions[0]?.command.arguments).toEqual([DOC.uri, selection]);
    expect(provide(at(1, 4, 4))).toEqual([]);
  });
});

describe("fixInstruction", () => {
  it("names the tool and code that reported the problem, when they are known", () => {
    expect(fixInstruction({ message: "Missing semicolon.", source: "eslint", code: { value: "semi" } })).toBe(
      "Fix this problem (eslint semi): Missing semicolon. Change only what the fix needs.",
    );
    expect(fixInstruction({ message: " Unused variable " })).toBe("Fix this problem: Unused variable. Change only what the fix needs.");
    // Only the closing full stop goes, not a word's last letter.
    expect(fixInstruction({ message: "Too many arguments." })).toBe("Fix this problem: Too many arguments. Change only what the fix needs.");
  });
});
