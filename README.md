# MatterWave for VS Code

Chat with your organisation's MatterWave models from the editor: the same conversations, models
and answers as the web app, with a selection or a file as context. Switch on **Agent** in the
chat view and the model can also read, search and change the workspace and run commands in it,
on your machine, with your approval for every change and every command (see
[Agent mode](#agent-mode)). Outside agent mode the extension never edits a file except through
a diff you accept, and runs nothing.

## Install from a .vsix

The extension is not on the Marketplace yet. Build the package and install it:

```sh
cd clients/vscode
pnpm install
pnpm run package          # writes matterwave-<version>.vsix
code --install-extension matterwave-<version>.vsix
```

Or, in VS Code: **Extensions** → **⋯** → **Install from VSIX…** and pick `matterwave-<version>.vsix`.
CI keeps the same file as its `matterwave-vscode-<sha>` artifact.

## Sign in

Open the MatterWave view in the activity bar, or run one of these commands:

- **MatterWave: Sign In (Device Code)**: opens the MatterWave sign-in page in your browser with
  the code filled in. Confirm it there and the editor picks up the session. The extension never
  sees your password.
- **MatterWave: Sign In with API Key**: paste an `mw_…` key from **Settings → API keys** in the
  web app. The key is checked against `/api/me` before it is kept.

Either credential goes into VS Code's secret storage (the OS keychain where there is one). Each
deployment (`matterwave.baseUrl`) gets its own slot. **MatterWave: Sign Out** clears it, and
revokes a key the device flow minted on the server first (a pasted key is yours and is only
forgotten). The credential stays in the extension host, which makes every request. The chat
webview never receives it.

## Commands

| Command | What it does |
|---|---|
| MatterWave: New Chat | Starts a new conversation (also the **+** in the view title). |
| MatterWave: Ask about Selection | Sends your question with the selection inline, fenced with the language id and the workspace path. Also on the editor's context menu. |
| MatterWave: Ask about File | Uploads the current file as a `text/plain` attachment named by its workspace path, then asks about it. If the file is longer than the model reads, the view says only its start was sent. |
| MatterWave: Pick Model | Lists the models your organisation allows, grouped as GRT models, partner models and research previews. A model your plan does not include is listed with the plan that has it, and you cannot pick it. |
| MatterWave: Compact Conversation Now | Summarises the earlier turns to free context. The transcript shows a divider, and **Show originals** brings the folded turns back into view. |
| MatterWave: Copy Last Request ID | Copies the reference of the last request. Quote it when you report a problem. |

In the chat view you can switch conversations, edit a message you sent, regenerate an answer,
step through versions with **‹ n / m ›**, continue an answer that was cut off, and watch the
context meter. The status bar shows the model, how much of the context is used, who you are
signed in as, and whether MatterWave can be reached.

## Agent mode

Tick **Agent** under the composer and what you type goes to the coding agent instead of the chat.
The agent works in one workspace folder (the root, named beside the toggle; with several folders
open, click it to pick another) through the shared MatterWave tool contract (agent contract
1.1.0): `read_file`, `list_dir`, `glob`, `grep`, `edit`, `write_file` and `run_shell`, which
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
tail are kept, the middle cut); the card shows
the whole command before it runs, and its output streams into the view and the "MatterWave Agent"
output channel. **Stop** ends the model's stream, an approval that is waiting, and the command's
whole process tree. A process that detaches itself from that tree (`cmd /c start /b ...` on
Windows, `setsid` or a daemon elsewhere) can outlive Stop, as can one a finished command left
running in the background. The command's environment is VS Code's minus its own plumbing
(`ELECTRON_*`, `VSCODE_*`, as in the integrated terminal) and any `MATTERWAVE_*` or `MW_*` key or
token.

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
not sent. `grep` runs the model's pattern off the editor's thread and gives up on one that takes
more than 5 s. This is confinement, not a sandbox: an approved command runs as you and can reach
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
writes); restoring one puts back every file it and the later ones changed, after one confirm, and
skips a path that now leads out of the workspace through a link. Your project's own git is not
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
| `matterwave.baseUrl` | `https://app.matterwave.dev` | The MatterWave deployment to use. |
| `matterwave.caFile` | empty | Path to a PEM file with the certificate authority that signed the deployment's TLS certificate, trusted beside the system's. For a deployment behind a private CA; `~/` is expanded. |
| `matterwave.agent.defaultMode` | `ask` | The agent's approval mode in a new workspace: `plan`, `ask` or `auto-edit`. A workspace's settings can only make it stricter. |
| `matterwave.agent.maxSteps` | `40` | Model calls per agent run. A workspace's settings can only lower it. |
| `matterwave.agent.maxTokens` | `500000` | Tokens per agent run, every step counted. A workspace's settings can only lower it. |
| `matterwave.agent.editorContext` | `true` | Send the active file, the selection and recent files with agent prompts. |
| `matterwave.agent.webFetch` | `true` | Offer `web_fetch` (always behind approval outside yolo). |
| `matterwave.agent.matterwaveMcp` | `true` | Offer MatterWave's own `/mcp` tools. |
| `matterwave.agent.mcpServers` | `{}` | MCP servers by name (see above); workspace values need a trusted folder and your approval per server. |

