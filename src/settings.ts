/**
 * The server setting, and when to ask for it. Pure, so the decision and the
 * normalisation are tested without an editor.
 *
 * The default base URL is the public deployment. An editor pointed at a
 * private one (a self-hosted `https://matterwave.internal.example`) would otherwise fail its
 * first request against a host it was never meant to reach and say so only
 * in the chat view's error state, so the first activation that finds the
 * default in force asks once, prefilled, and writes the answer to the
 * user setting.
 */

export const DEFAULT_BASE_URL = "https://app.matterwave.dev";

/** Ask on the first activation that still has the default server in force; never again after. */
export function shouldPromptForServer(input: { configured: string | undefined; prompted: boolean }): boolean {
  if (input.prompted) return false;
  const configured = input.configured?.trim() ?? "";
  return configured === "" || configured === DEFAULT_BASE_URL;
}

/** The problem with a typed server URL, or null for one that can be used. */
export function serverUrlProblem(raw: string): string | null {
  const value = raw.trim();
  if (value === "") return "Enter the URL of your MatterWave deployment.";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Enter a full URL, such as https://app.matterwave.ai";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "The URL must start with https:// or http://";
  if (!url.hostname) return "The URL needs a host name.";
  if (url.search || url.hash) return "Leave off any ?query or #fragment.";
  return null;
}

/** The URL as the setting stores it: trimmed, origin and path only, no trailing slash; null for one `serverUrlProblem` refuses. */
export function normalizeServerUrl(raw: string): string | null {
  if (serverUrlProblem(raw) !== null) return null;
  const url = new URL(raw.trim());
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}
