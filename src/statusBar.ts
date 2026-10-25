import * as vscode from "vscode";
import type { StatusInfo } from "./chat/controller";

/** The status-bar item's text, tooltip and command for a state. Pure for the tests. */
export function statusText(status: StatusInfo): { text: string; tooltip: string; command: string } {
  if (!status.signedIn) {
    return { text: "$(account) MatterWave: sign in", tooltip: "Sign in to MatterWave", command: "matterwave.signInWithDeviceCode" };
  }
  if (status.offline) {
    return { text: "$(debug-disconnect) MatterWave offline", tooltip: "MatterWave could not be reached", command: "matterwave.pickModel" };
  }
  const pieces = [status.model ?? "no model"];
  if (status.meterPercent !== null) pieces.push(`${status.meterPercent}%`);
  const tooltip = [
    status.identity ? `Signed in as ${status.identity}` : "Signed in",
    status.model ? `Model: ${status.model}` : null,
    status.meterPercent !== null ? `Context used: ${status.meterPercent}%` : null,
    "Click to pick a model",
  ]
    .filter(Boolean)
    .join("\n");
  return { text: `$(comment-discussion) ${pieces.join(" · ")}`, tooltip, command: "matterwave.pickModel" };
}

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

  constructor() {
    this.update({ signedIn: false, offline: false, identity: null, model: null, meterPercent: null });
    this.item.show();
  }

  update(status: StatusInfo): void {
    const view = statusText(status);
    this.item.text = view.text;
    this.item.tooltip = view.tooltip;
    this.item.command = view.command;
  }

  dispose(): void {
    this.item.dispose();
  }
}
