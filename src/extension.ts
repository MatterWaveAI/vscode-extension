import * as vscode from "vscode";
import { MatterWaveClient, requestLogLine } from "./api/client";
import { ApiError } from "./api/errors";
import { createFetch } from "./api/transport";
import { DeviceLoginError, pollForDeviceToken } from "./auth/deviceLogin";
import { looksLikeApiKey, TokenStore } from "./auth/session";
import { signOut } from "./auth/signOut";
import { ChatController, libraryBadge } from "./chat/controller";
import type { HostMessage } from "./chat/protocol";
import type { FolderRow, Library, TagRow } from "./api/types";
import { ChatViewProvider } from "./chat/viewProvider";
import { fitsContentCap, MAX_CONTENT_CHARS, imageAttachment, imageContentType, selectionContent } from "./context";
import { applyToFile, registerApplyContentProvider } from "./apply";
import { CheckpointStore, type Checkpoint } from "./checkpoints";
import { snapshotFolder } from "./snapshotFiles";
import { requireTrust } from "./trust";
import {
  CODE_ACTION_COMMANDS,
  DOCS_INSTRUCTION,
  EXPLAIN_QUESTION,
  fixInstruction,
  MatterWaveCodeActions,
  TESTS_QUESTION,
} from "./codeActions";
import type { CodeBlock } from "./chat/codeBlocks";
import { fitReplacement, inlineEditPrompt, replacementFromAnswer, selectedLines } from "./inlineEdit";
import {
  docsContext,
  fetchDocText,
  fileContext,
  folderContext,
  folderTree,
  gitContext,
  mentionLabel,
  terminalContext,
} from "./contextProviders";
import { mentionTitle, type Mention } from "./chat/mentions";
import { proposedCommand, terminalCommandPrompt, TerminalHistory, terminalText } from "./terminalOutput";
import { keyDetail } from "./keys";
import { conversationToMarkdown, safeFilename } from "./chat/export";
import type { ApiKeyListing, ImportRecord } from "./api/types";
import { pickerRows, resolvePick, type PickerRow } from "./models";
import { DEFAULT_BASE_URL, normalizeServerUrl, serverUrlProblem, shouldPromptForServer } from "./settings";
import { StatusBar } from "./statusBar";
import { normalizePromptName, PromptLibrary, MAX_PROMPTS, MAX_PROMPT_TEXT, type PromptRow, type PromptScope } from "./promptLibrary";
import { currentFolder, editorFolders, resolveNamedFile, whereItLands } from "./targets";
import { pickWorkspaceFile as pickFile } from "./fileSearch";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
 * The first time the chat view opens (or a sign-in starts) with the
 * default server in force, ask which deployment this editor is for,
 * prefilled, and keep the answer as the user setting. Never on install or
 * at start-up: nothing is asked until MatterWave is used. Dismissed, the
 * default stands and the question is not asked again; the setting is
 * always there to change it.
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
 * What `activate` returns under the extension test runner
 * (`vscode.extensions.getExtension(...).exports`): the seam the end-to-end
 * test drives a real chat through, in place of the webview it cannot reach.
 *
 * Only there. The controller reads the person's transcripts and runs turns
 * with their credential, and any installed extension can read another's
 * exports, so a production or development host exports nothing.
 */
export interface MatterWaveApi {
  chat: ChatController;
  /** Every message posted to the chat view, including the streamed deltas. */
  onHostMessage(listener: (message: HostMessage) => void): vscode.Disposable;
}

/** The exports for a host in `mode`: the test seam under the test runner, nothing anywhere else. */
export function exportsFor(mode: vscode.ExtensionMode, api: MatterWaveApi): MatterWaveApi | undefined {
  return mode === vscode.ExtensionMode.Test ? api : undefined;
}

/**
 * Activated by the chat view or a command (VS Code reads both from the
 * manifest), never at start-up: installing the extension shows nothing
 * until it is used.
 */
