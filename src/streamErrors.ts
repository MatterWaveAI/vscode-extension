// Mirrored from web/src/apps/chat/streamErrors.ts so the editor and the web
// app say the same thing about the same failure. The extension cannot import
// across the package boundary (it bundles standalone), so this is a copy:
// change both together. Two editor-specific edits: "pick a different model
// above" points at the picker command, and the session copy names sign-in.
/**
 * The failure modes a chat stream can end in, and the copy each one shows.
 *
 * Data and a classifier, deliberately outside the .tsx: the component that
 * renders them stays a component (fast refresh), and the mapping is testable
 * without a DOM.
 *
 * Three rules are encoded here. Every state answers "what do I
 * do now?" in its `guidance`. No state quotes a raw error body — the detail
 * string is matched against, never rendered. And `retryable` is false wherever
 * retrying cannot succeed until something changes elsewhere, so the UI does
 * not offer a button that is guaranteed to fail.
 */
export type StreamErrorKind =
  | "gateway"
  | "timeout"
  | "truncated"
  | "budget"
  | "context"
  | "session"
  | "network"
  | "untrusted_certificate"
  | "moderation"
  | "unknown";

/**
 * A classified failure with the correlation id of the request that produced
 * it.
 *
 * The id travels with the kind rather than beside it because every surface
 * that renders one renders the other, and the two were separated exactly long
 * enough for the id to be dropped on the way.
 *
 * `requestId` is null where the API never answered - an aborted fetch, a dead
 * uplink - and the UI says so rather than showing a blank reference.
 */
export interface StreamFailure {
  readonly kind: StreamErrorKind;
  readonly requestId: string | null;
}

export interface StreamErrorCopy {
  readonly title: string;
  readonly guidance: string;
  readonly retryable: boolean;
}

export const STREAM_ERROR_COPY: Record<StreamErrorKind, StreamErrorCopy> = {
  // The upstream answered with a refusal or could not be reached at all:
  // nothing of the answer exists. Distinct from `truncated`, where part of
  // it does, and from `timeout`, where the upstream was reached and then
  // went quiet.
  gateway: {
    title: "The model gateway did not answer",
    guidance:
      "The upstream that serves the models is unreachable or returned an error, so no answer was started. Your message is still here — try again, or pick a different model (MatterWave: Pick Model).",
    retryable: true,
  },
  // The request reached the gateway and then nothing came back inside the
  // time the API allows. Usually a model that is loading or a queue that is
  // full, which a second attempt a moment later often clears.
  timeout: {
    title: "The model took too long to answer",
    guidance:
      "The request reached the gateway but no answer arrived in time — the model may still be loading or busy with other requests. Wait a moment and retry, or pick a different model (MatterWave: Pick Model).",
    retryable: true,
  },
  // The answer was under way and the stream ended without the API's closing
  // frame. Whatever arrived is real and stays on screen; the copy must say it
  // is incomplete, because a cut answer formatted like a finished one is the
  // worst outcome available.
  truncated: {
    title: "The answer was cut off",
    guidance:
      "The stream ended before the model finished — a dropped connection, a phone switching networks, or the gateway closing the stream early. Whatever arrived is kept above but is not the whole answer; retry to ask again from where the conversation now stands.",
    retryable: true,
  },
  budget: {
    title: "This workspace is out of tokens",
    guidance:
      "This workspace has used its monthly token budget: the plan's included tokens and any overage its cap allows. Nothing is broken — see Usage for when it resets; an admin can raise the overage cap or upgrade the plan.",
    retryable: false,
  },
  context: {
    title: "This conversation is too long for the model",
    guidance:
      "The conversation plus your message exceeds the model's context window. Start a new chat, or compact it (MatterWave: Compact Conversation Now) or pick a model with a larger context window.",
    retryable: false,
  },
  session: {
    title: "Your session expired mid-response",
    guidance:
      "You were signed out while the model was answering. Anything it had already sent is kept above. Sign in again (MatterWave: Sign In), then retry.",
    retryable: true,
  },
  // The request never reached the API: the editor could not open a connection. No
  // reference will exist for it, and the status bar's offline state is the
  // usual companion.
  network: {
    title: "MatterWave could not be reached",
    guidance:
      "The request did not get through — check your connection. Your message is still here, and nothing was sent, so retrying sends it for the first time.",
    retryable: true,
  },
  // The connection opened and TLS refused the server's chain: a deployment
  // behind a private authority the editor has not been told about. Its own
  // kind because the fix is a setting, not the network, and "check your
  // connection" would send the person looking in the wrong place.
  untrusted_certificate: {
    title: "The server's certificate is not trusted",
    guidance:
      "The MatterWave server presented a certificate signed by an authority this editor does not know. If the deployment uses its own certificate authority, set matterwave.caFile to the PEM file of that authority and retry; nothing was sent.",
    retryable: true,
  },
  // Not a technical failure and not the model declining: MatterWave refused
  // to send this. Kept distinct from `unknown` because the research is
  // explicit that a refusal mistaken for a fault is retried forever, and
  // distinct from a model refusal because they are different facts.
  moderation: {
    title: "MatterWave would not send this message",
    guidance:
      "This message was blocked by MatterWave's content rules before it reached a model, so retrying it unchanged will be blocked again. Rephrase it, or quote the reference below to an administrator if you think this is wrong.",
    retryable: false,
  },
  unknown: {
    title: "The response failed",
    guidance:
      "Something went wrong while the model was answering. Your message is still here — retry, and if it keeps happening tell an administrator what you were doing.",
    retryable: true,
  },
};

