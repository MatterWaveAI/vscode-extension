# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- The extension's exports (the chat controller and its message tap) are given only to the extension test runner; a production host exports nothing, so no other installed extension can read transcripts or run turns with your credential.
- A file an answer names is applied only when it is a plain relative path that stays inside a workspace folder: `../`, absolute, drive-letter, UNC and URI paths are refused, and the Apply and Create dialogs show where the write lands.
- In Restricted Mode (an untrusted workspace) Apply, inline edit, Restore Checkpoint, Insert at Cursor, the lightbulb's Fix and Add Docs, commit messages and `@git` wait for the workspace to be trusted.

### Fixed

- Apply, inline edit and restore change the document through the editor (a `WorkspaceEdit` over the range that differs) instead of writing to disk: the change joins Undo, unsaved edits are kept and diffed against, the checkpoint records what the buffer held, and no save conflict follows. A document changed while the diff was open is not applied.
- Inline edit works on whole lines and keeps the selection's trailing line break and indentation; an answer with no fenced code is not applied.
- Multi-root and remote workspaces: a named file goes to the folder its path names, else the active editor's, else the only one, else a pick; `@git` and `@folder` act on the right folder; checkpoints keep the file's full URI; new files are created through the editor's file service, so a remote host is kept.
- The sidebar and the archive load every page of conversations (scroll to the end, or Load more), Organize lists them all, and the file picker searches the whole workspace as you type.
- `@terminal` reads a terminal's recent commands, output and exit codes through shell integration (or its copied buffer), each `@` mention is its own pick, and backing out of a pick leaves no empty conversation.
- A selection holding `@file` (a JSDoc tag) or starting with `/` is sent as it is, not read as a mention or a command.

### Added

- **Proxy support**: requests follow the editor's `http.proxy` (with credentials), `http.proxyStrictSSL` and the operating system's certificates, with `matterwave.caFile` trusted on top. The bundled HTTP client is gone and the extension is about 500 KB smaller.
- **Get started**: a walkthrough (sign in, ask, apply, inline edit), keybindings for Open Chat, New Chat and Ask about Selection (`Ctrl+Alt+M C/N/A`, `Ctrl+Cmd+M` on macOS), and a **MatterWave** log of every request's method, path, status, time and request id, never content (**Show Log**). The extension activates when it is used, and asks for the server on first use.
- **The lightbulb**: Fix with MatterWave for a reported problem, through a reviewed diff; Explain, Generate Tests and Add Docs for a selection.
- **The terminal**: Explain and Fix Last Terminal Command from the terminal's context menu.
- **Commit messages** from the staged changes, from the Source Control title bar, in the `matterwave.commitMessageStyle` style, written in a temporary conversation that leaves the chat untouched.
- **MCP**: MatterWave's MCP server is offered to VS Code's agent mode, as the signed-in account (VS Code 1.101 and later).
- **Conversations**: fork from any message, report an answer or a conversation, ranked and paged search over titles and messages, rename and delete folders (**Manage Folders**), and the deployment's announcements as dismissable banners.
- **Account**: your spending cap beside the allowance; key creation with scopes and a lifetime, and key rename; an **Account** command with plan, cap, moderation status, **Export my data** and **See plans**; uploads checked against the deployment's own limits before they are sent.
- **Composer**: Insert at Cursor and Copy on every code block, code coloured in the editor theme's colours, and completion for `@` and `/` (your saved prompts included).
- Tokens and cost at list price under each answer (`matterwave.showAnswerUsage`).
- The prompt library keeps prompts for every workspace or for this one, and Settings Sync carries it and your model choice to your other machines.
- Checkpoint snapshots are files in the extension's storage, under one cap for every chat (least recently used first), instead of the editor's state.
- The chat view is a labelled landmark for screen readers and says once when an answer finishes, instead of reading every streamed token.
- Commands, settings and the walkthrough in Spanish.
- `Cmd+I` for inline edit on macOS; `Ctrl/Cmd+I` yields to the editor's own inline chat when one is installed, and `Ctrl+Alt+M I` always works.
- The Marketplace icon, gallery banner, keywords and links; the `.vsix` ships the licence and this changelog.

### Changed

- The default server (`matterwave.baseUrl`) is `https://app.matterwave.ai`, the public deployment's address.

[Unreleased]: https://github.com/MatterWaveAI/vscode-extension/compare/v0.3.0...HEAD

## [0.3.0] - 2026-10-31

### Added