export function activate(context: vscode.ExtensionContext): MatterWaveApi | undefined {
  // Request ids, status and timing of every request; never content.
  const log = vscode.window.createOutputChannel("MatterWave", { log: true });
  const tokens = new TokenStore(context.secrets, baseUrl);
  const statusBar = new StatusBar();
  const view = new ChatViewProvider(context.extensionUri, () => void promptForServer(context));
  // A window with no folder open has no workspace of its own to keep prompts for.
  const prompts = new PromptLibrary(context.globalState, vscode.workspace.workspaceFolders?.length ? context.workspaceState : null);
  // Snapshots are files in the extension's own storage, under one cap for every chat and workspace.
  const checkpoints = new CheckpointStore(context.globalState, snapshotFolder(vscode.Uri.joinPath(context.globalStorageUri, "checkpoints")));
  // Listening from the start, so @terminal has the commands that ran since.
  const terminals = new TerminalHistory();
  context.subscriptions.push(terminals);
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
    onRequest: (entry) => {
      const line = requestLogLine(entry);
      if (entry.status === null || entry.status >= 400) log.warn(line);
      else log.info(line);
    },
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
    // Where a notification's link leads when it is not a conversation of
    // this deployment; only http(s) URLs the classifier accepted get here.
    openLink: (url) => void vscode.env.openExternal(vscode.Uri.parse(url)),
    resolveMention: (mention) => resolveMention(mention, terminals),
    prompts: { get: (name) => prompts.get(name) },
    applyCode: async ({ block }) => {
      await applyCodeBlockFlow(chat, checkpoints, block);
    },
    onStatus: (status) => statusBar.update(status),
  });
  view.attach(chat);

  const command = (id: string, run: () => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, run));

  context.subscriptions.push(
    log,
    statusBar,
    registerApplyContentProvider(),
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

  // A sign-in goes to the server, so the first one settles which server that is.
  command("matterwave.signInWithDeviceCode", async () => {
    await promptForServer(context);
    await signInWithDeviceCode(client, tokens);
  });
  command("matterwave.signInWithApiKey", async () => {
    await promptForServer(context);
    await signInWithApiKey(client, tokens);
  });
  command("matterwave.openChat", () => view.reveal());
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider("*", new MatterWaveCodeActions(), {
      providedCodeActionKinds: MatterWaveCodeActions.providedCodeActionKinds,
    }),
    vscode.commands.registerCommand(CODE_ACTION_COMMANDS.fix, (uri, range, instruction) =>
      fixProblem(chat, checkpoints, uri, range, instruction),
    ),
    vscode.commands.registerCommand(CODE_ACTION_COMMANDS.explain, (uri, range) => askAboutCode(chat, view, EXPLAIN_QUESTION, uri, range)),
    vscode.commands.registerCommand(CODE_ACTION_COMMANDS.tests, (uri, range) => askAboutCode(chat, view, TESTS_QUESTION, uri, range)),
    vscode.commands.registerCommand(CODE_ACTION_COMMANDS.docs, async (uri, range) => {
      if (!(await requireTrust("Add Docs"))) return;
      const at = await codeAt(uri, range);
      if (at) await editLines(chat, checkpoints, at.document, at.range, DOCS_INSTRUCTION, "Add docs");
    }),
  );
  command("matterwave.explainTerminalCommand", () => terminalCommand("explain", terminals, chat, view));
  command("matterwave.fixTerminalCommand", () => terminalCommand("fix", terminals, chat, view));
  command("matterwave.showLog", () => log.show(true));
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
  command("matterwave.inlineEdit", () => inlineEdit(chat, checkpoints));
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
  command("matterwave.exportConversation", async () => {
    if (!chat.hasConversation()) {
      void vscode.window.showInformationMessage("Open a conversation to export it.");
      return;
    }
    const id = chat.activeConversationId();
    const title = chat.snapshot().conversations.find((c) => c.id === id)?.title ?? "";
    const target = await vscode.window.showSaveDialog({
      title: "Export conversation as Markdown",
      saveLabel: "Export",
      defaultUri: vscode.Uri.file(`${safeFilename(title)}.md`),
      filters: { Markdown: ["md"] },
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(conversationToMarkdown(chat.snapshot())));
    void vscode.window.showInformationMessage(`Conversation exported to ${target.path}.`);
  });
  command("matterwave.shareConversation", async () => {
    const id = chat.activeConversationId();
    if (!id) {
      void vscode.window.showInformationMessage("Open a conversation to share it.");
      return;
    }
    try {
      const share = await client.createShare(id);
      const url = `${client.baseUrl}${share.path}`;
      await vscode.env.clipboard.writeText(url);
      void vscode.window.showInformationMessage(`Share link copied to the clipboard: ${url}`);
    } catch (error) {
      void vscode.window.showErrorMessage(`The share link could not be created: ${describe(error)}`);
    }
  });
  command("matterwave.manageShares", () => manageShares(client));
  command("matterwave.organizeConversation", () => organizeConversation(client, chat));
  command("matterwave.manageTags", () => manageTags(client, chat));
  command("matterwave.customInstructions", () => editCustomInstructions(client));
  command("matterwave.manageApiKeys", () => manageApiKeys(client));
  command("matterwave.switchAccount", () => switchAccount(tokens));
  command("matterwave.promptLibrary", () => managePrompts(prompts));
  command("matterwave.restoreCheckpoint", () => restoreCheckpoint(chat, checkpoints));
  command("matterwave.importHistory", async () => {
    await view.reveal();
    await importHistory(client, chat);
  });

  void chat.refresh();

  return exportsFor(context.extensionMode, {
    chat,
    onHostMessage: (listener) => {
      taps.add(listener);
      return { dispose: () => void taps.delete(listener) };
    },
  });
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
        await rememberSignedIn(client, tokens, token.access_token, true);
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
    await rememberSignedIn(client, tokens, key.trim(), false, me);
    void vscode.window.showInformationMessage(`Signed in to MatterWave as ${me.name || me.email || me.subject}.`);
  } catch (error) {
    void vscode.window.showErrorMessage(`That key was not accepted: ${describe(error)}`);
  }
}

/**
 * Keep a just-verified credential under the account it acts for, so the
 * account switcher can name it later. The identity is learned with the key
 * itself; a `me` that cannot be read still keeps the key, listed as the
 * unnamed account.
 */
async function rememberSignedIn(
  client: MatterWaveClient,
  tokens: TokenStore,
  token: string,
  minted: boolean,
  me?: { subject: string; name: string | null; email: string | null },
): Promise<void> {
  let identity: { subject: string; label: string | null } | undefined;
  if (me) {
    identity = { subject: me.subject, label: me.name || me.email || null };
  } else {
    try {
      const probe = new MatterWaveClient({
        baseUrl: client.baseUrl,
        getToken: async () => token,
        fetch: createFetch(caFile),
      });
      const who = await probe.me();
      identity = { subject: who.subject, label: who.name || who.email || null };
    } catch {
      identity = undefined;
    }
  }
  await tokens.set(token, minted, identity);
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
    path: relativePath(document.uri),
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
  // The selection is sent as it is: code carries `@file` and `/x` as plain text.
  await chat.sendText(content);
}

async function askAboutFile(chat: ChatController, view: ChatViewProvider): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage("Open a file first.");
    return;
  }
  const question = await vscode.window.showInputBox({ title: "Ask about the file", value: "Explain this file." });
  if (!question) return;
  const path = relativePath(editor.document.uri);
  await view.reveal();
  // An image is sent as its own bytes for the vision-capable models; a text
  // file is sent extracted, as before.
  const contentType = imageContentType(path);
  if (contentType) {
    const bytes = await vscode.workspace.fs.readFile(editor.document.uri);
    await chat.sendAttachment(question, imageAttachment(bytes, path, contentType));
    return;
  }
  await chat.askAboutFile(question, editor.document.getText(), path);
}

/**
 * The code a lightbulb action (or its command, run from the palette) is
 * about: the document and range the action carried, else the active
 * editor's selection. Null, with a word, when there is none.
 */
async function codeAt(uri: unknown, range: unknown): Promise<{ document: vscode.TextDocument; range: vscode.Range } | null> {
  if (uri instanceof vscode.Uri && range instanceof vscode.Range) {
    return { document: await vscode.workspace.openTextDocument(uri), range };
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    void vscode.window.showInformationMessage("Select some code first.");
    return null;
  }
  return { document: editor.document, range: editor.selection };
}

/** A question about the code at hand, asked in the chat with the code fenced beside it. */
async function askAboutCode(chat: ChatController, view: ChatViewProvider, question: string, uri: unknown, range: unknown): Promise<void> {
  const at = await codeAt(uri, range);
  if (!at) return;
  const content = selectionContent({
    question,
    code: at.document.getText(at.range),
    languageId: at.document.languageId,
    path: relativePath(at.document.uri),
    startLine: at.range.start.line + 1,
    endLine: at.range.end.line + 1,
  });
  if (!fitsContentCap(content)) {
    void vscode.window.showWarningMessage(
      `The code is too long to send inline (over ${MAX_CONTENT_CHARS.toLocaleString()} characters). Select less of it.`,
    );
    return;
  }
  await view.reveal();
  await chat.sendText(content);
}

/**
 * Fix a problem the editor reports: the action carries the problem's range
 * and the instruction naming it; from the palette, the first problem the
 * selection (or the cursor's line) touches.
 */
async function fixProblem(chat: ChatController, checkpoints: CheckpointStore, uri: unknown, range: unknown, instruction: unknown): Promise<void> {
  if (!(await requireTrust("Fix with MatterWave"))) return;
  if (uri instanceof vscode.Uri && range instanceof vscode.Range && typeof instruction === "string") {
    await editLines(chat, checkpoints, await vscode.workspace.openTextDocument(uri), range, instruction, "Fix");
    return;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage("Open the file with the problem first.");
    return;
  }
  const at = editor.selection.isEmpty ? editor.document.lineAt(editor.selection.active.line).range : editor.selection;
  const problem = vscode.languages.getDiagnostics(editor.document.uri).find((d) => d.range.intersection(at) !== undefined);
  if (!problem) {
    void vscode.window.showInformationMessage("No problem is reported where the cursor is.");
    return;
  }
  await editLines(chat, checkpoints, editor.document, problem.range, fixInstruction(problem), "Fix");
}

