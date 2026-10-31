import type { ApiKeyListing } from "./api/types";

/**
 * One line per key in the Manage API Keys picker: what the key may do
 * (its scopes), then its life -- when it was made, when it was last used,
 * and when it runs out. Locale-rendered dates, as the rest of the UI.
 */
export function keyDetail(k: ApiKeyListing): string {
  const pieces: string[] = [];
  if (k.scopes.length > 0) pieces.push(`scopes ${k.scopes.join(", ")}`);
  pieces.push(`created ${new Date(k.created_at).toLocaleDateString()}`);
  if (k.last_used_at) pieces.push(`last used ${new Date(k.last_used_at).toLocaleDateString()}`);
  else pieces.push("never used");
  if (k.expires_at) pieces.push(`expires ${new Date(k.expires_at).toLocaleDateString()}`);
  return pieces.join(" · ");
}
