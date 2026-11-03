# MatterWave for VS Code

Chat with your organisation's MatterWave models from the editor: the same conversations, models
and answers as the web app, with your code as context. Answers can change your files, but only
through a diff you review first, as an ordinary edit that **Undo** takes back. In chat, tool calls
run on the MatterWave API and show up here as collapsed blocks. Switch on **Agent** in the chat
view and the model can also read, search and change the workspace and run commands in it, on
your machine, with your approval for every change and every command (see
[Agent mode](#agent-mode)). Outside agent mode the extension runs nothing.

## Install

The extension is not on the Visual Studio Marketplace or Open VSX yet. Build the package and
install it:

```sh
pnpm install
pnpm run package          # writes matterwave-<version>.vsix
code --install-extension matterwave-<version>.vsix
```

Or, in VS Code: **Extensions** → **⋯** → **Install from VSIX…** and pick the file. CI keeps the
same file as the `vsix` artifact of every run, and each release attaches it to its GitHub
release with a CycloneDX SBOM of what it bundles.

Nothing runs until you use it: the extension activates when you open its view or run one of its
commands. **Get started with MatterWave** in the Welcome page walks through the first steps.

## Sign in

The first time you open the MatterWave view or sign in, it asks which deployment this editor is
for (the `matterwave.baseUrl` setting), prefilled; Escape keeps the default.

- **MatterWave: Sign In (Device Code)** opens the deployment's sign-in page in your browser with
  the code filled in. Confirm it there and the editor picks up the session. The extension never
  sees your password.
- **MatterWave: Sign In with API Key** takes an `mw_…` key from **Settings → API keys** in the
  web app. The key is checked against `/api/me` before it is kept.

Either credential goes into VS Code's secret storage (the OS keychain where there is one), one
slot per deployment, and several accounts can be kept side by side (**Switch Account**).
**Sign Out** clears it, and revokes a key the device flow minted on the server first (a pasted
key is yours and is only forgotten). The credential stays in the extension host, which makes
every request; the chat webview never receives it.

## In the chat view

Switch, search (titles and messages, ranked, paged as you scroll), rename, pin, archive, delete
and fork conversations; edit a message you sent, regenerate an answer, step through versions with
**‹ n / m ›**, continue an answer that was cut off, rate and report answers, and keep an eye on
the context meter and your organisation's allowance (and your own spending cap, when one
applies). Under each answer: the tokens it used and their cost at the model's list price
(`matterwave.showAnswerUsage` turns that off). The deployment's announcements show as banners.

In the composer:

- `@file`, `@folder`, `@workspace`, `@terminal`, `@git` and `@docs` attach context: a file, a folder's tree,
  relevant code snippets across the workspace, a terminal's recent commands with their output and exit codes, the working tree's or the last
  commit's diff, or a web page's text. Each mention is its own pick; typing `@` offers them.
- `/help`, `/model`, `/clear`, `/compact`, `/share`, `/export` and the agent's commands (see
  [Agent mode](#agent-mode)) run commands, and `/name` sends one of your saved prompts (**Prompt
  Library**: kept for every workspace or for this one); typing `/` offers them. `//` sends a
  message that starts with a slash.

Every code block of an answer has **Apply** (the file the block names, or one you pick, through a
reviewed diff), **Insert** (at the editor's cursor) and **Copy**, and is coloured in your theme's
colours. Every Apply, inline edit or agent write takes a checkpoint; **Restore Checkpoint** (or
`/restore`) puts the file back, together with any change made after it.

## In the editor

| Where | What |
|---|---|
| Selection → **Ask about Selection** (`Ctrl+Alt+M A`) | Your question with the selection, fenced with its language and workspace path. |
| **Edit Selection with MatterWave** (`Ctrl+I` / `Cmd+I` where no other inline chat has it, or `Ctrl+Alt+M I`) | Say what should change; the selected lines come back as a diff, indentation kept, applied on accept. |
| The lightbulb | **Fix with MatterWave** for a reported problem (through the same diff), and **Explain**, **Generate Tests** and **Add Docs** for a selection. |
| The terminal's context menu | **Explain** or **Fix Last Terminal Command**, from what shell integration saw: the command, its output and exit code. A fix can be put on the prompt, never run. |
| Source Control title bar ✨ | **Generate Commit Message** from the staged changes, in the style of `matterwave.commitMessageStyle`. |
| VS Code's agent mode | MatterWave's MCP tools, as the account signed in here (VS Code 1.101 and later). |

On macOS the `Ctrl+Alt+M` chords are `Ctrl+Cmd+M`. `Ctrl+Alt+M C` opens the chat and
`Ctrl+Alt+M N` starts a new one.

In a workspace you have not trusted (Restricted Mode), MatterWave chats and reads context but
changes no file and runs no git until you trust it.

## Commands

| Command | What it does |
|---|---|
| Open Chat, New Chat | Show the chat view; start a new conversation. |
| Sign In (Device Code), Sign In with API Key, Sign Out, Switch Account | The credential in this editor. |
| Ask about Selection, Ask about File | Ask with the selection inline, or the file as an attachment (images go as images to models that can see them). |
| Edit Selection with MatterWave, Fix Problem, Explain Code, Generate Tests, Add Docs | The editor actions above, also from the palette for the active selection. |
| Explain Last Terminal Command, Fix Last Terminal Command | The terminal actions above. |
| Generate Commit Message | The Source Control action above. |
| Pick Model, Choose Preset | The models your organisation allows, grouped (a model your plan does not include names the plan that has it, with **See Plans**); or one of your organisation's presets, which sets its model, instructions and welcome message for the conversation. |
| Compact Conversation Now | Summarise earlier turns to free context; **Show originals** brings them back into view. |
| Copy Last Request ID, Show Log | The reference to quote when you report a problem, and the request log (method, path, status, time, request id; never content). |
| Export Conversation as Markdown, Create Share Link, Manage Share Links | Save or share the open conversation; revoke links. |
| Organize, Manage Folders, Manage Tags | File and tag conversations; rename or delete folders; delete tags. |
| Report Conversation | Report the open conversation as unsafe or unhelpful, with a note. |
| Edit Custom Instructions | Your about/style text and, for an owner or admin, the organisation's. |
| Account | Your plan, allowance and cap, any moderation action that applies, **Export my data** and **See plans**. |
| Manage API Keys | Create (with scopes and a lifetime), rename, rotate and revoke keys. |
| Prompt Library | Your saved prompts, for every workspace or this one. |
| Restore Checkpoint | Put files back as they were before an Apply, an inline edit or an agent write; the changes after it go with it. |
| Import ChatGPT or Claude History | Bring an export file's conversations in. |
| Toggle Agent Mode, Set Agent Approval Mode, Cycle Agent Approval Mode, Pick the Agent's Root Folder | Agent mode on or off, its approval mode, and the folder it works in (see [Agent mode](#agent-mode)). |
| Accept the Agent's Change, Reject the Agent's Change | Answer the change under review; also the buttons on its diff editor. |
| Draft MATTERWAVE.md (/init), Resume an Agent Run | `/init` and `/resume` from the palette. |
| Show Usage | This session's agent runs, the period's allowance and your spend. |

## Agent mode

Tick **Agent** under the composer and what you type goes to the coding agent instead of the chat.
The agent works in one workspace folder (the root, named beside the toggle; with several folders
open, click it to pick another) through the shared MatterWave tool contract (agent contract
1.2.0): `read_file`, `list_dir`, `glob`, `grep`, `edit`, `write_file` and `run_shell`, which
return the same text here as in every other MatterWave client. The tools run here, in the
extension host; the server only relays the model's calls (`/v1/chat/completions`) and never sees
your files except what the tools return. A run is stored in the conversation
(`metadata.conversation_id`), so it shows in the web app too.

**Approval modes.** The chip next to the toggle shows the mode at all times (the status bar too);
click it or press **Shift+Tab** in the composer to cycle, or use `/approval-mode`.

| Mode | Reads and searches | File changes | Commands |
|---|---|---|---|
| `plan` | yes | not offered | not offered |
| `ask` (default) | yes | diff, you accept | you approve each |
| `auto-edit` | yes | applied | you approve each |
| `yolo` | yes | applied | run |

`yolo` is never a default and never saved: it asks for a confirm once per session.
`matterwave.agent.defaultMode` sets the mode for a new workspace; a workspace's own settings can
make it stricter, never looser. Picking a stricter mode during a run applies from the next tool
call, including the rest of the calls the model made in that step.

In every mode that changes files, `auto-edit` and `yolo` included, a change to what steers the
agent or the editor asks first: `.vscode/`, a `*.code-workspace` file, `.matterwave/`,
`MATTERWAVE.md`, `MATTERWAVE.local.md`, `AGENTS.md` and `.matterwaveignore`, and, for a root at or
above your home folder, `.bashrc`, `.bash_profile`, `.profile`, `.zshrc`, `.zprofile`, `.ssh/`,
`.aws/` and any `.config/matterwave`. Otherwise a file the agent read could turn itself into
standing instructions, a shell start-up line, or an MCP server the editor starts. The same goes
for a path that reaches one of them through a link.

**Reviewing a change.** In `ask` every `edit` and `write_file` opens VS Code's diff editor: the
file on the left, the proposal on the right. The proposal is editable: change it, then **Accept**
(the ✓ in the editor's title bar, or the card in the chat view) and what the right side holds is
written; **Reject** (✗) leaves the file byte-for-byte as it was, and the model is told. An applied
change goes through a `WorkspaceEdit` and is saved, so **Ctrl+Z** in that editor undoes it, and
each one is also a checkpoint for `/restore`. If the file changed while the diff was open (you
typed in it, a formatter ran), or a folder on its path became a link, nothing is written and the
model is told to read it again.

**Commands.** `run_shell` runs in the root (PowerShell on Windows, `sh` elsewhere) as a child
process with a time limit (120 s by default, 600 s at most) and a 64 KB output cap (its head and
tail are kept, the middle cut); the card shows the whole command before it runs, and its output
streams into the view and the "MatterWave Agent" output channel. **Stop** (or the time limit) ends
the model's stream, an approval that is waiting, the command, and every process it started,
including ones that detached from it:

- **Windows**: the shell puts itself in a Job Object before the command runs, so everything it
  starts, `cmd /c start /b` and `Start-Process` included, is in the job, and Windows ends the job
  whole on Stop or when VS Code exits. A process started through a service (Task Scheduler, WMI,
  an elevated `Start-Process -Verb RunAs`) is not the command's and is not reached. If PowerShell
  cannot make the job (ConstrainedLanguage mode), the tree is ended with `taskkill /T` as before.
- **Linux**: the shell leads a new session; where a systemd user manager runs, it also runs in a
  transient scope, a cgroup that forking or detaching does not leave, and Stop kills the cgroup.
  Without one, Stop reaches the session and every process still linked to the shell, but not a
  daemon that started a session of its own and lost its parent.
- **macOS**: a new session, and every process still linked to the shell by its parent; a daemon
  that detached is out of reach (macOS has no cgroups).

A command that ends on its own may leave a process running in the background, as in a terminal;
when the window closes, a command still running is ended too. The command's environment is VS
Code's minus its own plumbing (`ELECTRON_*`, `VSCODE_*`, as in the integrated terminal) and any
`MATTERWAVE_*` or `MW_*` key or token.

**Limits.** A run stops at `matterwave.agent.maxSteps` model calls (40) or
`matterwave.agent.maxTokens` tokens (500,000), and says which. A spent budget (402, or the API's
`insufficient_quota`) ends the run with the chat's budget message. When the history nears the
model's window, old tool output is folded to a stub first, and then older steps are summarised.

**What it may touch.** Every path is resolved and must stay under the root after links are
followed: `..`, an absolute path elsewhere and a link out of the root are refused before anything
happens, and so is a name Windows would read as something else (a `:` stream, a trailing dot or
space, `NUL`, `CON` and the other device names, a `\\?\` or network path), on every platform. A
deny list applies to reads too, so secrets are not sent: `.env*`, `*.pem`, `id_*`, `.git/`, in any
case, plus anything in a `.matterwaveignore` at the root (gitignore syntax). `glob`, `grep` and
`list_dir` also skip what the `.gitignore` and `.matterwaveignore` files from the root down ignore
(`!` re-includes, case ignored); `list_dir` still lists the protected files above, which can be
read. The project's notes, commands and subagents and `@path` mentions are
read through the same rules, so a `MATTERWAVE.md` that links to a key outside the root is refused,
not sent. A pipe, socket or device is never opened: every tool answers that it is not a file,
and searches leave it out. `glob` and `grep` let the editor keep working while they walk, and Stop
ends them at once. `grep` reads and matches on worker threads, never the editor's, and gives up
with the contract's `timeout` when the pattern has spent 30 s matching (a pattern that backtracks
without end) or the whole search has taken 120 s. This is confinement, not a sandbox: an approved command runs as you and can reach
anything you can. Everything the agent reads goes to MatterWave and to the model; the deny list is
a floor, not a guarantee.

**Off when it cannot run.** The toggle is greyed out, with the reason beside it, in an untrusted
workspace (the agent, `MATTERWAVE.md`, project commands, subagents and workspace MCP servers all
wait for trust), when the picked model cannot call tools, or when your organisation has turned
local agent tools off.

**Context.** In a trusted folder the agent reads `MATTERWAVE.md` (and `AGENTS.md`) at the root,
your personal `MATTERWAVE.local.md` beside them (keep it out of git), and `~/.matterwave/MATTERWAVE.md`,
plus your account's custom instructions. Each file goes into the prompt fenced, up to 32,768
characters, and where two disagree the later wins: yours for every project, then the project's,
then your personal one. `/init` has the agent draft a `MATTERWAVE.md` (the write
is reviewed like any other). `@src/app.ts` in a prompt attaches that file; the active file, the
selection (up to 8,000 characters) and the recently opened files ride along unless
`matterwave.agent.editorContext` is off, and none of them from a denied path. The `@file`,
`@folder`, `@terminal`, `@git` and `@docs` pickers work here too.

**Slash commands** in the composer: `/help`, `/model`, `/approval-mode [mode]`, `/compact`,
`/context`, `/restore`, `/init`, `/resume`, plus `/clear`, `/share` and `/export`. Your own
commands are Markdown files in `~/.matterwave/commands/` or the workspace's `.matterwave/commands/`:
`/review src/a.ts` sends `review.md` with `$ARGUMENTS` replaced (or appended). Prompt Library
prompts still work as `/name`.

**Restore and resume.** `/restore` lists the chat's checkpoints (Apply, inline edit and agent
writes); restoring one puts back every file it and the later ones changed -- one file through the
reviewed diff, several after one confirm that names them, as one edit Undo takes back -- and skips
a path that now leads out of the workspace through a link. Your project's own git is not
touched. `/resume` picks up an earlier agent run in this workspace with its
tool rounds in context.

**More tools.** `todo_write` keeps the run's plan as a checklist in the view. `web_fetch` reads a
page, asking first except in yolo and not offered in plan (`matterwave.agent.webFetch` turns it
off); it follows a redirect
only on the approved site, hands any other back to the model as a URL to fetch (which asks again),
and reads at most 4 MB. Subagents are Markdown
files in `~/.matterwave/agents/` or `.matterwave/agents/`, with a `description` and a `tools`
allow-list in front matter and their instructions as the body; the agent hands them jobs with
`task`, and their steps count against the run's limits.

**MCP servers.** `matterwave.agent.mcpServers` (user or workspace settings) adds servers by name:

```json
"matterwave.agent.mcpServers": {
  "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"], "tools": ["read_file", "list_directory"] },
  "tracker": { "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer ..." }, "trust": false }
}
```

Only the tools a server's `tools` allow-list names reach the model. Every MCP tool asks before
each call in `ask` and `auto-edit`, read-only or not, and runs unasked only in `yolo`; `plan`
offers only the tools marked read-only, and asks before those too. A read-only mark is the
server's own claim, so it counts only for a server you trust and for MatterWave's own `/mcp` (your
conversations and models), which is there by default (`matterwave.agent.matterwaveMcp`).
`"trust": true` in your user settings is your standing approval of a server: its tools run without
asking wherever they would ask, though `plan` still leaves out the ones not marked read-only. Your
MatterWave credential is sent only to a server at exactly `<matterwave.baseUrl>/mcp`; to trust
MatterWave's own, name it `matterwave` with that URL and `"trust": true`.

A server a workspace's settings add (`.vscode/settings.json`, a `.code-workspace` file) starts only
after you approve it, in a dialog that shows its command or URL; the answer is kept for that
workspace until the definition changes, and `trust` counts only in your user settings. What a
server sends is capped (8 MB a message, 100 tools, a 16,000-character schema each, 100,000
characters a result), and two tools whose names would collide get distinct ones.

**Usage.** **Usage** in the view (or **MatterWave: Show Usage**) lists this session's agent runs
with their steps, tool calls and tokens, the period's allowance, and your spend from the budget.
Each run's totals also show when it ends.

## Settings

| Setting | Default | |
|---|---|---|
| `matterwave.baseUrl` | `https://app.matterwave.ai` | The MatterWave deployment to use. |
| `matterwave.caFile` | empty | Path to a PEM file with the certificate authority that signed the deployment's TLS certificate, trusted on top of the system's. For a deployment behind a private CA; `~/` is expanded. |
| `matterwave.commitMessageStyle` | empty | How commit messages are written; a workspace can set its own. |
| `matterwave.showAnswerUsage` | on | Tokens and cost under each answer. |
| `matterwave.agent.defaultMode` | `ask` | The agent's approval mode in a new workspace: `plan`, `ask` or `auto-edit`. A workspace's settings can only make it stricter. |
| `matterwave.agent.engine` | `auto` | Agent execution engine: `auto` uses Pi 1.0 (`pi --mode rpc`) when installed and falls back to the built-in loop, `pi` requires Pi 1.0, and `builtin` always uses the built-in loop. |
| `matterwave.agent.piBinaryPath` | `pi` | Path or command name for the Pi 1.0 coding agent binary (used with `--mode rpc`). |
| `matterwave.agent.maxSteps` | `40` | Model calls per agent run. A workspace's settings can only lower it. |
| `matterwave.agent.maxTokens` | `500000` | Tokens per agent run, every step counted. A workspace's settings can only lower it. |
| `matterwave.agent.editorContext` | `true` | Send the active file, the selection and recent files with agent prompts. |
| `matterwave.agent.webFetch` | `true` | Offer `web_fetch` (always behind approval outside yolo). |
| `matterwave.agent.matterwaveMcp` | `true` | Offer MatterWave's own `/mcp` tools. |
| `matterwave.agent.mcpServers` | `{}` | MCP servers by name (see above); workspace values need a trusted folder and your approval per server. |

Models, limits and policy come from the server. Behind a proxy, MatterWave uses the editor's own
network settings (`http.proxy`, with credentials, and `http.proxyStrictSSL`) and the operating
system's certificates, with or without `matterwave.caFile`.

If the server's certificate is signed by an authority the editor does not know, every request
fails with **The server's certificate is not trusted; set matterwave.caFile ...**, in the chat
view and on the sign-in commands. Point `matterwave.caFile` at that authority's PEM file and
retry; the change applies to the next request.

Its commands, settings and walkthrough are in English and Spanish, following VS Code's display
language; the chat itself is in English.

## Development

```sh
pnpm install
pnpm run lint && pnpm run typecheck && pnpm test && pnpm run build
```

The unit tests run in vitest against a mocked `vscode` module (`test/vscode-mock.ts`), so they do
not need a VS Code download.

`pnpm run test:e2e` runs the built extension inside a real VS Code (downloaded once into
`.vscode-test/` by `@vscode/test-electron`, about 1 GB unpacked; under `xvfb-run` on Linux, as CI
runs it). It has three suites:

- The **editor suite** always runs and needs no deployment. It opens a two-folder workspace made
  for the run and checks what the mock cannot show: edits through the editor's buffer and undo,
  multi-root paths, file search past any fixed count, terminals through shell integration, the
  lightbulb, the Git extension, the MCP definition, and requests through an authenticating proxy
  to a server behind a throwaway private CA (made with `openssl`; skipped, with a message, when
  there is none).
- The **agent suite** always runs too: a scratch folder is the workspace, and the suite serves a
  scripted fake `/v1` from inside the extension host, so it needs no deployment. It checks that a
  rejected diff leaves the file byte-identical, that an accepted change undoes with Ctrl+Z, that
  an edited proposal writes your version, and that Stop ends a command and a process it detached
  (`cmd /c start /b` on Windows) within 2 s.
- The **deployment suite** signs in as the standing e2e account (`E2E_ADMIN_EMAIL` /
  `E2E_ADMIN_PASSWORD`), approves a device login to mint a key for the run, signs the extension in
  with it, opens the model picker and streams one real answer through the extension's test exports
  (`MatterWaveApi` in `src/extension.ts`, exported only under the test runner); the key is revoked
  afterwards. `E2E_BASE_URL` points it at a deployment, `E2E_CA_FILE` names its CA when it is a
  private one, and `E2E_MODEL` (default `grt-nano`) the model. Without the account or the URL it is
  skipped, not failed. Against an API started with `MW_AUTH_MODE=none`, `E2E_AUTH=none` skips the
  sign-in.

With `E2E_VSIX=<file>` (after `pnpm run package`) the agent suite runs the packaged extension
instead, installed into the test editor, so the .vsix is what is tested.

`pnpm run icon` regenerates `media/icon.png` from the activity-bar glyph. `pre-commit install`
turns on the gitleaks hook CI also runs.

The MatterWave SDK is vendored at `src/lib/matterwaveClient.ts` (trimmed from version 0.1.0 of
[MatterWaveAI/typescript-sdk](https://github.com/MatterWaveAI/typescript-sdk), released under MIT):
the package is not published to npm, so the extension carries the client it needs. The agent's
tool contract and helpers (generated from the Python SDK's `contract.json`, with confinement, the
deny list, edit, diff and the modes) are the SDK's `src/agent`, copied byte for byte into
`src/lib/sdk/agent` and bundled into the .vsix: confinement, the deny list and the search rules,
the read tools and their output, the approval decisions, the refusals and the system prompt. `pnpm
sdk:sync` re-copies every `src/agent/*.ts` from a `typescript-sdk` checkout or worktree (`--sdk
<dir>` or `MATTERWAVE_SDK_DIR`, by default one beside this repository) at a git ref (`--ref` or
`MATTERWAVE_SDK_REF`, default `develop`) and records it in `src/lib/sdk/VENDORED.json`; `pnpm
sdk:check` compares the copy with the ref it was taken from. The copy is agent contract 1.2.0,
commit `cce162b` of the SDK's `agent-contract-1.1`, pinned by commit so the branch moving on is not
drift (`pnpm sdk:sync --sdk <checkout> --ref cce162b`).
`test/sdkVendor.test.ts` fails on a hand edit of the copy, and `test/agent/conformance.test.ts`
runs the contract's conformance cases through the extension's own tools. Without a connection the
composer is disabled and the draft is kept; **Reconnect** in the view tries the API again.

## Licence

Apache License 2.0: see [LICENSE](LICENSE) and [NOTICE](NOTICE).