/**
 * Explain or fix the last command of the active terminal, as shell
 * integration saw it run: the command, its output and its exit code go to
 * the chat. A fix's proposed command can be put on the terminal's prompt,
 * never run: the person reads it and presses Enter.
 */
async function terminalCommand(
  kind: "explain" | "fix",
  history: TerminalHistory,
  chat: ChatController,
  view: ChatViewProvider,
): Promise<void> {
  const terminal = vscode.window.activeTerminal;
  if (!terminal) {
    void vscode.window.showInformationMessage("Open a terminal and run a command first.");
    return;
  }
  const record = history.last(terminal);
  if (!record) {
    void vscode.window.showInformationMessage(
      `No command has run in “${terminal.name}” that MatterWave could see. Run it again in a shell with shell integration (bash, zsh, fish or PowerShell).`,
    );
    return;
  }
  await view.reveal();
  const prompt = terminalCommandPrompt(kind, terminal.name, record);
  if (kind === "explain") {
    await chat.sendText(prompt);
    return;
  }
  const answer = await chat.ask(prompt);
  const fixed = answer ? proposedCommand(answer) : null;
  if (!fixed) return;
  const put = await vscode.window.showInformationMessage(`Put the fixed command on the prompt of “${terminal.name}”?`, {
    detail: fixed,
  }, "Put on Prompt");
  if (put !== "Put on Prompt") return;
  terminal.show();
  // Without a newline: it waits on the prompt for the person to run it.
  terminal.sendText(fixed, false);
}

type PickItem = vscode.QuickPickItem & { row: PickerRow };

// --- prompt library -----------------------------------------------------------

/**
 * The named texts `/name` expands to in the composer: create one, edit one,
 * or take one back, looping like Manage Share Links so several can be seen
 * to in a sitting. The library is this editor's own -- not the platform's
 * -- with each prompt kept for every workspace or for this one alone, and
 * `/name` in a chat sends the saved text as the message.
 */
async function managePrompts(library: PromptLibrary): Promise<void> {
  for (;;) {
    const rows = await library.list();
    const workspaceNames = new Set(rows.filter((r) => r.scope === "workspace").map((r) => r.name));
    const picked = await vscode.window.showQuickPick(
      [
        {
          fresh: true,
          row: null as PromptRow | null,
          label: "$(plus) Create a prompt…",
          description: "",
          detail: "A named text that /name sends as a message from the chat composer",
        },
        ...rows.map((row) => ({
          fresh: false,
          row: row as PromptRow | null,
          label: `/${row.name}`,
          description: [
            row.scope === "workspace" ? "this workspace" : "every workspace",
            row.scope === "global" && workspaceNames.has(row.name) ? "hidden here by this workspace's" : null,
            `${row.text.length.toLocaleString()} characters`,
          ]
            .filter(Boolean)
            .join(" · "),
          detail: row.text.split("\n")[0],
        })),
      ],
      { title: "MatterWave prompt library", placeHolder: "Create a prompt, or pick one to edit or delete" },
    );
    if (!picked) return;
    if (picked.fresh) {
      await editPrompt(library, null);
      continue;
    }
    const action = await vscode.window.showQuickPick(
      [
        { id: "edit", label: "Edit", detail: `Change what /${picked.row?.name} sends` },
        { id: "delete", label: "Delete", detail: "Remove it from the library" },
      ],
      { title: `/${picked.row?.name}`, placeHolder: "What to do with this prompt" },
    );
    if (action?.id === "edit") {
      await editPrompt(library, picked.row);
    } else if (action?.id === "delete") {
      const answer = await vscode.window.showInformationMessage(
        `Delete the prompt “/${picked.row?.name}”? Nothing else holds it.`,
        { modal: true },
        "Delete",
      );
      if (answer === "Delete") {
        await library.remove(picked.row?.name ?? "", picked.row?.scope);
        void vscode.window.showInformationMessage(`The prompt “/${picked.row?.name}” was deleted.`);
      }
    }
  }
}

/** Name and text for one prompt, new or edited; a renamed edit saves a new row. */
async function editPrompt(library: PromptLibrary, existing: PromptRow | null): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: existing ? "Rename prompt" : "New prompt",
    prompt: "What the composer types: /name sends this prompt's text as a message.",
    value: existing ? `/${existing.name}` : "/",
    ignoreFocusOut: true,
    validateInput: (value) => {
      const normalized = normalizePromptName(value);
      if (!/^[a-z0-9_-]{1,40}$/.test(normalized)) return "Letters, digits, - and _ (at most 40).";
      return null;
    },
  });
  if (name === undefined) return;
  const normalized = normalizePromptName(name);
  const text = await vscode.window.showInputBox({
    title: `Text of /${normalized}`,
    prompt: "Sent as the message when /name is typed. Arguments after /name are appended on a new line.",
    value: existing?.text,
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim().length === 0
        ? "The prompt needs some text."
        : value.length > MAX_PROMPT_TEXT
          ? `At most ${MAX_PROMPT_TEXT.toLocaleString()} characters (now ${value.length.toLocaleString()}).`
          : null,
  });
  if (text === undefined) return;
  // An edit stays where it was kept; a new prompt is kept where the person says.
  let scope: PromptScope = existing?.scope ?? "global";
  if (!existing && library.hasWorkspace) {
    const where = await vscode.window.showQuickPick(
      [
        { scope: "global" as PromptScope, label: "Every workspace", detail: `/${normalized} works in every window` },
        { scope: "workspace" as PromptScope, label: "This workspace only", detail: `/${normalized} works only while this workspace is open` },
      ],
      { title: `Keep /${normalized} for…`, placeHolder: "Where the prompt is kept" },
    );
    if (!where) return;
    scope = where.scope;
  }
  if (await library.save(normalized, text, scope)) {
    void vscode.window.showInformationMessage(`Saved. Type /${normalized} in the composer to send it.`);
  } else {
    void vscode.window.showWarningMessage(
      `The prompt could not be saved: each scope holds at most ${MAX_PROMPTS} prompts of ${MAX_PROMPT_TEXT.toLocaleString()} characters each.`,
    );
  }
}

// --- inline edit (Ctrl+I) ---------------------------------------------------------

/**
 * Selection-scoped edit from the editor: one prompt over the selection, the
 * answer applied as a workspace edit on accept -- through the same reviewed
 * diff as Apply, with the lint hook reopening the file afterwards. The
 * extension never edits a file any other way.
 */
