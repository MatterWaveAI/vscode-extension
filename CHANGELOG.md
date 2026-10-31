# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-10-30

### Added

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

- **De-vendoring the SDK**: `@matterwave/sdk` is still not published to npm (registry 404; the sibling `typescript-sdk` repo sits at 0.3.0 unpublished), so the vendored client at `src/lib/matterwaveClient.ts` stays. Swap it for the package when it is published.

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
