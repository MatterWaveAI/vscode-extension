import * as vscode from "vscode";
import { MatterWaveClient } from "./api/client";
import { ApiError } from "./api/errors";
import { createFetch } from "./api/transport";
import { DeviceLoginError, pollForDeviceToken } from "./auth/deviceLogin";
import { looksLikeApiKey, TokenStore } from "./auth/session";
import { signOut } from "./auth/signOut";
import { ChatController } from "./chat/controller";
import type { HostMessage } from "./chat/protocol";
import { ChatViewProvider } from "./chat/viewProvider";
import { fitsContentCap, MAX_CONTENT_CHARS, selectionContent } from "./context";
import { pickerRows, resolvePick, type PickerRow } from "./models";
import { DEFAULT_BASE_URL, normalizeServerUrl, serverUrlProblem, shouldPromptForServer } from "./settings";
import { StatusBar } from "./statusBar";

const MODEL_KEY = "matterwave.model";
/** Set once the server prompt has been shown, whatever was answered: it is a first-run question, not a nag. */
const SERVER_PROMPTED_KEY = "matterwave.serverPrompted";

function baseUrl(): string {
  const value = vscode.workspace.getConfiguration("matterwave").get<string>("baseUrl");
  return value && value.trim() ? value.trim() : DEFAULT_BASE_URL;
}

/** `matterwave.caFile`: a PEM path, or empty for the system's authorities alone. */
function caFile(): string {
  return vscode.workspace.getConfiguration("matterwave").get<string>("caFile")?.trim() ?? "";
}

/**
 * On the first activation that finds the default server in force, ask
 * which deployment this editor is for, prefilled, and keep the answer as
 * the user setting. Dismissed, the default stands and the question is not
 * asked again; the setting is always there to change it.
 */
async function promptForServer(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration("matterwave");
  const prompted = context.globalState.get<boolean>(SERVER_PROMPTED_KEY) === true;
  if (!shouldPromptForServer({ configured: config.get<string>("baseUrl"), prompted })) return;
  await context.globalState.update(SERVER_PROMPTED_KEY, true);
  const answer = await vscode.window.showInputBox({
    title: "MatterWave server",
    prompt: "The URL of the MatterWave deployment this editor talks to (the matterwave.baseUrl setting).",
    value: DEFAULT_BASE_URL,
    ignoreFocusOut: true,
    validateInput: serverUrlProblem,
  });
  const url = answer === undefined ? null : normalizeServerUrl(answer);
  if (url && url !== DEFAULT_BASE_URL) await config.update("baseUrl", url, vscode.ConfigurationTarget.Global);
}

/**
 * What `activate` returns (`vscode.extensions.getExtension(...).exports`):
 * the seam the end-to-end test drives a real chat through, in place of the
 * webview it cannot reach. Nothing here reveals the credential: the
 * controller never holds it, and a host message never carries it (a unit
 * test asserts so), so another extension learns no more than it could by
 * running the commands.
 */
export interface MatterWaveApi {
  chat: ChatController;
  /** Every message posted to the chat view, including the streamed deltas. */
  onHostMessage(listener: (message: HostMessage) => void): vscode.Disposable;
}