async function inlineEdit(chat: ChatController, checkpoints: CheckpointStore): Promise<void> {
  if (!(await requireTrust("Inline edit"))) return;
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    void vscode.window.showInformationMessage("Select the code to edit first.");
    return;
  }
  const { selection, document } = editor;
  const instruction = await vscode.window.showInputBox({
    title: "Edit selection with MatterWave",
    prompt: "What should change? A diff opens before anything is written.",
    placeHolder: "e.g. add error handling; make this async; extract a helper",
    ignoreFocusOut: true,
  });
  if (!instruction?.trim()) return;
  await editLines(chat, checkpoints, document, selection, instruction, "Inline edit");
}

/**
 * The lines `range` touches, rewritten as `instruction` asks: the model's
 * one block of code, fitted back over those lines and applied through the
 * reviewed diff, with a checkpoint named `label`. Inline edit and the
 * lightbulb's Fix and Add Docs all end here.
 */
async function editLines(
  chat: ChatController,
  checkpoints: CheckpointStore,
  document: vscode.TextDocument,
  range: vscode.Range,
  instruction: string,
  label: string,
): Promise<void> {
  // Whole lines, so the model sees (and answers with) each line's indentation.
  const { first, last } = selectedLines(range.start, range.end);
  const lines = new vscode.Range(
    new vscode.Position(first, 0),
    last + 1 < document.lineCount ? new vscode.Position(last + 1, 0) : document.lineAt(last).range.end,
  );
  const original = document.getText(lines);
  const path = relativePath(document.uri);
  const prompt = inlineEditPrompt({
    instruction,
    code: original,
    languageId: document.languageId,
    path,
    startLine: first + 1,
    endLine: last + 1,
  });
  const answer = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `MatterWave is editing ${path}…` },
    () => chat.ask(prompt),
  );
  const replacement = replacementFromAnswer(answer ?? "");
  if (replacement === null) {
    void vscode.window.showWarningMessage(
      answer?.trim()
        ? "The answer was not one block of code, so nothing was applied. Read it in the chat and apply what fits."
        : "MatterWave did not answer with a replacement, so nothing was applied.",
    );
    return;
  }
  // The document goes through the diff with the selected lines swapped for
  // the answer's, fitted to keep their line break and indentation; nothing
  // else in it is touched.
  const full = document.getText();
  const start = document.offsetAt(lines.start);
  const end = document.offsetAt(lines.end);
  await applyToFile(document.uri, full.slice(0, start) + fitReplacement(original, replacement) + full.slice(end), {
    title: `${path} — ${label.toLowerCase()}`,
    detail: "The selected lines become exactly the code on the right.",
    onSnapshot: (snapshot) => recordCheckpoint(chat, checkpoints, document.uri, snapshot, label),
  });
}

// --- applying code to a file -----------------------------------------------------

/**
 * The editor side of Apply: the file the block names, or one the person
 * picks; a missing file is offered as a new one, and the write itself only
 * happens through the reviewed diff in `applyToFile`. The extension never
 * edits a file any other way.
 */
async function applyCodeBlockFlow(chat: ChatController, checkpoints: CheckpointStore, block: CodeBlock): Promise<void> {
  if (!(await requireTrust("Apply"))) return;
  let picked: vscode.Uri | null = null;
  if (block.filename) {
    const named = await resolveNamedFile(block.filename, editorFolders());
    if (named.kind === "outside") {
      void vscode.window.showWarningMessage(
        `The answer names “${block.filename}”, which is not a path inside the workspace, so nothing was applied.`,
      );
      return;
    }
    if (named.kind === "none") {
      if (!vscode.workspace.workspaceFolders?.length) {
        void vscode.window.showInformationMessage("Open a workspace to apply code to a file.");
      }
      return;
    }
    picked = named.uri;
  } else {
    picked = await pickWorkspaceFile("Apply code — which file does this replace?");
    if (!picked) return;
  }
  const target = picked;
  if (!(await exists(target))) {
    const answer = await vscode.window.showInformationMessage(
      `${relativePath(target)} does not exist yet. Create it with this code?`,
      { modal: true, detail: `A diff opens before anything is written.\n\nCreates ${whereItLands(target)}` },
      "Create",
    );
    if (answer !== "Create") return;
  }
  await applyToFile(target, block.code, {
    title: `${relativePath(target)} — reviewed change`,
    onSnapshot: (snapshot) => recordCheckpoint(chat, checkpoints, target, snapshot, "Apply"),
  });
}

/**
 * The moment before a write: what the file was, kept as the chat's
 * checkpoint, restorable from Restore Checkpoint.
 */
async function recordCheckpoint(
  chat: ChatController,
  store: CheckpointStore,
  target: vscode.Uri,
  before: string | null,
  label: string,
): Promise<void> {
  const row = await store.record(chat.activeConversationId(), { uri: target.toString(), path: relativePath(target) }, before, label);
  if (row === null) {
    void vscode.window.showWarningMessage(
      `${relativePath(target)} is too large to snapshot, so this change has no checkpoint. VS Code's own undo still applies.`,
    );
  }
}

/**
 * The file a checkpoint was taken of: the URI it recorded -- folder, host
 * and all -- or, for one an older release kept by its relative path alone,
 * that path in the folder it belongs to.
 */
async function checkpointTarget(row: Checkpoint): Promise<vscode.Uri | null> {
  if (row.uri) return vscode.Uri.parse(row.uri);
  const named = await resolveNamedFile(row.path, editorFolders());
  if (named.kind === "file") return named.uri;
  if (named.kind === "outside") {
    void vscode.window.showWarningMessage(`${row.path} is not a path inside the workspace, so it cannot be restored.`);
  } else if (!vscode.workspace.workspaceFolders?.length) {
    void vscode.window.showInformationMessage("Open a workspace to restore a file into.");
  }
  return null;
}

/** Whether a file is there at all, before its document is opened. */
async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/**
 * The applied edits this chat can take back, newest first, each restored
 * through the same reviewed diff an apply goes through. A checkpoint of a
 * file that was new restores by removing the file, with its own confirm.
 */
