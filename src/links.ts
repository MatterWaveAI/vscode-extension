/**
 * Where a notification's link leads, decided once and purely so the tests
 * can pin it. A row's `link` is written for the web app: a path on this
 * deployment (`/apps/chat?c=…`), or an absolute http(s) URL. The editor
 * opens a conversation link in its own chat view and everything else in the
 * browser -- and refuses anything else a `link` field could be made to
 * carry (`javascript:`, `file:`, a protocol handler).
 */

export type NotificationTarget =
  | { kind: "conversation"; conversationId: string }
  | { kind: "url"; url: string };

/** The web app's chat route; a conversation rides beside it as `?c=<id>`. */
const CHAT_PATH = "/apps/chat";

/** An absolute link this module will consider at all. */
const ABSOLUTE_LINK = /^https?:\/\//i;
/** A relative link is a path: one slash, then printable ASCII -- not prose that resolution would survive. */
const RELATIVE_LINK = /^\/[!-~]{0,2048}$/;

/** A conversation id is a server-made token, not a sentence. */
function looksLikeId(value: string | null): value is string {
  return value !== null && value.length > 0 && value.length <= 100 && !/[\s<>"'`]/.test(value);
}

export function classifyNotificationLink(raw: string, baseUrl: string): NotificationTarget | null {
  const candidate = raw.trim();
  if (!candidate || candidate.length > 2048) return null;
  if (!ABSOLUTE_LINK.test(candidate) && !RELATIVE_LINK.test(candidate)) return null;
  let parsed: URL;
  try {
    parsed = new URL(candidate, `${baseUrl.replace(/\/+$/, "")}/`);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const sameOrigin = parsed.origin === new URL(baseUrl).origin;
  if (sameOrigin && parsed.pathname === CHAT_PATH) {
    const conversationId = parsed.searchParams.get("c");
    if (looksLikeId(conversationId)) return { kind: "conversation", conversationId };
  }
  const url = parsed.origin + parsed.pathname + parsed.search + parsed.hash;
  return { kind: "url", url };
}