export function activate(context: vscode.ExtensionContext): MatterWaveApi {
  const tokens = new TokenStore(context.secrets, baseUrl);
  const statusBar = new StatusBar();
  const view = new ChatViewProvider(context.extensionUri);
  const taps = new Set<(message: HostMessage) => void>();

  // The client reports request ids and reachability to the controller,
  // which is built from the client; the callbacks only run on a request,
  // by which time `chat` exists.
  const client = new MatterWaveClient({
    baseUrl,
    getToken: () => tokens.get(),
    // Reads matterwave.caFile per request, so a change applies at once.
    fetch: createFetch(caFile),
    onRequestId: (id) => {
      chat.lastRequestId = id;
    },
    onReachability: (online) => chat.setOffline(!online),
  });
  const chat: ChatController = new ChatController({
    client,
    post: (message) => {
      view.post(message);
      for (const tap of taps) tap(message);
    },
    isSignedIn: async () => (await tokens.get()) !== null,
    rememberedModel: {
      get: () => context.globalState.get<string>(MODEL_KEY) ?? null,
      set: (id) => void context.globalState.update(MODEL_KEY, id),
    },
    runCommand: (command) => {
      const id = command === "signIn" ? "matterwave.signInWithDeviceCode" : `matterwave.${command}`;
      void vscode.commands.executeCommand(id);
    },
    onStatus: (status) => statusBar.update(status),
  });
  view.attach(chat);

  const command = (id: string, run: () => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, run));

  context.subscriptions.push(
    statusBar,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, view, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    tokens.onDidChange(() => void chat.refresh()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("matterwave.baseUrl")) {
        chat.newChat();
        void chat.refresh();
      } else if (event.affectsConfiguration("matterwave.caFile")) {
        // The next request reads the new file; refreshing makes it now.
        void chat.refresh();
      }
    }),
  );

  command("matterwave.signInWithDeviceCode", () => signInWithDeviceCode(client, tokens));
  command("matterwave.signInWithApiKey", () => signInWithApiKey(client, tokens));
  command("matterwave.signOut", async () => {
    switch (await signOut(client, tokens)) {
      case "not_signed_in":
        void vscode.window.showInformationMessage("Not signed in to MatterWave.");
        return;
      case "revoked":
        void vscode.window.showInformationMessage("Signed out of MatterWave; the editor's key was revoked.");
        return;
      case "revoke_failed":
        void vscode.window.showWarningMessage(
          "Signed out of MatterWave, but its key could not be revoked on the server. Revoke it under Settings → API keys.",
        );
        return;
      case "kept":
        void vscode.window.showInformationMessage("Signed out of MatterWave.");
        return;
    }
  });
  command("matterwave.newChat", async () => {
    await view.reveal();
    chat.newChat();
  });
  command("matterwave.askAboutSelection", () => askAboutSelection(chat, view));
  command("matterwave.askAboutFile", () => askAboutFile(chat, view));
  command("matterwave.pickModel", () => pickModel(chat));
  command("matterwave.compactNow", async () => {
    if (!chat.hasConversation()) {
      void vscode.window.showInformationMessage("Open a conversation to compact it.");
      return;
    }
    await view.reveal();
    await chat.compact();
  });
  command("matterwave.copyRequestId", async () => {
    if (!chat.lastRequestId) {
      void vscode.window.showInformationMessage("No MatterWave request has been made yet.");
      return;
    }
    await vscode.env.clipboard.writeText(chat.lastRequestId);
    void vscode.window.showInformationMessage(`Copied request id ${chat.lastRequestId}.`);
  });

  void chat.refresh();
  void promptForServer(context);

  return {
    chat,
    onHostMessage: (listener) => {
      taps.add(listener);
      return { dispose: () => void taps.delete(listener) };
    },
  };
}

export function deactivate(): void {
  // Everything is in context.subscriptions.
}

async function signInWithDeviceCode(client: MatterWaveClient, tokens: TokenStore): Promise<void> {
  let authorization;
  try {
    authorization = await client.startDeviceLogin(`VS Code (${vscode.env.appName})`);
  } catch (error) {
    void vscode.window.showErrorMessage(`MatterWave sign-in could not start: ${describe(error)}`);
    return;
  }
  const opened = await vscode.env.openExternal(vscode.Uri.parse(authorization.verification_uri_complete));
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: opened
        ? `Confirm the code ${authorization.user_code} in your browser to sign in to MatterWave…`
        : `Open ${authorization.verification_uri} and enter ${authorization.user_code} to sign in to MatterWave…`,
      cancellable: true,
    },
    async (_progress, cancel) => {
      try {
        const token = await pollForDeviceToken({
          authorization,
          poll: (code) => client.pollDeviceToken(code),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          isCancelled: () => cancel.isCancellationRequested,
        });
        await tokens.set(token.access_token, true);
        void vscode.window.showInformationMessage("Signed in to MatterWave.");
      } catch (error) {
        if (error instanceof DeviceLoginError && error.reason === "cancelled") return;
        void vscode.window.showErrorMessage(describe(error));
      }
    },
  );
}