async function restoreCheckpoint(chat: ChatController, store: CheckpointStore): Promise<void> {
  if (!(await requireTrust("Restore Checkpoint"))) return;
  const rows = await store.list(chat.activeConversationId());
  if (rows.length === 0) {
    void vscode.window.showInformationMessage(
      "No checkpoints yet. One is taken each time Apply or an inline edit writes a file.",
    );
    return;
  }
  const picked = await vscode.window.showQuickPick(
    rows.map((row) => ({
      row,
      label: row.path,
      description: row.label,
      detail: row.isNew
        ? `${new Date(row.createdAt).toLocaleString()} · the file was new`
        : `${new Date(row.createdAt).toLocaleString()} · ${row.size.toLocaleString()} characters`,
    })),
    { title: "MatterWave checkpoints", placeHolder: "Pick a checkpoint to restore" },
  );
  if (!picked) return;
  const uri = await checkpointTarget(picked.row);
  if (!uri) return;
  if (picked.row.isNew) {
    const answer = await vscode.window.showInformationMessage(
      `Remove ${picked.row.path}? It did not exist when this checkpoint was taken.`,
      { modal: true },
      "Remove",
    );
    if (answer !== "Remove") return;
    // Through the editor, like every change: an open buffer closes with it and Undo brings it back.
    const edit = new vscode.WorkspaceEdit();
    edit.deleteFile(uri, { ignoreIfNotExists: true });
    if (!(await vscode.workspace.applyEdit(edit))) {
      void vscode.window.showErrorMessage(`${picked.row.path} could not be removed.`);
      return;
    }
    void vscode.window.showInformationMessage(`${picked.row.path} was removed, back to before the ${picked.row.label}.`);
    return;
  }
  const answer = await vscode.window.showInformationMessage(
    `Restore ${picked.row.path} to what it was before the ${picked.row.label}?`,
    { modal: true, detail: "A diff opens before anything is written." },
    "Restore",
  );
  if (answer !== "Restore") return;
  const content = await store.content(picked.row.id);
  if (content === null) {
    void vscode.window.showWarningMessage(`The snapshot of ${picked.row.path} is gone from the extension's storage; nothing was restored.`);
    await store.remove(picked.row.id);
    return;
  }
  await applyToFile(uri, content, {
    title: `${picked.row.path} — restored checkpoint`,
    detail: "The file becomes exactly what the checkpoint kept.",
  });
}


// --- @-mention context providers -------------------------------------------------

/**
 * Assemble the context one @-mention in the composer names, one QuickPick
 * (or dialog) per kind: @file a file's contents, @folder a directory tree,
 * @terminal the output of a terminal, @git the working tree's diff or the
 * last commit's, @docs the text of a fetched page. Null is the person
 * backing out -- the message names context it is not going to get, so the
 * controller sends nothing.
 */
async function resolveMention(mention: Mention, history: TerminalHistory): Promise<{ filename: string; text: string } | null> {
  const title = mentionTitle(mention);
  switch (mention.kind) {
    case "file": {
      const picked = await pickWorkspaceFile(`${title} — ${mentionLabel("file")}`);
      if (!picked) return null;
      const bytes = await vscode.workspace.fs.readFile(picked);
      return fileContext(relativePath(picked), new TextDecoder().decode(bytes));
    }
    case "folder": {
      const picked = await vscode.window.showOpenDialog({
        title: `${title} — pick the folder whose tree is attached`,
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
      });
      const dir = picked?.[0];
      if (!dir) return null;
      const path = relativePath(dir);
      // The walk reads under the picked folder's own URI, so a path two
      // workspace folders share is never read from the wrong one.
      const tree = await folderTree(path, (at) => readDirUnder(dir, at === path ? "" : at.slice(path.length + 1)));
      return folderContext(path, tree);
    }
    case "terminal": {
      const terminals = vscode.window.terminals;
      if (terminals.length === 0) {
        void vscode.window.showInformationMessage("No terminal is open. Open one and run something to attach its output.");
        return null;
      }
      const picked = await vscode.window.showQuickPick(
        terminals.map((t) => {
          const last = history.last(t);
          return { terminal: t, label: t.name, description: last ? `last: ${last.command}` : undefined };
        }),
        { title: `${title} — pick the terminal whose output is attached`, placeHolder: "Its recent commands and their output" },
      );
      if (!picked) return null;
      const text = await terminalText(history, picked.terminal);
      if (text === null) {
        void vscode.window.showWarningMessage(`“${picked.terminal.name}” has no output to attach yet.`);
        return null;
      }
      return terminalContext(picked.terminal.name, text);
    }
    case "git": {
      if (!(await requireTrust("@git"))) return null;
      if (!vscode.workspace.workspaceFolders?.length) {
        void vscode.window.showInformationMessage("Open a workspace to attach its git changes.");
        return null;
      }
      const root = await currentFolder(editorFolders(), "@git — which folder's changes are attached?");
      if (!root) return null;
      const picked = await vscode.window.showQuickPick(
        [
          { range: "worktree" as const, label: "Working tree changes", detail: "git diff HEAD — staged and unstaged" },
          { range: "last" as const, label: "Last commit", detail: "git diff HEAD~1" },
        ],
        { title: `${title} — pick what is attached`, placeHolder: "The diff the model is shown" },
      );
      if (!picked) return null;
      const diff = await runGit(root.uri.fsPath, picked.range === "worktree" ? ["diff", "HEAD"] : ["diff", "HEAD~1"]);
      if (diff === null) {
        void vscode.window.showWarningMessage("git could not be run in this workspace, so its changes cannot be attached.");
        return null;
      }
      return gitContext(picked.label, diff);
    }
    case "docs": {
      const url = await vscode.window.showInputBox({
        title: `${title} — fetch a page`,
        prompt: "An http(s) URL whose text is attached for this message.",
        ignoreFocusOut: true,
        validateInput: (value) => (/^https?:\/\/\S+$/.test(value.trim()) ? null : "An http(s) URL"),
      });
      if (!url) return null;
      try {
        const { title, text } = await fetchDocText(url.trim(), (input, init) => fetch(input, init));
        return docsContext(url.trim(), title, text);
      } catch (error) {
        void vscode.window.showErrorMessage(`The page could not be fetched: ${describe(error)}`);
        return null;
      }
    }
  }
}

/** One workspace file, searched for as the person types, named by its workspace path. */
function pickWorkspaceFile(title: string): Promise<vscode.Uri | null> {
  return pickFile(title, relativePath);
}

/**
 * A workspace-relative path, so no home path leaks into a prompt. With
 * several folders open it leads with the folder's name, so two folders'
 * `src/a.ts` are never the same name.
 */
function relativePath(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, true);
}

/** The names in one directory under `root`, directories marked with a trailing `/`. */
async function readDirUnder(root: vscode.Uri, path: string): Promise<string[]> {
  const uri = path ? vscode.Uri.joinPath(root, ...path.split("/")) : root;
  const rows = await vscode.workspace.fs.readDirectory(uri);
  return rows.map(([name, type]) => (type & vscode.FileType.Directory ? `${name}/` : name));
}

/** One git invocation in the workspace root; null rather than a throw. */
async function runGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 15_000 });
    return stdout.trim() ? stdout : null;
  } catch {
    return null;
  }
}



/**
 * Every link this person is holding out, one place to take one back: pick a
 * share, confirm, and the list comes round again so several can be revoked
 * in a sitting. Revoked links are not offered -- a dead link needs no
 * managing -- and an empty list says where a link is made.
 */
