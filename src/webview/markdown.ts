import { escapeHtml, safeLinkUrl, sanitizeHtml } from "./sanitize";

/**
 * A small Markdown renderer for model text: paragraphs, headings, fenced and
 * inline code, emphasis, links, lists, block quotes, rules and pipe tables.
 *
 * Raw HTML in the source is never passed through -- every character of the
 * model's text is escaped before any tag is added -- and the result still goes
 * through `sanitizeHtml`, so a renderer bug cannot become script.
 */

export function renderMarkdown(source: string): string {
  return sanitizeHtml(renderBlocks(source.replace(/\r\n?/g, "\n").split("\n")));
}

function renderBlocks(lines: string[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const fence = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)?.*$/.exec(line);
    if (fence) {
      const marker = fence[1] ?? "```";
      const lang = fence[2] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith(marker)) body.push(lines[i++] ?? "");
      i++; // closing fence, or past the end of an unterminated block
      const cls = /^[\w+#.-]{1,40}$/.test(lang) ? ` class="language-${lang}"` : "";
      out.push(`<pre><code${cls}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = (heading[1] ?? "#").length;
      out.push(`<h${level}>${inline(heading[2] ?? "")}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i] ?? "")) quoted.push((lines[i++] ?? "").replace(/^\s{0,3}>\s?/, ""));
      out.push(`<blockquote>${renderBlocks(quoted)}</blockquote>`);
      continue;
    }
    const listMatch = /^\s{0,3}([-*+]|\d{1,9}[.)])\s+/.exec(line);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[1] ?? "");
      const items: string[] = [];
      const start = ordered ? parseInt(listMatch[1] ?? "1", 10) : 1;
      while (i < lines.length) {
        const item = /^\s{0,3}([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(lines[i] ?? "");
        if (!item) {
          // A lazy continuation line belongs to the item above.
          const cont = lines[i] ?? "";
          if (cont.trim() !== "" && /^\s{2,}/.test(cont) && items.length > 0) {
            items[items.length - 1] += " " + cont.trim();
            i++;
            continue;
          }
          break;
        }
        items.push(item[2] ?? "");
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      const startAttr = ordered && start !== 1 ? ` start="${start}"` : "";
      out.push(`<${tag}${startAttr}>${items.map((it) => `<li>${inline(it)}</li>`).join("")}</${tag}>`);
      continue;
    }
    if (line.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[i + 1] ?? "")) {
      const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const header = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim() !== "") rows.push(cells(lines[i++] ?? ""));
      out.push(
        `<table><thead><tr>${header.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`,
      );
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim() !== "" && !startsBlock(lines[i] ?? "")) paragraph.push(lines[i++] ?? "");
    if (paragraph.length === 0) paragraph.push(lines[i++] ?? "");
    out.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
  }
  return out.join("");
}

function startsBlock(line: string): boolean {
  return /^\s{0,3}(`{3,}|~{3,}|#{1,6}\s|>|[-*+]\s|\d{1,9}[.)]\s)/.test(line);
}

/** Inline spans. Code spans are cut out first so nothing inside them is formatted. */
function inline(text: string): string {
  const codes: string[] = [];
  let s = text.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _ticks: string, code: string) => {
    codes.push(`<code>${escapeHtml(code.trim())}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = escapeHtml(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_whole, label: string, href: string) => {
    const safe = safeLinkUrl(href);
    return safe ? `<a href="${escapeHtml(safe)}">${label}</a>` : label;
  });
  s = s.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a?: string, b?: string) => `<strong>${a ?? b ?? ""}</strong>`);
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)|(^|[^_\w])_([^_\s][^_]*)_(?!\w)/g, (_, p1?: string, a?: string, p2?: string, b?: string) =>
    `${p1 ?? p2 ?? ""}<em>${a ?? b ?? ""}</em>`,
  );
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u0000(\d+)\u0000/g, (_, n: string) => codes[Number(n)] ?? "");
}