async function signInWithApiKey(client: MatterWaveClient, tokens: TokenStore): Promise<void> {
  const key = await vscode.window.showInputBox({
    title: "MatterWave API key",
    prompt: "Paste an API key (mw_…) from Settings → API keys. It is kept in the editor's secret storage.",
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (looksLikeApiKey(value) ? null : "An API key starts with mw_"),
  });
  if (!key) return;
  // Verified before it is kept: a key that does not work should fail here,
  // with the reason, not on the first message.
  const probe = new MatterWaveClient({
    baseUrl: client.baseUrl,
    getToken: async () => key.trim(),
    fetch: createFetch(caFile),
  });
  try {
    const me = await probe.me();
    await tokens.set(key.trim());
    void vscode.window.showInformationMessage(`Signed in to MatterWave as ${me.name || me.email || me.subject}.`);
  } catch (error) {
    void vscode.window.showErrorMessage(`That key was not accepted: ${describe(error)}`);
  }
}

async function askAboutSelection(chat: ChatController, view: ChatViewProvider): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    void vscode.window.showInformationMessage("Select some code first, or use MatterWave: Ask about File.");
    return;
  }
  const question = await vscode.window.showInputBox({ title: "Ask about the selection", value: "Explain this code." });
  if (!question) return;
  const { selection, document } = editor;
  const content = selectionContent({
    question,
    code: document.getText(selection),
    languageId: document.languageId,
    path: vscode.workspace.asRelativePath(document.uri, false),
    startLine: selection.start.line + 1,
    endLine: selection.end.line + 1,
  });
  if (!fitsContentCap(content)) {
    void vscode.window.showWarningMessage(
      `The selection is too long to send inline (over ${MAX_CONTENT_CHARS.toLocaleString()} characters). Use Ask about File instead.`,
    );
    return;
  }
  await view.reveal();
  await chat.send(content);
}

async function askAboutFile(chat: ChatController, view: ChatViewProvider): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage("Open a file first.");
    return;
  }
  const question = await vscode.window.showInputBox({ title: "Ask about the file", value: "Explain this file." });
  if (!question) return;
  const path = vscode.workspace.asRelativePath(editor.document.uri, false);
  await view.reveal();
  await chat.askAboutFile(question, editor.document.getText(), path);
}

type PickItem = vscode.QuickPickItem & { row: PickerRow };

async function pickModel(chat: ChatController): Promise<void> {
  let models;
  try {
    models = await chat.loadModels();
  } catch (error) {
    void vscode.window.showErrorMessage(`The model list could not be loaded: ${describe(error)}`);
    return;
  }
  const items: PickItem[] = pickerRows(models, chat.currentModel()?.id ?? null).map((row) =>
    row.kind === "heading"
      ? { label: row.label, kind: vscode.QuickPickItemKind.Separator, row }
      : { label: row.label, description: row.description, row },
  );
  const picked = await vscode.window.showQuickPick(items, { title: "MatterWave model", matchOnDescription: true });
  if (!picked) return;
  const model = resolvePick(picked.row);
  if (model) {
    chat.setModel(model);
    return;
  }
  if (picked.row.kind === "model") {
    const plan = picked.row.model.upgrade_to;
    void vscode.window.showInformationMessage(
      plan
        ? `${picked.row.model.label || picked.row.model.id} is not on your plan. ${plan} includes it.`
        : `${picked.row.model.label || picked.row.model.id} is not on your plan.`,
    );
  }
}

function describe(error: unknown): string {
  if (error instanceof ApiError) return error.requestId ? `${error.detail} (reference ${error.requestId})` : error.detail;
  return error instanceof Error ? error.message : String(error);
}