Models, limits and policy come from the server.

The first time the extension starts with the default `baseUrl` it asks for the server URL,
prefilled; the answer is kept as the user setting. Escape keeps the default, and it does not ask
again.

If the server's certificate is signed by an authority the editor does not know, every request
fails with **The server's certificate is not trusted; set matterwave.caFile ...**, in the chat
view and on the sign-in commands. Point `matterwave.caFile` at that authority's PEM file and retry;
the change applies to the next request.

## Development

```sh
pnpm install
pnpm run lint && pnpm run typecheck && pnpm run build && pnpm test
```

The unit tests run in vitest against a mocked `vscode` module (`test/vscode-mock.ts`), so they
do not need a VS Code download.

`pnpm run test:e2e` is the other kind of test: the built extension inside a real VS Code
(downloaded once into `.vscode-test/` by `@vscode/test-electron`, about 1 GB unpacked). It runs
two suites. The agent suite always runs: a scratch folder is the workspace, and the suite serves a
scripted fake `/v1` from inside the extension host, so it needs no deployment. It checks that a
rejected diff leaves the file byte-identical, that an accepted change undoes with Ctrl+Z, and that
an edited proposal writes your version. The deployment suite runs against a real deployment.
`e2e/run.mjs` signs in as the standing e2e account (`E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD`;
without them the run is skipped), approves a device login as that account to mint a device key
for the run (which works on every plan), and the suite in `e2e/suite` signs the extension in
with it, opens the model picker and streams one real answer through the extension's exports
(`MatterWaveApi` in `src/extension.ts`); the key is revoked afterwards. `E2E_BASE_URL` (required;
without it the run is skipped), `E2E_CA_FILE` (the deployment's CA, when it is a private one;
the system's authorities otherwise) and `E2E_MODEL` (default `grt-nano`) point it at a
deployment. Against an API started on this machine
with `MW_AUTH_MODE=none`, `E2E_AUTH=none` skips the sign-in and the dev principal approves the
code; `E2E_MODEL` names whatever that API serves.

The MatterWave SDK is vendored at `src/lib/matterwaveClient.ts` (trimmed from
[MatterWaveAI/typescript-sdk](https://github.com/MatterWaveAI/typescript-sdk), MIT): the package
is not published to npm, so the extension carries the client it needs. The agent's tool contract
and helpers (generated from the Python SDK's `contract.json`, with confinement, the deny list,
edit, diff and the modes) are the SDK's `src/agent`, copied byte for byte into `src/lib/sdk/agent`
and bundled into the .vsix: confinement, the deny list and the search rules, the read tools and
their output, the approval decisions, the refusals and the system prompt. `pnpm sdk:sync`
re-copies every `src/agent/*.ts` from a `typescript-sdk` checkout or worktree (`--sdk <dir>` or
`MATTERWAVE_SDK_DIR`, by default one beside this repository) at a git ref (`--ref` or
`MATTERWAVE_SDK_REF`, default `develop`) and records it in `src/lib/sdk/VENDORED.json`; `pnpm
sdk:check` compares the copy with the ref it was taken from. The copy is agent contract 1.1.0,
from the SDK's `agent-contract-1.1` (`pnpm sdk:sync --sdk <checkout> --ref agent-contract-1.1`).
`test/sdkVendor.test.ts` fails on a hand edit of the copy, and
`test/agent/conformance.test.ts` runs the contract's conformance cases through the extension's own
tools. Without a connection the
composer is disabled and the draft is kept; **Reconnect** in the view tries the API again.
