import * as vscode from "vscode";
import { MatterWaveClient } from "./api/client";
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
import { keyDetail } from "./keys";
import { conversationToMarkdown, safeFilename } from "./chat/export";
import type { ApiKeyListing, ImportRecord } from "./api/types";
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
    // Where a notification's link leads when it is not a conversation of
    // this deployment; only http(s) URLs the classifier accepted get here.
    openLink: (url) => void vscode.env.openExternal(vscode.Uri.parse(url)),
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
  command("matterwave.importHistory", async () => {
    await view.reveal();
    await importHistory(client, chat);
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

type PickItem = vscode.QuickPickItem & { row: PickerRow };

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
    [conversations, library] = await Promise.all([client.listConversations(), client.listLibrary()]);
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