async function manageShares(client: MatterWaveClient): Promise<void> {
  for (;;) {
    let shares;
    try {
      shares = (await client.myShares()).data;
    } catch (error) {
      void vscode.window.showErrorMessage(`The share links could not be loaded: ${describe(error)}`);
      return;
    }
    const live = shares.filter((share) => share.revoked_at === null);
    if (live.length === 0) {
      void vscode.window.showInformationMessage("No share links are out. Create one with MatterWave: Create Share Link.");
      return;
    }
    const picked = await vscode.window.showQuickPick(
      live.map((share) => ({
        share,
        label: share.title || share.conversation_id,
        description: `${share.status} · ${share.message_count} message${share.message_count === 1 ? "" : "s"} · ${share.view_count} view${share.view_count === 1 ? "" : "s"}`,
        detail: share.expires_at ? `Expires ${new Date(share.expires_at).toLocaleString()}` : "Never expires",
      })),
      { title: "MatterWave share links", placeHolder: "Pick a link to revoke" },
    );
    if (!picked) return;
    const answer = await vscode.window.showInformationMessage(
      `Revoke the share link to “${picked.label}”? Anyone holding it loses access at once.`,
      { modal: true },
      "Revoke",
    );
    if (answer !== "Revoke") continue;
    try {
      await client.revokeShare(picked.share.id);
      void vscode.window.showInformationMessage(`The share link to “${picked.label}” was revoked.`);
    } catch (error) {
      void vscode.window.showErrorMessage(`The share link could not be revoked: ${describe(error)}`);
    }
  }
}

/**
 * File a conversation in a folder and tag it, in three picks: the
 * conversation, the folder (making one on the spot), the tags (multi-select,
 * also making one on the spot). Nothing is kept on this side -- the API's
 * answers are the whole of the state -- so finishing means a refresh, and
 * the sidebar's badges say what took.
 */
async function organizeConversation(client: MatterWaveClient, chat: ChatController): Promise<void> {
  let conversations;
  let library;
  try {
    [conversations, library] = await Promise.all([client.allConversations(), client.listLibrary()]);
  } catch (error) {
    void vscode.window.showErrorMessage(`The library could not be loaded: ${describe(error)}`);
    return;
  }
  if (conversations.length === 0) {
    void vscode.window.showInformationMessage("No conversations to organize yet.");
    return;
  }
  const picked = await vscode.window.showQuickPick(
    conversations.map((c) => ({
      conversation: c,
      label: c.title || "Untitled",
      description: libraryBadge(c, library) ?? undefined,
    })),
    { title: "MatterWave: Organize", placeHolder: "Pick a conversation to file and tag", matchOnDescription: true },
  );
  if (!picked) return;
  const folder = await pickFolder(client, library, picked.conversation.folder_id);
  if (folder === undefined) return;
  const tagIds = await pickTags(client, library, picked.conversation.id);
  if (tagIds === undefined) return;
  try {
    await client.moveToFolder(picked.conversation.id, folder === null ? null : folder.id);
    await client.setTags(picked.conversation.id, tagIds);
  } catch (error) {
    void vscode.window.showErrorMessage(`“${picked.label}” could not be organized: ${describe(error)}`);
    return;
  }
  const where = folder === null ? "the main list" : `“${folder.name}”`;
  const tags = tagIds.length === 1 ? "1 tag" : `${tagIds.length} tags`;
  void vscode.window.showInformationMessage(`“${picked.label}” filed in ${where} with ${tags}.`);
  void chat.refresh();
}

/**
 * One folder out of the library, "main list" to unfile, or a new one made
 * here. `undefined` is the escape at any step: nothing chosen, nothing
 * changed.
 */
async function pickFolder(
  client: MatterWaveClient,
  library: Library,
  current: string | null,
): Promise<FolderRow | null | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      { folder: null as FolderRow | null, fresh: false, label: "No folder", description: "Back in the main list" },
      ...library.folders.map((f) => ({
        folder: f as FolderRow | null,
        fresh: false,
        label: f.name,
        description: f.id === current ? "Current" : undefined,
      })),
      { folder: null as FolderRow | null, fresh: true, label: "$(plus) New folder…" },
    ],
    { title: "MatterWave: Organize — folder", placeHolder: "File the conversation in…" },
  );
  if (!picked) return undefined;
  if (!picked.fresh) return picked.folder;
  const name = await vscode.window.showInputBox({
    title: "New folder",
    prompt: "The folder to file the conversation in. One by that name already is used.",
    ignoreFocusOut: true,
  });
  if (name === undefined || !name.trim()) return undefined;
  try {
    return await client.createFolder(name.trim());
  } catch (error) {
    void vscode.window.showErrorMessage(`The folder could not be created: ${describe(error)}`);
    return undefined;
  }
}

/**
 * The conversation's tags as one multi-select, with a "new tag" choice that
 * makes one and comes round again with it selected. Nothing picked clears
 * the tags; Escape at the picker leaves them alone.
 */
async function pickTags(client: MatterWaveClient, library: Library, conversationId: string): Promise<string[] | undefined> {
  const known = [...library.tags];
  const carried = new Set(library.assignments[conversationId] ?? []);
  for (;;) {
    const picked = await vscode.window.showQuickPick(
      [
        ...known.map((tag) => ({ tag: tag as TagRow | null, label: tag.name, picked: carried.has(tag.id) })),
        { tag: null as TagRow | null, label: "$(plus) New tag…" },
      ],
      {
        title: "MatterWave: Organize — tags",
        placeHolder: "The tags on this conversation; nothing picked clears them",
        canPickMany: true,
      },
    );
    if (!picked) return undefined;
    if (picked.every((p) => p.tag !== null)) return picked.map((p) => (p.tag as TagRow).id);
    const name = await vscode.window.showInputBox({
      title: "New tag",
      prompt: "A tag to add to the selection. One by that name already is used.",
      ignoreFocusOut: true,
    });
    if (name === undefined || !name.trim()) continue;
    try {
      const tag = await client.createTag(name.trim());
      known.push(tag);
      carried.add(tag.id);
    } catch (error) {
      void vscode.window.showErrorMessage(`The tag could not be created: ${describe(error)}`);
    }
  }
}

/**
 * Every tag this person has, one place to take one back: pick a tag,
 * confirm, and the list comes round again so several can go in a sitting.
 * The platform takes no rename for a tag, so deleting is the whole of the
 * management, and a delete takes the tag off every conversation carrying it.
 */
async function manageTags(client: MatterWaveClient, chat: ChatController): Promise<void> {
  for (;;) {
    let library;
    try {
      library = await client.listLibrary();
    } catch (error) {
      void vscode.window.showErrorMessage(`The tags could not be loaded: ${describe(error)}`);
      return;
    }
    if (library.tags.length === 0) {
      void vscode.window.showInformationMessage("No tags yet. Create one with MatterWave: Organize.");
      return;
    }
    const uses = (id: string) => Object.values(library.assignments).filter((ids) => ids.includes(id)).length;
    const picked = await vscode.window.showQuickPick(
      library.tags.map((tag) => {
        const n = uses(tag.id);
        return { tag, label: tag.name, description: n === 0 ? "unused" : `${n} conversation${n === 1 ? "" : "s"}` };
      }),
      { title: "MatterWave tags", placeHolder: "Pick a tag to delete" },
    );
    if (!picked) return;
    const n = uses(picked.tag.id);
    const answer = await vscode.window.showInformationMessage(
      n === 0
        ? `Delete the tag “${picked.label}”? No conversation carries it.`
        : `Delete the tag “${picked.label}”? It comes off ${n} conversation${n === 1 ? "" : "s"}.`,
      { modal: true },
      "Delete",
    );
    if (answer !== "Delete") continue;
    try {
      await client.deleteTag(picked.tag.id);
      void vscode.window.showInformationMessage(`The tag “${picked.label}” was deleted.`);
      void chat.refresh();
    } catch (error) {
      void vscode.window.showErrorMessage(`The tag could not be deleted: ${describe(error)}`);
    }
  }
}

