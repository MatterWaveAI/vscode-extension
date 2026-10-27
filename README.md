# MatterWave for VS Code

Chat with your organisation's MatterWave models from the editor: the same conversations, models
and answers as the web app, with a selection or a file as context. It is a chat client, not a
coding agent. It never edits files, runs commands or executes tools; tool calls run on the
MatterWave API and show up here as collapsed blocks.

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

## Settings

| Setting | Default | |
|---|---|---|
| `matterwave.baseUrl` | `https://app.matterwave.dev` | The MatterWave deployment to use. |
| `matterwave.caFile` | empty | Path to a PEM file with the certificate authority that signed the deployment's TLS certificate, trusted beside the system's. For a deployment behind a private CA; `~/` is expanded. |

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
(downloaded once into `.vscode-test/` by `@vscode/test-electron`), against a real deployment.
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
is not published to npm, so the extension carries the client it needs. Without a connection the
composer is disabled and the draft is kept; **Reconnect** in the view tries the API again.
