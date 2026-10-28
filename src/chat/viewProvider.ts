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

  constructor(private readonly extensionUri: vscode.Uri) {}

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
 * nonce'd block, images only from the extension itself, and no network at
 * all -- `connect-src` is absent, so the page could not reach the API even if
 * it had something to reach it with.
 */
export function chatHtml({ cspSource, scriptUri, nonce }: { cspSource: string; scriptUri: string; nonce: string }): string {
  const csp = [
    "default-src 'none'",
    `img-src ${cspSource}`,
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
<div id="app" role="application" aria-label="MatterWave chat"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

const STYLES = `
:root { color-scheme: light dark; }
body { margin: 0; padding: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
#app { display: flex; flex-direction: column; height: 100vh; }
button { font: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; padding: 3px 8px; border-radius: 2px; cursor: pointer; }
button:hover { background: var(--vscode-button-hoverBackground); }
button.link { background: none; color: var(--vscode-textLink-foreground); padding: 0 2px; }
button:disabled { opacity: .5; cursor: default; }
.bar { display: flex; gap: 6px; align-items: center; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
.bar select { flex: 1; min-width: 0; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); }
.meta { display: flex; gap: 8px; align-items: center; padding: 4px 8px; font-size: 90%; opacity: .85; }
.meter { flex: 1; height: 4px; background: var(--vscode-progressBar-background); opacity: .3; border-radius: 2px; position: relative; }
.meter > i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--vscode-progressBar-background); border-radius: 2px; opacity: 1; }
.transcript { flex: 1; overflow-y: auto; padding: 8px; }
.msg { margin-bottom: 12px; }
.msg .who { font-weight: 600; font-size: 90%; opacity: .8; display: flex; gap: 6px; align-items: center; }
.msg.user .body { background: var(--vscode-input-background); padding: 6px 8px; border-radius: 4px; white-space: pre-wrap; }
.msg .body pre { background: var(--vscode-textCodeBlock-background); padding: 6px; overflow-x: auto; }
.msg .body code { font-family: var(--vscode-editor-font-family); }
.msg .actions { display: flex; gap: 4px; margin-top: 2px; }
details { border-left: 2px solid var(--vscode-panel-border); padding-left: 6px; margin: 4px 0; }
details summary { cursor: pointer; opacity: .8; }
details pre { white-space: pre-wrap; }
.notice, .error { margin: 6px 8px; padding: 6px 8px; border-radius: 4px; }
.notice { background: var(--vscode-inputValidation-infoBackground); border: 1px solid var(--vscode-inputValidation-infoBorder); }
.error { background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); }
.error .title { font-weight: 600; }
.cut { margin-top: 4px; font-size: 90%; display: flex; gap: 6px; align-items: center; opacity: .9; }
.divider { display: flex; align-items: center; gap: 6px; margin: 10px 0; font-size: 90%; opacity: .85; }
.divider::before, .divider::after { content: ""; flex: 1; border-top: 1px dashed var(--vscode-panel-border); }
.originals { opacity: .7; border-left: 2px dashed var(--vscode-panel-border); padding-left: 6px; }
.composer { display: flex; flex-direction: column; gap: 4px; padding: 8px; border-top: 1px solid var(--vscode-panel-border); }
.composer textarea { resize: vertical; min-height: 48px; font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 4px; }
.composer .row { display: flex; gap: 6px; justify-content: flex-end; }
.temporary { display: flex; gap: 4px; align-items: center; font-size: 90%; opacity: .85; }
.instructions, .fb-picker { display: flex; flex-direction: column; gap: 4px; padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
.instructions textarea, .fb-picker textarea { resize: vertical; min-height: 48px; font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 4px; }
.instructions .row, .fb-picker .row { display: flex; gap: 6px; justify-content: flex-end; }
.instructions .hint { font-size: 90%; opacity: .75; }
.fb-picker .fb-reason { display: flex; gap: 4px; align-items: center; font-size: 95%; }
.badge { font-weight: 600; text-decoration: underline; }
.signin { padding: 16px; display: flex; flex-direction: column; gap: 8px; }
.convos { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
.convos input { font: inherit; font-size: 95%; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; min-width: 0; }
.convos-list { display: flex; flex-direction: column; gap: 1px; max-height: 140px; overflow-y: auto; }
.convos-list .row { display: flex; gap: 4px; align-items: center; min-height: 22px; }
.convos-list .row .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; color: var(--vscode-foreground); }
.convos-list .row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: stretch; }
.convos-list .snippet { font-size: 85%; opacity: .7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.convos-list .row.active .title { font-weight: 600; }
.convos-list .row-actions { display: flex; gap: 2px; opacity: .55; flex: none; }
.convos-list .row:hover .row-actions, .convos-list .row:focus-within .row-actions { opacity: 1; }
.convos-list .row-actions button { font-size: 85%; padding: 0 3px; }
.convos-list .empty { margin: 2px 0; font-size: 90%; opacity: .7; }
.convos details.archived summary { cursor: pointer; font-size: 90%; opacity: .8; }
button.rated { font-weight: 600; text-decoration: underline; }
`;
