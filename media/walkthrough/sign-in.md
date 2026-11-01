# Sign in

MatterWave talks to your organisation's deployment. The first time you open the chat or sign in, it asks which one (the `matterwave.baseUrl` setting) and keeps the answer.

- **Sign In (Device Code)** opens the deployment's sign-in page in your browser with a code filled in. Confirm it there; the editor never sees your password.
- **Sign In with API Key** takes an `mw_…` key from *Settings → API keys* in the web app, checked before it is kept.

Either way the credential is kept in the editor's secret storage, and only the extension host uses it. Behind a proxy, MatterWave uses the editor's own `http.proxy` settings; behind a private certificate authority, set `matterwave.caFile`.
