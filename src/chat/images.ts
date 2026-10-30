/**
 * Image attachments as the transcript shows them. The host fetches an
 * attachment's bytes and hands the webview a `data:` URI -- the webview
 * itself cannot fetch (its CSP allows no network), so the bytes cross the
 * message channel, which carries no credential.
 *
 * Only the types the vision models read are rendered, and only under the
 * byte cap: the channel post and the page's memory are both sized for
 * pictures, not for arbitrary files, and an oversized one keeps its
 * named-attachment chip.
 */

/** The largest attachment rendered inline; larger stays a named chip. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** The types an `<img>` may be shown for. Anything else is not trusted as an image. */
export const RENDERABLE_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** Whether a part's content type is one a preview is rendered for. */
export function renderableImageType(contentType: string): boolean {
  return RENDERABLE_IMAGE_TYPES.has(contentType);
}

/** The bytes as a `data:` URI of exactly the type the API recorded for them. */
export function imageDataUri(bytes: ArrayBuffer, contentType: string): string {
  let binary = "";
  const view = new Uint8Array(bytes);
  const chunk = 0x8000;
  for (let at = 0; at < view.length; at += chunk) {
    binary += String.fromCharCode(...view.subarray(at, at + chunk));
  }
  const base64 = globalThis.btoa(binary);
  return `data:${contentType};base64,${base64}`;
}

/**
 * The webview's own check on a URI that arrived over the channel: the shape
 * (and a length bound consistent with the byte cap) must hold before anything
 * is put in an `img src`, where a malformed value is dead and a hostile one
 * would be worse.
 */
const DATA_URI_PATTERN = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_DATA_URI_CHARS = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 64;

export function trustedImageDataUri(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_DATA_URI_CHARS && DATA_URI_PATTERN.test(value);
}
