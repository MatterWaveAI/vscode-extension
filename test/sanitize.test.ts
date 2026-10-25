import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/webview/markdown";
import { sanitizeHtml } from "../src/webview/sanitize";

describe("sanitizeHtml", () => {
  it("drops script elements with their content", () => {
    expect(sanitizeHtml("<p>a</p><script>alert(1)</script><p>b</p>")).toBe("<p>a</p><p>b</p>");
    expect(sanitizeHtml("<SCRIPT src=x></SCRIPT>ok")).toBe("ok");
  });

  it("strips every on* handler and style, keeping the allowed tag", () => {
    const out = sanitizeHtml(`<p onclick="steal()" style="x" ONMOUSEOVER='y'>hi</p><img src=x onerror=alert(1)>`);
    expect(out).toBe("<p>hi</p>");
    expect(out).not.toMatch(/on\w+=/i);
  });

  it("refuses javascript: and data: links, including obfuscated ones", () => {
    expect(sanitizeHtml(`<a href="javascript:alert(1)">x</a>`)).toBe(`<a rel="noopener noreferrer nofollow">x</a>`);
    expect(sanitizeHtml(`<a href="java&#x09;script:alert(1)">x</a>`)).not.toContain("href");
    expect(sanitizeHtml(`<a href="data:text/html,<b>">x</a>`)).not.toContain("href");
    expect(sanitizeHtml(`<a href="https://example.com/a?b=1">x</a>`)).toContain(`href="https://example.com/a?b=1"`);
  });

  it("drops unknown tags and comments but keeps their text", () => {
    expect(sanitizeHtml("<iframe src=x></iframe><div>t</div><!-- c -->")).toBe("t");
    expect(sanitizeHtml("<svg><script>x</script></svg>after")).toBe("after");
  });
});

describe("renderMarkdown", () => {
  it("never passes the model's raw HTML through", () => {
    const html = renderMarkdown(`Hello <img src=x onerror="alert(1)"> **world** <script>alert(2)</script>`);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img");
    expect(html).toContain("<strong>world</strong>");
  });

  it("renders fenced code with its language and escapes the code", () => {
    const html = renderMarkdown("```ts\nconst a = '<b>';\n```");
    expect(html).toBe(`<pre><code class="language-ts">const a = &#39;&lt;b&gt;&#39;;</code></pre>`);
  });

  it("renders links only with a safe protocol", () => {
    expect(renderMarkdown("[ok](https://example.com)")).toContain(`href="https://example.com/"`);
    expect(renderMarkdown("[bad](javascript:alert(1))")).not.toContain("href");
  });

  it("renders lists, headings and inline code", () => {
    const html = renderMarkdown("# Title\n\n- one `x<y`\n- two\n\n1. a\n2. b");
    expect(html).toBe("<h1>Title</h1><ul><li>one <code>x&lt;y</code></li><li>two</li></ul><ol><li>a</li><li>b</li></ol>");
  });
});
