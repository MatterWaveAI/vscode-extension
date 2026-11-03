import * as vscode from "vscode";
import type { AgentEngine } from "./agent/session";
import type { StatusInfo } from "./chat/controller";
import type { UsageView } from "./chat/protocol";

function t(message: string, ...args: Array<string | number | boolean>): string {
  if (typeof vscode.l10n?.t === "function") {
    return vscode.l10n.t(message, ...args);
  }
  return message.replace(/\{(\d+)\}/g, (_match, index: string) => {
    const val = args[Number(index)];
    return val !== undefined ? String(val) : `{${index}}`;
  });
}

/** Format the configured agent engine and Pi 1.0 binary availability for the status bar / picker. */
export function formatAgentEngineStatus(engine: AgentEngine, piAvailable: boolean): string {
  switch (engine) {
    case "auto":
      return piAvailable ? t("Pi 1.0 (auto)") : t("Built-in (auto fallback)");
    case "pi":
      return piAvailable ? t("Pi 1.0") : t("Pi 1.0 (unavailable)");
    case "builtin":
    default:
      return t("Built-in");
  }
}

/** The status-bar item's text, tooltip and command for a state. Pure for the tests. */
export function statusText(status: StatusInfo): { text: string; tooltip: string; command: string } {
  if (!status.signedIn) {
    return {
      text: t("$(account) MatterWave: sign in"),
      tooltip: t("Sign in to MatterWave"),
      command: "matterwave.signInWithDeviceCode",
    };
  }
  if (status.offline) {
    return {
      text: t("$(debug-disconnect) MatterWave offline"),
      tooltip: t("MatterWave could not be reached"),
      command: "matterwave.pickModel",
    };
  }
  const pieces = [status.model ?? t("no model")];
  if (status.meterPercent !== null) pieces.push(`${status.meterPercent}%`);
  // The bell: unread notifications ride on the item's face, the way the web app's does.
  if (status.unreadNotifications > 0) pieces.push(`$(bell) ${status.unreadNotifications}`);
  // The agent's approval mode, visible from anywhere while agent mode is on.
  if (status.agentMode) pieces.push(`$(hubot) ${status.agentMode}`);
  const tooltip = [
    status.identity ? t("Signed in as {0}", status.identity) : t("Signed in"),
    status.model ? t("Model: {0}", status.model) : null,
    status.meterPercent !== null ? t("Context used: {0}%", status.meterPercent) : null,
    status.unreadNotifications > 0 ? t("Notifications: {0} unread", status.unreadNotifications) : null,
    status.agentMode ? t("Agent mode: {0}", status.agentMode) : null,
    status.agentEngine ? t("Agent engine: {0}", formatAgentEngineStatus(status.agentEngine, Boolean(status.piAvailable))) : null,
    status.usage ? allowanceLine(status.usage) : null,
    t("Click to pick a model"),
  ]
    .filter(Boolean)
    .join("\n");
  return { text: `$(comment-discussion) ${pieces.join(" · ")}`, tooltip, command: "matterwave.pickModel" };
}

/** The allowance as one tooltip line: used of included, the percent, and the overage state. */
function allowanceLine(usage: UsageView): string {
  const balance = t(
    "Allowance: {0} of {1} tokens ({2}%)",
    usage.used.toLocaleString(),
    usage.included.toLocaleString(),
    Math.round(usage.percent),
  );
  const state =
    usage.state === "exhausted"
      ? t("exhausted")
      : usage.state === "overage"
        ? t("in overage")
        : usage.state === "warn"
          ? t("running low")
          : null;
  const allowance = state ? `${balance} — ${state}` : balance;
  const cap = usage.memberCap;
  if (!cap) return allowance;
  const capLine = cap.exhausted
    ? t("Your cap: ${0} of ${1} — reached", cap.spentUsd.toFixed(2), cap.capUsd.toFixed(2))
    : t("Your cap: ${0} of ${1}", cap.spentUsd.toFixed(2), cap.capUsd.toFixed(2));
  return `${allowance}\n${capLine}`;
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
