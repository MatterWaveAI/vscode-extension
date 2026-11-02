import * as vscode from "vscode";
import type { ChatController } from "./controller";
import { parseWebviewMessage, type HostMessage } from "./protocol";

/**
 * The activity-bar chat view. A thin bridge: intents from the webview go to
 * the controller, and the controller's state comes back as messages. The
 * HTML carries no data at all -- the first state arrives after `ready` -- so
 * nothing about the session is ever baked into the page.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "matterwave.chat";
  private view: vscode.WebviewView | undefined;
  private controller: ChatController | undefined;

  /** `onOpen` runs each time the view is shown afresh: the first-run questions wait for it. */
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onOpen?: () => void,
  ) {}

  attach(controller: ChatController): void {
    this.controller = controller;
  }

  /** Posted only while the view exists; the next `ready` re-sends the whole state. */
  post(message: HostMessage): void {
    void this.view?.webview.postMessage(message);
  }

  async reveal(): Promise<void> {
    if (this.view) {
      this.view.show(true);
      return;
    }
    await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const dist = vscode.Uri.joinPath(this.extensionUri, "dist");
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    view.webview.html = chatHtml({
      cspSource: view.webview.cspSource,
      scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(dist, "webview.js")).toString(),
      nonce: makeNonce(),
    });
    view.webview.onDidReceiveMessage((raw: unknown) => {
      const message = parseWebviewMessage(raw);
      if (message) void this.controller?.handle(message);
    });
    view.onDidDispose(() => {
      this.view = undefined;
    });
    this.onOpen?.();
  }
}

export function makeNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/**
 * The page. Strict CSP: no default source, scripts only with this load's
 * nonce (so no inline handler and no remote script can run), styles from the
 * nonce'd block, images from the extension itself or `data:` URIs the host
 * posted for image attachments, and no network at all -- `connect-src` is
 * absent, so the page could not reach the API even if it had something to
 * reach it with.
 */
