import type { MatterWaveClient } from "../api/client";
import type { TokenStore } from "./session";

/**
 * What sign-out did on the server. The editor forgets the credential in
 * every case but `not_signed_in`: an API that cannot be reached must not
 * keep the editor signed in.
 */
export type SignOutOutcome = "revoked" | "kept" | "revoke_failed" | "not_signed_in";

/**
 * A key device login minted exists for this editor alone, so it is revoked
 * before the secret goes -- otherwise it stays valid under Settings → API
 * keys after the person believes they are out. The revoke needs the bearer,
 * so it happens first. A pasted key is left for its owner to manage.
 */
export async function signOut(client: MatterWaveClient, tokens: TokenStore): Promise<SignOutOutcome> {
  const session = await tokens.session();
  if (!session) return "not_signed_in";
  let outcome: SignOutOutcome = "kept";
  if (session.minted) {
    outcome = await client.revokeKey(session.token).then(
      () => "revoked" as const,
      () => "revoke_failed" as const,
    );
  }
  await tokens.clear();
  return outcome;
}