- **@-context providers**: `@file`, `@folder`, `@terminal`, `@git` and `@docs` in the composer pull context into the message -- a file's contents, a directory tree (vendored and build directories skipped), a terminal's output, the working tree's diff or the last commit's, or the text of a fetched page. Each resolves through its own pick, uploads as an attachment over the usual pipeline, and a mention backed out of sends nothing.
- **Slash commands and the prompt library**: `/model`, `/clear`, `/compact`, `/share` and `/export` run from the composer (`//` sends a literal slash), and `/name` sends a saved prompt as a message, arguments appended. Prompts are kept in the editor's global state and managed by a "Prompt Library" command -- create, edit, delete -- capped at 50 prompts of 10,000 characters.
- **Apply-to-file with a reviewed diff**: every code block in a finished answer gains an Apply button. The file it replaces comes from the block's info string (` ```python api/jobs.py ` and the `ts:src/a.ts` shorthand) or a pick; a diff of the file against the new code opens in a virtual document, and the write happens only on Apply, with the file reopened afterwards so its diagnostics refresh.
- **Inline edit (Ctrl+I)**: the selection, one prompt, and the answer applied as a workspace edit on accept -- through the same reviewed diff as Apply. An answer that is not one block of code is named as such and applied never; a cut answer is never applied at all.
- **Checkpoints**: the contents a file had before each Apply or inline edit are kept as the chat's checkpoint (20 newest per chat, files too large to snapshot faithfully refused), and "Restore Checkpoint" puts one back through the same reviewed diff -- a file that was new restores by removal, with its own confirm.
- **Organize**: a QuickPick flow that files a conversation in a folder (creating one on the spot) and tags it with a multi-select that can create a tag as it goes. Nothing is kept on this side -- the API is the state -- and finishing refreshes the sidebar.
- **Folder and tag badge**: sidebar rows and search hits carry a dim suffix naming the conversation's folder and tags, drawn from one library read per refresh; a deployment without the route simply goes unbadged.
- **Manage Tags**: every tag listed with the conversations carrying it, and a confirmed delete per tag -- the platform takes no rename for a tag, and a delete takes it off every conversation.
- **Inline image previews**: image attachments render in the transcript as pictures. The host fetches an attachment's bytes through the API and posts them to the webview as `data:` URIs (the webview itself has no network); only the types an `<img>` may show (png, jpeg, gif, webp) and only under a 5 MB cap, with anything else keeping its named-attachment chip. The webview's CSP `img-src` gains `data:` beside the extension's own resources.
- **Custom instructions at every level**: an "Edit Custom Instructions" command for the account's about/style text and the organisation's policy text (owner or admin), reading `/api/entitlements` first so a plan without the feature is named before anything is typed -- the extension-side mirror of the web app's Custom Instructions pane.
- **API key management**: a "Manage API Keys" command over the platform's key routes -- create (the value copied to the clipboard, shown nowhere else), rotate (old secret kept for its grace window), and revoke, with the list showing each key's scopes beside its prefix, creation, last use and expiry.
- **Clickable notification links**: a notification row that carries a link gets an Open action. A conversation link of the deployment (`/apps/chat?c=…`) opens right in the chat view; any other http(s) link opens in the browser; anything else is refused.
- **Notification pagination and the unread filter**: the bell's panel reads a first page (30 rows) and offers Load more, widening its window toward the API's 100-row cap -- a wider window replaces the rows, a short answer means that was everything, and a page that would not load keeps the panel as it was. An "Unread only" checkbox filters the panel server-side (`?unread=1`), reading from the top again either way; after mark-all-read the filtered panel re-reads to show the empty selection it now has.
- **Account switching**: several accounts kept side by side in the editor's secret storage, one acting. "Switch Account" lists them (the acting one marked), swaps which is acting, and offers an ordinary sign-in to add another. The active account shows in the chat view's meta line and the status bar tooltip.
- **History import**: an "Import ChatGPT or Claude History" command that sends an export file to `POST /api/me/imports`, polls the job row, and reports what landed (conversations created, messages, what was skipped), then refreshes the sidebar.

### Fixed

- Feedback rehydration is pinned by a regression test through the exact reload path (a replaced webview re-`ready`s, the controller re-reads the conversation's feedback rows and the thumbs come back).

### Deferred

- **De-vendoring the SDK**: `@matterwave/sdk` is not published to npm, so the vendored client at `src/lib/matterwaveClient.ts` stays until it is.

[0.3.0]: https://github.com/MatterWaveAI/vscode-extension/releases/tag/v0.3.0

## [0.2.1] - 2026-10-30

### Added

- **Sidebar management**: rename, pin, archive and delete conversations from the chat view, with full-text search over the caller's own messages and the archive folded away under its own heading.
- **Temporary chats**: a toggle before the first send creates a conversation that appears in no list or search, cannot be shared, and is deleted 24 hours after its last message.
- **Custom instructions**: a per-conversation instructions editor (with "use my instructions" to fall back), the effective layers shown as the model sees them, and a lit badge while text is in force.
- **Reply feedback**: thumbs on every reply over the full contract -- reasons and comment on a thumbs-down, re-votes replacing, and withdrawing with a second click -- rehydrated from the server on open.
- **Attachments and images**: files sent as uploads (with a notice when extraction cut the text) and images sent as their own bytes, with a refusal that names vision-capable models before anything is uploaded.
- **Export and share**: a conversation saved as Markdown in the web app's shape with a safe filename, and read-only share links copied to the clipboard.
- **Share management**: a "Manage Share Links" command listing every link still out, with a confirmed revoke per link.
- **Notifications**: the caller's notifications in a panel of the chat view, with unread counts badged on the status bar item, per-row mark-read, and mark-all-read.
- **Usage and budget**: the org's allowance as a line in the chat view (used of included, percent, warn / overage / exhausted) and in the status bar tooltip.

[0.2.1]: https://github.com/MatterWaveAI/vscode-extension/releases/tag/v0.2.1