export function chatHtml({ cspSource, scriptUri, nonce }: { cspSource: string; scriptUri: string; nonce: string }): string {
  const csp = [
    "default-src 'none'",
    `img-src ${cspSource} data:`,
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${cspSource}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MatterWave</title>
<style nonce="${nonce}">${STYLES}</style>
</head>
<body>
<header class="sr-only"><h1>MatterWave chat</h1></header>
<main id="app" aria-label="MatterWave chat"></main>
<div id="announcer" class="sr-only" role="status" aria-live="polite"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

const STYLES = `
:root { color-scheme: light dark; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
body { margin: 0; padding: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
#app { display: flex; flex-direction: column; height: 100vh; }
button { font: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; padding: 3px 8px; border-radius: 2px; cursor: pointer; }
button:hover { background: var(--vscode-button-hoverBackground); }
button.link { background: none; color: var(--vscode-textLink-foreground); padding: 0 2px; }
button:disabled { opacity: .5; cursor: default; }
.bar { display: flex; gap: 6px; align-items: center; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
.bar select { flex: 1; min-width: 0; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); }
.meta { display: flex; gap: 8px; align-items: center; padding: 4px 8px; font-size: 90%; opacity: .85; }
.meta .identity { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 30%; }
.meter { flex: 1; height: 4px; background: var(--vscode-progressBar-background); opacity: .3; border-radius: 2px; position: relative; }
.meter > i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--vscode-progressBar-background); border-radius: 2px; opacity: 1; }
.transcript { flex: 1; overflow-y: auto; padding: 8px; }
.msg { margin-bottom: 12px; }
.msg .who { font-weight: 600; font-size: 90%; opacity: .8; display: flex; gap: 6px; align-items: center; }
.msg.user .body { background: var(--vscode-input-background); padding: 6px 8px; border-radius: 4px; white-space: pre-wrap; }
.msg .body pre { background: var(--vscode-textCodeBlock-background); padding: 6px; overflow-x: auto; }
.msg .body code { font-family: var(--vscode-editor-font-family); }
.apply-wrap pre { margin-bottom: 0; border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
.tok-comment { color: var(--vscode-descriptionForeground); font-style: italic; }
.tok-string { color: var(--vscode-symbolIcon-stringForeground, var(--vscode-debugTokenExpression-string)); }
.tok-number { color: var(--vscode-symbolIcon-numberForeground, var(--vscode-debugTokenExpression-number)); }
.tok-keyword { color: var(--vscode-symbolIcon-keywordForeground, var(--vscode-debugTokenExpression-name)); }
.suggestions { display: flex; flex-direction: column; border: 1px solid var(--vscode-editorSuggestWidget-border, var(--vscode-panel-border)); background: var(--vscode-editorSuggestWidget-background, var(--vscode-input-background)); max-height: 160px; overflow-y: auto; }
.suggestions [role=option] { padding: 2px 6px; cursor: pointer; display: flex; gap: 8px; }
.suggestions [role=option] .detail { opacity: .7; }
.suggestions [role=option][aria-selected=true] { background: var(--vscode-editorSuggestWidget-selectedBackground, var(--vscode-list-activeSelectionBackground)); color: var(--vscode-editorSuggestWidget-selectedForeground, var(--vscode-list-activeSelectionForeground)); }
.apply-bar { display: flex; gap: 6px; padding: 1px 2px 6px; background: var(--vscode-textCodeBlock-background); border-bottom-left-radius: 4px; border-bottom-right-radius: 4px; margin-bottom: 6px; }
.msg .actions { display: flex; gap: 4px; margin-top: 2px; }
details { border-left: 2px solid var(--vscode-panel-border); padding-left: 6px; margin: 4px 0; }
details summary { cursor: pointer; opacity: .8; }
details pre { white-space: pre-wrap; }
.notice, .error { margin: 6px 8px; padding: 6px 8px; border-radius: 4px; }
.notice { background: var(--vscode-inputValidation-infoBackground); border: 1px solid var(--vscode-inputValidation-infoBorder); white-space: pre-line; }
.error { background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); }
.announcement.warning { background: var(--vscode-inputValidation-warningBackground); border-color: var(--vscode-inputValidation-warningBorder); }
.announcement.critical { background: var(--vscode-inputValidation-errorBackground); border-color: var(--vscode-inputValidation-errorBorder); }
.error .title { font-weight: 600; }
.cut { margin-top: 4px; font-size: 90%; display: flex; gap: 6px; align-items: center; opacity: .9; }
img.image-preview { display: block; max-width: 100%; max-height: 320px; margin-top: 4px; border-radius: 4px; border: 1px solid var(--vscode-panel-border); }
.divider { display: flex; align-items: center; gap: 6px; margin: 10px 0; font-size: 90%; opacity: .85; }
.divider::before, .divider::after { content: ""; flex: 1; border-top: 1px dashed var(--vscode-panel-border); }
.originals { opacity: .7; border-left: 2px dashed var(--vscode-panel-border); padding-left: 6px; }
.composer { display: flex; flex-direction: column; gap: 4px; padding: 8px; border-top: 1px solid var(--vscode-panel-border); }
.composer textarea { resize: vertical; min-height: 48px; font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 4px; }
.composer .row { display: flex; gap: 6px; justify-content: flex-end; }
.temporary { display: flex; gap: 4px; align-items: center; font-size: 90%; opacity: .85; }
.connector { display: flex; flex-direction: column; gap: 6px; padding: 8px; border-top: 1px solid var(--vscode-panel-border); background: var(--vscode-inputValidation-infoBackground); }
.connector .row { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap; }
.instructions, .fb-picker, .notifications { display: flex; flex-direction: column; gap: 4px; padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
.instructions textarea, .fb-picker textarea { resize: vertical; min-height: 48px; font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 4px; }
.instructions .row, .fb-picker .row, .notifications .row { display: flex; gap: 6px; justify-content: flex-end; }
.instructions .hint { font-size: 90%; opacity: .75; }
.fb-picker .fb-reason { display: flex; gap: 4px; align-items: center; font-size: 95%; }
.badge { font-weight: 600; text-decoration: underline; }
.notifications .empty { margin: 2px 0; font-size: 90%; opacity: .7; }
.notif-filters { display: flex; gap: 4px; align-items: center; font-size: 90%; opacity: .85; }
.notif { display: flex; gap: 6px; align-items: flex-start; }
.notif-main { flex: 1; min-width: 0; }
.notif-title.unread { font-weight: 600; }
.notif-body { font-size: 90%; opacity: .8; white-space: pre-wrap; }
.notif-when { font-size: 85%; opacity: .6; }
.notif .row-actions { flex: none; opacity: 1; }
.usage { font-size: 90%; }
.answer-usage { font-size: 85%; opacity: .65; margin-top: 2px; }
.usage.warn { font-weight: 600; }
.signin { padding: 16px; display: flex; flex-direction: column; gap: 8px; }
.convos { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
.convos input { font: inherit; font-size: 95%; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; min-width: 0; }
.convos-list { display: flex; flex-direction: column; gap: 1px; max-height: 140px; overflow-y: auto; }
.convos-list .row { display: flex; gap: 4px; align-items: center; min-height: 22px; }
.convos-list .row .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; color: var(--vscode-foreground); }
.convos-list .row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: stretch; }
.convos-list .snippet { font-size: 85%; opacity: .7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.convos-list .row.active .title { font-weight: 600; }
.convos-list .lib-badge { font-size: 85%; opacity: .7; font-weight: normal; margin-left: 6px; }
.convos-list .row-actions { display: flex; gap: 2px; opacity: .55; flex: none; }
.convos-list .row:hover .row-actions, .convos-list .row:focus-within .row-actions { opacity: 1; }
.convos-list .row-actions button { font-size: 85%; padding: 0 3px; }
.convos-list .empty { margin: 2px 0; font-size: 90%; opacity: .7; }
.convos details.archived summary { cursor: pointer; font-size: 90%; opacity: .8; }
button.rated { font-weight: 600; text-decoration: underline; }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.agent-bar { display: flex; gap: 6px; align-items: center; font-size: 90%; flex-wrap: wrap; }
.agent-bar .agent-reason { opacity: .75; font-size: 95%; }
.agent-bar .root { opacity: .85; color: var(--vscode-foreground); }
.mode-chip { font-size: 85%; padding: 0 6px; border-radius: 8px; }
.mode-chip.mode-plan { background: var(--vscode-charts-blue, #3794ff); }
.mode-chip.mode-auto-edit { background: var(--vscode-charts-orange, #d18616); }
.mode-chip.mode-yolo { background: var(--vscode-inputValidation-errorBorder, #be1100); }
.agent-status .line { font-size: 90%; opacity: .9; }
.agent-status .dim { opacity: .7; }
.agent-status pre.output { max-height: 120px; overflow: auto; font-size: 85%; margin: 2px 0; background: var(--vscode-textCodeBlock-background); padding: 4px; white-space: pre-wrap; }
.approval { border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-panel-border)); background: var(--vscode-inputValidation-warningBackground, transparent); border-radius: 4px; padding: 6px; display: flex; flex-direction: column; gap: 4px; }
.approval .who { font-weight: 600; }
.approval .hint { font-size: 90%; opacity: .8; }
.approval pre.command { white-space: pre-wrap; word-break: break-all; background: var(--vscode-textCodeBlock-background); padding: 4px; margin: 0; font-family: var(--vscode-editor-font-family); }
pre.diff { max-height: 220px; overflow: auto; margin: 0; padding: 4px; background: var(--vscode-textCodeBlock-background); font-family: var(--vscode-editor-font-family); font-size: 90%; }
pre.diff .add { color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b); }
pre.diff .del { color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); }
pre.diff .hunk { opacity: .7; }
.todos { display: flex; flex-direction: column; gap: 1px; font-size: 90%; border-left: 2px solid var(--vscode-panel-border); padding-left: 6px; }
.todos .who { font-weight: 600; }
.todos .completed { opacity: .6; text-decoration: line-through; }
.todos .in_progress { font-weight: 600; }
.usage-panel { display: flex; flex-direction: column; gap: 4px; padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); font-size: 90%; }
.usage-panel .runs { max-height: 160px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.usage-panel .run { opacity: .9; }
.usage-panel .row { display: flex; gap: 6px; justify-content: flex-end; }
`;
