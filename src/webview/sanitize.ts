/**
 * An allowlist HTML sanitiser for model output.
 *
 * The webview runs with scripts enabled (it is the chat UI), so model output
 * rendered into it is the same boundary as the web app's: anything that is
 * not a known-safe tag with a known-safe attribute is dropped. The Markdown
 * renderer already escapes all raw HTML in the model's text, so this is the
 * second wall, not the first -- it is what still holds if the renderer ever
 * emits something it should not.
 *
 * String-based rather than DOM-based so it behaves identically in the
 * webview and in the unit tests, which run in Node with no DOM.
 */

const ALLOWED_TAGS = new Set([
  "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
  "strong", "em", "del", "code", "pre", "blockquote",
  "ul", "ol", "li", "a", "table", "thead", "tbody", "tr", "th", "td",
]);

const VOID_TAGS = new Set(["br", "hr"]);

/** Dropped together with everything inside them, not just the tags. */
const DROP_WITH_CONTENT = new Set([
  "script", "style", "iframe", "object", "embed", "template", "noscript",
  "textarea", "title", "svg", "math", "frameset", "frame", "xmp", "plaintext",
]);

const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Undo the entity escaping an attribute value may carry, so the URL check sees what a browser would. */
function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function safeLinkUrl(raw: string): string | null {
  // Control characters and whitespace are stripped first: browsers ignore
  // them inside a scheme, which is how "java\tscript:" gets past a naive check.
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  const url = decodeEntities(raw).replace(/[\u0000- \u007f]/g, "");
  try {
    const parsed = new URL(url);
    return LINK_PROTOCOLS.has(parsed.protocol) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function allowedAttribute(tag: string, name: string, value: string): string | null {
  if (tag === "a" && name === "href") return safeLinkUrl(value);
  if (tag === "code" && name === "class") return /^language-[\w+#.-]{1,40}$/.test(value) ? value : null;
  if (tag === "ol" && name === "start") return /^\d{1,6}$/.test(value) ? value : null;
  if ((tag === "th" || tag === "td") && name === "align") return /^(left|right|center)$/.test(value) ? value : null;
  return null;
}

const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function rebuildTag(tag: string, attrs: string, closing: boolean): string {
  if (closing) return VOID_TAGS.has(tag) ? "" : `</${tag}>`;
  const kept: string[] = [];
  for (const match of attrs.matchAll(ATTRIBUTE)) {
    const name = (match[1] ?? "").toLowerCase();
    // Every on* handler and style are refused by not being on the list;
    // nothing here enumerates the bad ones, so a new event name cannot slip by.
    const value = allowedAttribute(tag, name, match[2] ?? match[3] ?? match[4] ?? "");
    if (value !== null) kept.push(`${name}="${escapeHtml(value)}"`);
  }
  if (tag === "a") kept.push('rel="noopener noreferrer nofollow"');
  return `<${tag}${kept.length ? " " + kept.join(" ") : ""}>`;
}

const TOKEN = /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

export function sanitizeHtml(html: string): string {
  let out = "";
  let last = 0;
  let dropping: string | null = null;
  for (const match of html.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    if (dropping === null) out += escapeText(html.slice(last, index));
    last = index + match[0].length;
    if (match[0].startsWith("<!--")) continue;
    const closing = match[1] === "/";
    const tag = (match[2] ?? "").toLowerCase();
    if (dropping !== null) {
      if (closing && tag === dropping) dropping = null;
      continue;
    }
    if (DROP_WITH_CONTENT.has(tag)) {
      if (!closing && !/\/\s*$/.test(match[3] ?? "")) dropping = tag;
      continue;
    }
    if (!ALLOWED_TAGS.has(tag)) continue;
    out += rebuildTag(tag, match[3] ?? "", closing);
  }
  if (dropping === null) out += escapeText(html.slice(last));
  return out;
}

/** Text between tags: a stray "<" or ">" becomes text, entities stay as they are. */
function escapeText(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