/** Every kind, in a stable order. */
export const STREAM_ERROR_KINDS: readonly StreamErrorKind[] = [
  "gateway",
  "timeout",
  "truncated",
  "budget",
  "context",
  "session",
  "network",
  "untrusted_certificate",
  "moderation",
  "unknown",
];

/**
 * The `code` the stream layer attaches when a body ends without a terminal
 * frame. A code rather than a sentence to match, for the same reason the
 * refusal frame carries one: the text of a detail string is not a contract.
 */
export const TRUNCATED_CODE = "truncated";

/**
 * Place a failure in one of the designed states.
 *
 * Conservative by design: anything it cannot place becomes `unknown`, whose
 * copy is honest about not knowing rather than guessing wrong. Status code
 * first where there is one, because it is the stronger signal; the detail
 * string is a fallback for errors that arrive over SSE without one.
 */
export function classifyStreamError(
  detail: string,
  status?: number,
  /**
   * The machine-readable `code` an SSE refusal frame carries, where there is
   * one. Checked before any text matching because it is the only signal that
   * cannot be spoofed by the contents of a user's own message: the detail
   * string for a moderation block is server copy, but a user is free to type
   * "budget exceeded" and have the model echo it back.
   */
  code?: string,
): StreamErrorKind {
  if (code === "moderation") return "moderation";
  if (code === TRUNCATED_CODE) return "truncated";
  const text = detail.toLowerCase();
  if (status === 401 || status === 403 || text.includes("expired") || text.includes("unauthor")) {
    return "session";
  }
  if (
    status === 402 ||
    text.includes("budget") ||
    text.includes("quota")
  ) {
    return "budget";
  }
  if (
    text.includes("context") &&
    (text.includes("length") || text.includes("window") || text.includes("token"))
  ) {
    return "context";
  }
  // Before `gateway`: the API reports an upstream read timeout as "Lost the
  // connection to the model gateway: ... timed out", and the gateway words
  // in that sentence must not outrank the timeout it describes.
  if (
    status === 504 ||
    text.includes("timed out") ||
    text.includes("timeout") ||
    text.includes("deadline")
  ) {
    return "timeout";
  }
  // The API's own words for a generation that ended with nothing to show:
  // the stream opened and closed with no answer in it.
  if (text.includes("before the answer finished") || text.includes("ended before")) {
    return "truncated";
  }
  if (
    status === 502 ||
    status === 503 ||
    text.includes("gateway") ||
    text.includes("upstream")
  ) {
    return "gateway";
  }
  if (text.includes("network") || text.includes("fetch") || text.includes("connection")) {
    return "network";
  }
  return "unknown";
}
