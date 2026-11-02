/**
 * The environment a process the agent starts gets (`run_shell`, an MCP
 * stdio server): the extension host's, less what belongs to the editor and
 * to MatterWave's sign-in.
 *
 * The extension host carries VS Code's own plumbing: `ELECTRON_RUN_AS_NODE`
 * (which turns any Electron app the command starts, `code` included, into a
 * bare Node), and `VSCODE_IPC_HOOK*` and friends (handles a child could use to
 * drive the editor). VS Code strips the same names from its integrated
 * terminal and tasks. A MatterWave key or token in the environment is
 * removed too: a command has no use for the credential the editor signs in
 * with, and a prompt-injected one could print it.
 */

/** The VS Code names its terminal keeps, as VS Code's own sanitiser does. */
const VSCODE_KEPT = /^VSCODE_(?:PORTABLE|SHELL_LOGIN|ENV_REPLACE|ENV_APPEND|ENV_PREPEND)$/i;
const DROPPED = [/^ELECTRON_.+$/i, /^VSCODE_.+$/i, /^SNAP(?:|_.*)$/i, /^GDK_PIXBUF_.+$/i];
/** A MatterWave credential by its name: MATTERWAVE_API_KEY, MATTERWAVE_TOKEN, MW_API_KEY... */
const CREDENTIAL = /^(?:MATTERWAVE|MW)_(?:.*_)?(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)$/i;

export function childEnv(base: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (CREDENTIAL.test(name)) continue;
    if (!VSCODE_KEPT.test(name) && DROPPED.some((pattern) => pattern.test(name))) continue;
    env[name] = value;
  }
  // What a configuration names explicitly (an MCP server's `env`) is the person's choice.
  return { ...env, ...extra };
}
