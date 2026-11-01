# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Agent mode**: an Agent toggle in the chat view runs the coding agent over `/v1/chat/completions` with the shared tool contract, agent contract 1.2.0 (`read_file`, `list_dir`, `glob`, `grep`, `edit`, `write_file`, `run_shell`), in the extension host, confined to the workspace root -- `..`, absolute paths elsewhere, links out of the root, names Windows reads as something else (`key.pem:x`, `a.`, `NUL.txt`, `\\?\` and network paths, refused on every platform) and the deny list (`.env*`, `*.pem`, `id_*`, `.git/`, any case, plus `.matterwaveignore`'s entries) are refused before anything happens, and searches skip what the `.gitignore` and `.matterwaveignore` files from the root down ignore. The root is the workspace folder (pick one when several are open).
- **The SDK's tools and wording**: the read tools, the search walk and its ignore rules, `run_shell`'s text, the approval decisions for the extension's own tools (by kind: `todo_write` and `task` are `meta`, `web_fetch` is `network`, MCP tools are `mcp`), the refusal sentences and the prompt's "More tools" and project-instructions slots are the vendored SDK's (`src/lib/sdk/agent`, `pnpm sdk:sync --sdk <dir> --ref <ref>`), so the model reads the same text here as in every other client; the contract's conformance cases run through the extension's own tools in the unit suite.
- **Approval modes**: `plan` (reads only), `ask` (the default: every change and command approved), `auto-edit` (changes applied, commands asked) and `yolo` (per session, after a confirm, never saved). The mode chip and the status bar always show it; Shift+Tab, the chip and `/approval-mode` change it.
- **Native diff review**: in `ask` every write opens VS Code's diff on an editable virtual document. Accept writes what the right side holds through a `WorkspaceEdit` (so Ctrl+Z undoes it), Reject leaves the file byte-identical, and the model is told either way, including when you edited its proposal.
- **Commands and Stop**: `run_shell` runs as a child process in the root with the contract's time limit and output cap (head and tail kept), its output streaming into the view. Stop ends the stream, a waiting approval, the command and every process it started, detached ones included: on Windows the shell runs in a Job Object (so `cmd /c start /b ...` and `Start-Process` children end with it, as they do when VS Code exits), on Linux in a new session and, where a systemd user manager runs, a transient scope (cgroup), on macOS in a new session with its descendants swept. A `timeout_s` outside 1-600 is refused rather than clamped.
- **Run limits**: a step cap and a per-run token cap end a looping run with a message naming the setting; a 402 or a spent budget (`insufficient_quota`) ends it with the chat's budget copy. Agent mode is greyed out with its reason in an untrusted workspace, for a model with `supports_tools: false`, or when `/api/me` says the org turned `local_agent_tools` off (the SDK's `toolsOf` and `localAgentToolsOf`: a missing field reads as allowed).
- **Context**: `MATTERWAVE.md`, `AGENTS.md`, a personal `MATTERWAVE.local.md` and `~/.matterwave/MATTERWAVE.md`, loaded only in a trusted folder (with a notice otherwise), each fenced in the prompt and cut at 32,768 characters, plus the account's custom instructions; `@path` mentions; the active file, selection and recent files, size-capped and never from a denied path.
- **Checkpoints and `/restore`**: every applied agent write is a checkpoint, and restoring one puts back every file it and the later ones changed, after one confirm, without touching the project's git.
- **Slash commands**: `/help`, `/approval-mode`, `/context`, `/restore`, `/init` (the agent drafts `MATTERWAVE.md`) and `/resume` (an earlier run with its tool rounds) join `/model`, `/compact`, `/clear`, `/share` and `/export`; custom commands are Markdown files in `~/.matterwave/commands` or `.matterwave/commands`.
- **Agent compaction**: old tool output is folded first, then older steps are summarised (the conversation's compaction when the run is stored, a `/v1` call otherwise); `/compact` does it on demand.
- **MCP client**: stdio and HTTP servers from `matterwave.agent.mcpServers`, each with a tool allow-list and optional trust, plus MatterWave's own `/mcp` signed in as the editor. Every MCP tool asks before each call in `ask` and `auto-edit`, read-only or not; `plan` offers only the read-only ones, and asks; `yolo` runs them. `"trust": true` is the person's standing approval: a trusted server's tools run without asking wherever they would ask.
- **Todo list, subagents, web fetch**: `todo_write` shows the run's plan in the view; subagents defined in `.matterwave/agents/*.md` run as nested loops with their own tool allow-list under the run's limits; `web_fetch` asks first outside yolo and is not offered in plan. A call the person rejects goes back to the model as the contract's `rejected` sentence, an ordinary result, with what they said after it.
- **Usage view**: this session's agent runs (steps, tool calls, tokens), the period's allowance and your spend from `/api/budget`.
- The chat stream's `compacting` frame: the view says the server is summarising earlier turns while the first token waits.

### Security

- MatterWave's credential goes to an MCP server only at exactly `<matterwave.baseUrl>/mcp`; a prefix match had let a look-alike host (`https://app.example.dev.evil.test/mcp`, `https://app.example.dev@evil.test/mcp`) named `matterwave` in a workspace's settings receive it.
- MCP servers a workspace's settings add start only after the person approves that exact definition (kept per workspace until it changes), and a workspace cannot mark its own servers `trust`. A server's read-only marks count only for a trusted server and MatterWave's own; plan mode leaves any other server's tools out.
- A change to `.vscode/`, `*.code-workspace`, `.matterwave/`, `MATTERWAVE.md`, `MATTERWAVE.local.md`, `AGENTS.md` or `.matterwaveignore`, or, for a root at or above the home folder, to `.bashrc`, `.bash_profile`, `.profile`, `.zshrc`, `.zprofile`, `.ssh/`, `.aws/` or a `.config/matterwave`, asks in every mode, `yolo` included, by its own name or where its links lead, so text the agent read cannot write itself into standing instructions, a shell start-up line or a server the editor starts. A workspace's settings can make the default mode stricter and the step and token caps lower, never the reverse.
- A change is written only if the file still holds what its diff was made from and its path still leads where it did; a file changed while the diff was open, or a folder swapped for a link, is left alone and the model told.
- A stricter mode picked during a run applies from the next tool call, including the rest of the step's calls; a looser one never runs a tool the step was not offered.
- `MATTERWAVE.md`, `AGENTS.md`, the workspace's commands and subagents and `@path` mentions are read through the tools' confinement and size cap, so a link to a file outside the root is refused, not put in the prompt.
- `run_shell` and MCP stdio servers start without VS Code's `ELECTRON_*` and `VSCODE_*` variables (`ELECTRON_RUN_AS_NODE`, the IPC handles) and without any `MATTERWAVE_*`/`MW_*` key or token.
- `grep` runs the model's pattern on the SDK's worker thread and gives up on a search past 60 s with the contract's `timeout`, so a catastrophically backtracking pattern cannot freeze the extension host; `glob` and `grep` yield to the editor as they walk, and Stop answers them at once.
- A pipe, socket or device (or a link to one) is never opened or waited on: every tool, `edit` and `write_file` included, answers `special_file`, and searches leave it out. The file an edit is made from is read no further than the read cap plus one byte.
- What an MCP server sends is capped (8 MB a message, 100 tools, 16,000-character schemas), and colliding tool names are made unique. `web_fetch` follows redirects only on the approved origin and reads at most 4 MB.
- The approval card writes out invisible characters (bidi overrides, zero-width and tag characters) in a command, URL or arguments, and the diff editor's Accept and Reject answer only a change under review.
- A file's byte-order mark is no longer read as text, so an edit no longer writes a second one.
- `/restore` resolves each checkpoint's path again and writes nothing through a folder that has since become a link out of the workspace.

### Changed

- The SDK's agent module (`@matterwave/sdk` `src/agent`, contract v1.0.0) is vendored byte for byte into `src/lib/sdk/agent` with a drift check (`pnpm sdk:check`, `test/sdkVendor.test.ts`).
- `pnpm run test:e2e` always runs the new agent suite (a scripted `/v1`, no deployment needed); the deployment suite still skips without its environment. CI runs the agent tool tests on Linux, Windows and macOS, and the agent e2e suite.

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