async function pickModel(chat: ChatController): Promise<void> {  let models;
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

// --- custom instructions (account and org levels) ------------------------------

/** The API's per-field cap on the user's two instruction fields. */
const USER_FIELD_MAX_CHARS = 1500;
/** The API's cap on the org-level text. */
const ORG_MAX_CHARS = 4000;

/**
 * The instructions at their other two levels, one QuickPick away: the
 * person's about/style pair and the organisation's policy text, with the
 * plan gate read up front the way the web app's pane reads it -- a plan
 * without the feature says so before anything is typed, and the org level
 * names itself owner-or-admin because that is who the API answers.
 */
async function editCustomInstructions(client: MatterWaveClient): Promise<void> {
  let allowed = true;
  let planName = "Free";
  try {
    const entitlements = await client.entitlements();
    allowed = entitlements.limits.features?.custom_instructions !== false;
    planName = entitlements.plan_name;
  } catch {
    // A failed read is not a refusal: known up front when it can be, the
    // PUT decides when it cannot be.
  }
  if (!allowed) {
    void vscode.window.showInformationMessage(
      `Custom instructions are not included in the ${planName} plan. Upgrade the plan to use them.`,
    );
    return;
  }
  let mine;
  try {
    mine = await client.myInstructions();
  } catch (error) {
    void vscode.window.showErrorMessage(`Your instructions could not be loaded: ${describe(error)}`);
    return;
  }
  type Level = "about" | "style" | "org";
  const about = mine.about ?? "";
  const style = mine.style ?? "";
  const picked = await vscode.window.showQuickPick(
    [
      {
        level: "about" as Level,
        label: "About you",
        description: `${about.length}/${USER_FIELD_MAX_CHARS}`,
        detail: "Background the model assumes in every new conversation.",
      },
      {
        level: "style" as Level,
        label: "Response style",
        description: `${style.length}/${USER_FIELD_MAX_CHARS}`,
        detail: "Tone, length and format for new conversations.",
      },
      {
        level: "org" as Level,
        label: "Organisation instructions",
        description: "owner or admin",
        detail: "What every conversation in your organisation starts with.",
      },
    ],
    { title: "MatterWave custom instructions", placeHolder: "Pick a level to edit" },
  );
  if (!picked) return;
  if (picked.level === "org") return editOrgInstructions(client);
  const aboutLevel = picked.level === "about";
  const answer = await vscode.window.showInputBox({
    title: aboutLevel ? "What should MatterWave know about you?" : "How should MatterWave respond?",
    prompt: aboutLevel
      ? "Background it should assume in every new conversation."
      : "Tone, length and format for new conversations.",
    value: aboutLevel ? about : style,
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.length > USER_FIELD_MAX_CHARS
        ? `At most ${USER_FIELD_MAX_CHARS.toLocaleString()} characters (now ${value.length.toLocaleString()}).`
        : null,
  });
  if (answer === undefined) return;
  try {
    // The PUT replaces both fields, so both go as the account now holds them.
    const saved = await client.updateMyInstructions(
      aboutLevel ? { about: answer, style } : { about, style: answer },
    );
    void vscode.window.showInformationMessage(
      `Instructions saved. New conversations will use them (${(saved.about ?? "").length + (saved.style ?? "").length} characters).`,
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 402) {
      void vscode.window.showWarningMessage("Custom instructions are not part of your plan. Upgrade the plan to use them.");
    } else {
      void vscode.window.showErrorMessage(`The instructions could not be saved: ${describe(error)}`);
    }
  }
}

async function editOrgInstructions(client: MatterWaveClient): Promise<void> {
  let current;
  try {
    current = await client.orgInstructions();
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) {
      void vscode.window.showWarningMessage("Only an owner or admin of your organisation can read or set its instructions.");
    } else {
      void vscode.window.showErrorMessage(`The organisation instructions could not be loaded: ${describe(error)}`);
    }
    return;
  }
  const answer = await vscode.window.showInputBox({
    title: "Organisation instructions",
    prompt:
      "Policy every conversation in your organisation starts with. Members see it through their effective instructions; they cannot switch it off.",
    value: current.text,
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.length > ORG_MAX_CHARS
        ? `At most ${ORG_MAX_CHARS.toLocaleString()} characters (now ${value.length.toLocaleString()}).`
        : null,
  });
  if (answer === undefined) return;
  try {
    const saved = await client.setOrgInstructions(answer);
    void vscode.window.showInformationMessage(
      `Organisation instructions saved (${saved.text.length.toLocaleString()} characters).`,
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) {
      void vscode.window.showWarningMessage("Only an owner or admin of your organisation can set its instructions.");
    } else {
      void vscode.window.showErrorMessage(`The organisation instructions could not be saved: ${describe(error)}`);
    }
  }
}

// --- API key management --------------------------------------------------------

/**
 * The keys the credential in this editor may see, one place to make one,
 * rotate one, or take one back -- looping like Manage Share Links, so
 * several keys can be seen to in a sitting. Each row shows what the key may
 * do (its scopes) and what remains of its life; a key `key` rides in the
 * create and rotate answers and nowhere else, so it is copied to the
 * clipboard and named as gone the moment the dialog closes.
 */
