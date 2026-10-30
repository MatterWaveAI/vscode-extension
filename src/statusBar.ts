import * as vscode from "vscode";
import type { StatusInfo } from "./chat/controller";
import type { UsageView } from "./chat/protocol";

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
  // The bell: unread notifications ride on the item's face, the way the web app's does.
  if (status.unreadNotifications > 0) pieces.push(`$(bell) ${status.unreadNotifications}`);
  const tooltip = [
    status.identity ? `Signed in as ${status.identity}` : "Signed in",
    status.model ? `Model: ${status.model}` : null,
    status.meterPercent !== null ? `Context used: ${status.meterPercent}%` : null,
    status.unreadNotifications > 0 ? `Notifications: ${status.unreadNotifications} unread` : null,
    status.usage ? allowanceLine(status.usage) : null,
    "Click to pick a model",
  ]
    .filter(Boolean)
    .join("\n");
  return { text: `$(comment-discussion) ${pieces.join(" · ")}`, tooltip, command: "matterwave.pickModel" };
}

/** The allowance as one tooltip line: used of included, the percent, and the overage state. */
function allowanceLine(usage: UsageView): string {
  const balance = `Allowance: ${usage.used.toLocaleString()} of ${usage.included.toLocaleString()} tokens (${Math.round(usage.percent)}%)`;
  const state =
    usage.state === "exhausted"
      ? "exhausted"
      : usage.state === "overage"
        ? "in overage"
        : usage.state === "warn"
          ? "running low"
          : null;
  return state ? `${balance} — ${state}` : balance;
}

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

  constructor() {
    this.update({ signedIn: false, offline: false, identity: null, model: null, meterPercent: null, unreadNotifications: 0, usage: null });
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
