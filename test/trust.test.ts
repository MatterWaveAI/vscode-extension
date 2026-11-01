import { afterEach, describe, expect, it } from "vitest";
import { requireTrust } from "../src/trust";
import { commands, window, workspace } from "./vscode-mock";

afterEach(() => {
  workspace.isTrusted = true;
  window.shown.length = 0;
  window.informationAnswers.length = 0;
  commands.executed.length = 0;
});

describe("requireTrust", () => {
  it("lets a trusted workspace through without a word", async () => {
    workspace.isTrusted = true;
    expect(await requireTrust("Apply")).toBe(true);
    expect(window.shown).toEqual([]);
  });

  it("stops in Restricted Mode, says what waits, and opens trust management when asked", async () => {
    workspace.isTrusted = false;
    window.informationAnswers.push("Manage Workspace Trust");
    expect(await requireTrust("Apply")).toBe(false);
    expect(window.shown[0]?.message).toBe("Apply is turned off in Restricted Mode. Trust this workspace to use it.");
    expect(commands.executed).toEqual(["workbench.trust.manage"]);
  });

  it("stops quietly when the person dismisses the warning", async () => {
    workspace.isTrusted = false;
    expect(await requireTrust("@git")).toBe(false);
    expect(commands.executed).toEqual([]);
  });
});