async function manageApiKeys(client: MatterWaveClient): Promise<void> {
  for (;;) {
    let keys;
    try {
      keys = (await client.listKeys()).data;
    } catch (error) {
      void vscode.window.showErrorMessage(`The API keys could not be loaded: ${describe(error)}`);
      return;
    }
    const live = keys.filter((k) => k.revoked_at === null);
    const picked = await vscode.window.showQuickPick(
      [
        { key: null as ApiKeyListing | null, label: "Create a new key…", description: "", detail: "Mint a key for a script, a deploy or another editor" },
        ...live.map((k) => ({
          key: k as ApiKeyListing,
          label: k.name || k.prefix,
          description: k.prefix,
          detail: keyDetail(k),
        })),
      ],
      { title: "MatterWave API keys", placeHolder: "Create a key, or pick one to rotate or revoke" },
    );
    if (!picked) return;
    if (!picked.key) {
      await createKeyFlow(client);
      continue;
    }
    const action = await vscode.window.showQuickPick(
      [
        { id: "rotate", label: "Rotate", detail: "A new secret for the same key; the old one keeps working while the grace window is open" },
        { id: "revoke", label: "Revoke", detail: "The key stops working at once; this cannot be undone" },
      ],
      { title: `${picked.key.name || picked.key.prefix} (${picked.key.prefix})`, placeHolder: "What to do with this key" },
    );
    if (action?.id === "rotate") {
      const answer = await vscode.window.showInformationMessage(
        `Rotate “${picked.key.name || picked.key.prefix}”? A new secret replaces the old one after its grace window.`,
        { modal: true },
        "Rotate",
      );
      if (answer !== "Rotate") continue;
      try {
        const rotated = await client.rotateKey(picked.key.id);
        await vscode.env.clipboard.writeText(rotated.key);
        await secretCopiedNotice(`The new key for “${rotated.name || rotated.prefix}” was copied to the clipboard.`);
      } catch (error) {
        void vscode.window.showErrorMessage(`The key could not be rotated: ${describe(error)}`);
      }
    } else if (action?.id === "revoke") {
      const answer = await vscode.window.showInformationMessage(
        `Revoke “${picked.key.name || picked.key.prefix}”? Anything still holding it stops working at once.`,
        { modal: true },
        "Revoke",
      );
      if (answer !== "Revoke") continue;
      try {
        await client.revokeKeyById(picked.key.id);
        void vscode.window.showInformationMessage(`The key “${picked.key.name || picked.key.prefix}” was revoked.`);
      } catch (error) {
        void vscode.window.showErrorMessage(`The key could not be revoked: ${describe(error)}`);
      }
    }
  }
}

async function createKeyFlow(client: MatterWaveClient): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: "New MatterWave API key",
    prompt: "What the key is for, as the key list will show it.",
    value: "VS Code",
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? null : "A key must have a name."),
  });
  if (name === undefined) return;
  try {
    const created = await client.createKey(name.trim());
    await vscode.env.clipboard.writeText(created.key);
    await secretCopiedNotice(`The key “${created.name || created.prefix}” was copied to the clipboard.`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 402) {
      void vscode.window.showWarningMessage("API keys are not part of your plan, or the org is past its limit.");
    } else {
      void vscode.window.showErrorMessage(`The key could not be created: ${describe(error)}`);
    }
  }
}

/** The one moment a key's value is ever shown: pause on it having been copied, then it is gone. */
async function secretCopiedNotice(message: string): Promise<void> {
  await vscode.window.showInformationMessage(`${message} It is not shown again -- paste it wherever it is going.`, { modal: true });
}

// --- account switching ---------------------------------------------------------

/**
 * The accounts this editor keeps, the way the web app's menu shows the ones
 * its browser keeps: the acting account named, a pick swaps which kept key
 * is acting, and "add another" is an ordinary sign-in. Nothing leaves the
 * editor -- switching only moves the store's own pointer.
 */
async function switchAccount(tokens: TokenStore): Promise<void> {
  for (;;) {
    const accounts = await tokens.list();
    const picked = await vscode.window.showQuickPick(
      [
        ...accounts.map((account) => ({
          account,
          label: `${account.active ? "$(check) " : ""}${account.label || account.subject || "Unnamed account"}`,
          description: account.active ? "active" : account.minted ? "device login" : "pasted key",
          detail: account.active ? `Acting now (${account.subject})` : account.subject,
        })),
        { account: null, label: "Add another account…", description: "", detail: "Sign in; the account joins this list" },
      ],
      { title: "MatterWave accounts", placeHolder: "Pick an account to act as" },
    );
    if (!picked) return;
    if (!picked.account) {
      const how = await vscode.window.showQuickPick(
        [
          { id: "device", label: "Sign In (Device Code)", detail: "Confirm a code in the browser" },
          { id: "key", label: "Sign In with API Key", detail: "Paste an mw_ key" },
        ],
        { title: "Add an account", placeHolder: "How to sign in" },
      );
      if (!how) continue;
      await vscode.commands.executeCommand(how.id === "device" ? "matterwave.signInWithDeviceCode" : "matterwave.signInWithApiKey");
      continue;
    }
    if (picked.account.active) continue;
    if (!(await tokens.setActive(picked.account.subject))) {
      void vscode.window.showWarningMessage("That account is no longer kept in this editor.");
    }
    return;
  }
}

// --- history import --------------------------------------------------------------

/** The API's cap on an import's file, mirrored so the dialog refuses before the upload would. */
const IMPORT_MAX_BYTES = 100 * 1024 * 1024;

/**
 * Bring a ChatGPT or Claude export in: the file goes to the platform, which
 * parses it, queues the work, and reports progress on the same row; this
 * polls that row and says what landed. The conversations then arrive in the
 * sidebar like any others.
 */
async function importHistory(client: MatterWaveClient, chat: ChatController): Promise<void> {
  const target = await vscode.window.showOpenDialog({
    title: "Import a ChatGPT or Claude export",
    canSelectMany: false,
    openLabel: "Import",
    filters: { "Export file": ["json", "zip"] },
  });
  const file = target?.[0];
  if (!file) return;
  const filename = file.path.split("/").pop() ?? "export.json";
  const bytes = await vscode.workspace.fs.readFile(file);
  if (bytes.byteLength > IMPORT_MAX_BYTES) {
    void vscode.window.showWarningMessage(`That file is larger than the 100 MB limit.`);
    return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Importing conversations…", cancellable: true },
    async (_progress, cancel) => {
      try {
        let record = await client.startImport(new Blob([bytes as BlobPart], { type: "application/octet-stream" }), filename);
        // One row carries the progress: pending, then running, then done or failed.
        while ((record.status === "pending" || record.status === "running") && !cancel.isCancellationRequested) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          record = await client.importStatus(record.id);
        }
        if (cancel.isCancellationRequested) return;
        if (record.status === "failed") {
          void vscode.window.showErrorMessage(`The import failed: ${record.error ?? "no reason was given"}.`);
          return;
        }
        void vscode.window.showInformationMessage(summarizeImport(record));
        void chat.refresh();
      } catch (error) {
        void vscode.window.showErrorMessage(`The import could not be started: ${describe(error)}`);
      }
    },
  );
}

/** One line of what the import did, the web app's Data pane wording. */
function summarizeImport(record: ImportRecord): string {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts = [
    `${plural(record.conversations_created, "conversation", "conversations")} imported from ${record.source}`,
    `${plural(record.messages_created, "message", "messages")}`,
  ];
  if (record.conversations_existing > 0) parts.push(`${plural(record.conversations_existing, "copy", "copies")} already present, skipped`);
  if (record.conversations_skipped > 0) parts.push(`${plural(record.conversations_skipped, "conversation", "conversations")} skipped`);
  if (record.attachments_skipped > 0) parts.push(`${plural(record.attachments_skipped, "attachment", "attachments")} skipped`);
  return `${parts.join(", ")}.`;
}
