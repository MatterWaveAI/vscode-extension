# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
