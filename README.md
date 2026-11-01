# MatterWave for VS Code

Chat with your organisation's MatterWave models from the editor: the same conversations, models
and answers as the web app, with your code as context. Answers can change your files, but only
through a diff you review first, as an ordinary edit that **Undo** takes back. Tool calls run on
the MatterWave API and show up here as collapsed blocks.

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

- `@file`, `@folder`, `@terminal`, `@git` and `@docs` attach context: a file, a folder's tree,
  a terminal's recent commands with their output and exit codes, the working tree's or the last
  commit's diff, or a web page's text. Each mention is its own pick; typing `@` offers them.
- `/model`, `/clear`, `/compact`, `/share` and `/export` run commands, and `/name` sends one of
  your saved prompts (**Prompt Library**: kept for every workspace or for this one); typing `/`
  offers them. `//` sends a message that starts with a slash.

Every code block of an answer has **Apply** (the file the block names, or one you pick, through a
reviewed diff), **Insert** (at the editor's cursor) and **Copy**, and is coloured in your theme's
colours. Every Apply or inline edit takes a checkpoint; **Restore Checkpoint** puts the file back.

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
| Restore Checkpoint | Put a file back as it was before an Apply or an inline edit. |
| Import ChatGPT or Claude History | Bring an export file's conversations in. |

## Settings

| Setting | Default | |
|---|---|---|
| `matterwave.baseUrl` | `https://app.matterwave.ai` | The MatterWave deployment to use. |
| `matterwave.caFile` | empty | Path to a PEM file with the certificate authority that signed the deployment's TLS certificate, trusted on top of the system's. For a deployment behind a private CA; `~/` is expanded. |
| `matterwave.commitMessageStyle` | empty | How commit messages are written; a workspace can set its own. |
| `matterwave.showAnswerUsage` | on | Tokens and cost under each answer. |

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
`.vscode-test/` by `@vscode/test-electron`; under `xvfb-run` on Linux, as CI runs it). It has two
suites:

- The **editor suite** always runs and needs no deployment. It opens a two-folder workspace made
  for the run and checks what the mock cannot show: edits through the editor's buffer and undo,
  multi-root paths, file search past any fixed count, terminals through shell integration, the
  lightbulb, the Git extension, the MCP definition, and requests through an authenticating proxy
  to a server behind a throwaway private CA (made with `openssl`; skipped, with a message, when
  there is none).
- The **deployment suite** signs in as the standing e2e account (`E2E_ADMIN_EMAIL` /
  `E2E_ADMIN_PASSWORD`), approves a device login to mint a key for the run, signs the extension in
  with it, opens the model picker and streams one real answer through the extension's test exports
  (`MatterWaveApi` in `src/extension.ts`, exported only under the test runner); the key is revoked
  afterwards. `E2E_BASE_URL` points it at a deployment, `E2E_CA_FILE` names its CA when it is a
  private one, and `E2E_MODEL` (default `grt-nano`) the model. Without the account or the URL it is
  skipped, not failed. Against an API started with `MW_AUTH_MODE=none`, `E2E_AUTH=none` skips the
  sign-in.

`pnpm run icon` regenerates `media/icon.png` from the activity-bar glyph. `pre-commit install`
turns on the gitleaks hook CI also runs.

The MatterWave SDK is vendored at `src/lib/matterwaveClient.ts` (trimmed from version 0.1.0 of
[MatterWaveAI/typescript-sdk](https://github.com/MatterWaveAI/typescript-sdk), released under MIT):
the package is not published to npm, so the extension carries the client it needs. Without a
connection the composer is disabled and the draft is kept; **Reconnect** in the view tries the API
again.

## Licence

Apache License 2.0: see [LICENSE](LICENSE) and [NOTICE](NOTICE).
