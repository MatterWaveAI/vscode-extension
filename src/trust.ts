import * as vscode from "vscode";

/**
 * Restricted Mode: in a workspace the person has not trusted, MatterWave
 * still chats and reads context, but changes no file and runs no git (a
 * repository's own config can make `git diff` run a program it names).
 * The manifest declares this as limited support; this is where it holds.
 */

/** True in a trusted workspace; otherwise says what waits for trust, offers to manage it, and is false. */
export async function requireTrust(what: string): Promise<boolean> {
  if (vscode.workspace.isTrusted) return true;
  const manage = "Manage Workspace Trust";
  const answer = await vscode.window.showWarningMessage(
    `${what} is turned off in Restricted Mode. Trust this workspace to use it.`,
    manage,
  );
  if (answer === manage) void vscode.commands.executeCommand("workbench.trust.manage");
  return false;
}
