import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clip,
  cosineSimilarity,
  docsContext,
  fetchDocText,
  fileContext,
  folderContext,
  folderTree,
  gitContext,
  MAX_CONTEXT_CHARS,
  MAX_TREE_DEPTH,
  MAX_TREE_ENTRIES,
  mentionLabel,
  searchWorkspaceContext,
  terminalContext,
  tokenizeWorkspaceText,
   workspaceContext,
  WorkspaceIndex,
} from "../src/contextProviders";

describe("fileContext and folderContext", () => {
  it("is the raw file under its own workspace path", () => {
    expect(fileContext("src/a.ts", "export const a = 1;\n")).toEqual({ filename: "src/a.ts", text: "export const a = 1;\n" });
  });

  it("heads the tree with the folder it lists", () => {
    const part = folderContext("src", "src/\n  api/");
    expect(part.filename).toBe("folder-tree.txt");
    expect(part.text).toContain("Directory tree of src/:");
  });
});

describe("folderTree", () => {
  it("walks depth-first, indenting directories and marking them with a slash", async () => {
    const tree = await folderTree("src", async (path) =>
      path === "src"
        ? ["api/", "main.ts", "README.md"]
        : path === "src/api"
          ? ["routes.ts"]
          : [],
    );
    expect(tree).toBe(["src/", "api/", "  routes.ts", "main.ts", "README.md"].join("\n"));
  });

  it("never lists vendored or built directories", async () => {
    const walked: string[] = [];
    const tree = await folderTree(".", async (path) => {
      walked.push(path);
      return path === "." ? ["node_modules/", ".git/", "dist/", "src/"] : [];
    });
    expect(walked).toEqual([".", "./src"]);
    expect(tree).toBe(["./", "src/"].join("\n"));
  });

  it("marks an unreadable directory and keeps walking its siblings", async () => {
    const tree = await folderTree("root", async (path) => {
      if (path === "root/locked") throw new Error("denied");
      return path === "root" ? ["locked/", "open.txt"] : [];
    });
    expect(tree).toBe(["root/", "locked/", "  (unreadable)", "open.txt"].join("\n"));
  });

  it("stops at the depth cap without exploding", async () => {
    const tree = await folderTree("deep", async (path) => [path.split("/").length > MAX_TREE_DEPTH ? "leaf.txt" : "down/"]);
    expect(tree.split("\n").length).toBeLessThan(MAX_TREE_DEPTH * 2);
  });

  it("cuts at the entry cap and says so", async () => {
    let n = 0;
    const tree = await folderTree("big", async () => Array.from({ length: MAX_TREE_ENTRIES + 100 }, () => `f${n++}.txt`));
    expect(tree).toContain(`(tree cut at ${MAX_TREE_ENTRIES.toLocaleString()} entries)`);
    expect(tree.split("\n").length).toBe(MAX_TREE_ENTRIES + 2);
  });
});

describe("terminalContext and gitContext", () => {
  it("head the buffer with the terminal it came from", () => {
    const part = terminalContext("Tasks", "$ npm test\nok\n");
    expect(part.filename).toBe("terminal.txt");
    expect(part.text).toContain("Output of terminal “Tasks”:");
    expect(part.text).toContain("$ npm test");
  });

  it("head the diff with the range it covers", () => {
    const part = gitContext("Working tree changes", "diff --git a/a.ts b/a.ts\n");
    expect(part.filename).toBe("git-diff.diff");
    expect(part.text).toContain("Git context: Working tree changes.");
  });
});

describe("docsContext and fetchDocText", () => {
  it("heads the page with its URL and title", () => {
    const part = docsContext("https://mw.test/docs", "API", "The endpoint.");
    expect(part.filename).toBe("docs.txt");
    expect(part.text).toContain("Documentation from https://mw.test/docs (API):");
  });

  it("strips scripts, styles and tags out of an HTML page", async () => {
    const { title, text } = await fetchDocText("https://mw.test/docs", async () =>
      new Response(
        "<html><head><title>Routes &amp; <b>Params</b></title><style>p{}</style></head>" +
          '<body><script>alert(1)</script><h1>Routes</h1><p>POST /api/turns &lt;here&gt;</p></body></html>',
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
      ),
    );
    expect(title).toBe("Routes & Params");
    expect(text).toContain("Routes");
    expect(text).toContain("POST /api/turns <here>");
    expect(text).not.toMatch(/alert|p\{\}|<h1>|<script/);
  });

  it("keeps a plain text page as itself and rejects a failed fetch", async () => {
    const { text } = await fetchDocText("https://mw.test/a.md", async () => new Response("# Hello\n", { headers: { "Content-Type": "text/markdown" } }));
    expect(text).toBe("# Hello");
    await expect(fetchDocText("https://mw.test/x", async () => new Response("no", { status: 404 }))).rejects.toThrow("HTTP 404");
  });
});

describe("clip", () => {
  it("lets short text through and cuts long text saying where", () => {
    expect(clip("short")).toBe("short");
    const cut = clip("x".repeat(MAX_CONTEXT_CHARS + 10));
    expect(cut.startsWith("xxxxxx")).toBe(true);
    expect(cut).toContain(`(cut at ${MAX_CONTEXT_CHARS.toLocaleString()} characters)`);
  });
});

describe("@workspace codebase context provider", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "mw-workspace-ctx-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it("retrieves relevant code from unopened workspace files with file paths and line ranges", async () => {
    await mkdir(path.join(root, "src", "auth"), { recursive: true });
    await mkdir(path.join(root, "src", "billing"), { recursive: true });

    await writeFile(
      path.join(root, "src", "auth", "jwtVerifier.ts"),
      [
        "export interface JwtClaims {",
        "  sub: string;",
        "  orgId: string;",
        "}",
        "",
        "export function verifyJwtSignature(token: string, publicKey: string): JwtClaims {",
        "  if (!token.startsWith('eyJ')) {",
        "    throw new Error('Malformed JWT header');",
        "  }",
        "  return { sub: 'user_1', orgId: 'org_1' };",
        "}",
      ].join("\n"),
      "utf8",
    );

    await writeFile(
      path.join(root, "src", "billing", "invoiceCalculator.ts"),
      [
        "export function calculateMonthlyInvoice(seatCount: number, unitPriceCents: number): number {",
        "  return seatCount * unitPriceCents;",
        "}",
      ].join("\n"),
      "utf8",
    );

    expect(mentionLabel("workspace")).toBe("Workspace codebase");

    const part = await searchWorkspaceContext("@workspace how does verifyJwtSignature validate tokens?", {
      roots: root,
      topK: 3,
    });

    expect(part.filename).toBe("workspace-context.txt");
    expect(part.text).toContain("src/auth/jwtVerifier.ts (lines 1-11)");
    expect(part.text).toContain("export function verifyJwtSignature");
    // Unopened file ranked first
    const jwtIndex = part.text.indexOf("src/auth/jwtVerifier.ts");
    const billingIndex = part.text.indexOf("src/billing/invoiceCalculator.ts");
    expect(jwtIndex).toBeGreaterThanOrEqual(0);
    if (billingIndex !== -1) {
      expect(jwtIndex).toBeLessThan(billingIndex);
    }
  });

  it("strictly respects .gitignore, .matterwaveignore, and the .env / secret / binary deny rules", async () => {
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "ignored-dir"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await mkdir(path.join(root, "dist"), { recursive: true });

    await writeFile(path.join(root, ".gitignore"), "ignored-dir/\n*.generated.ts\n", "utf8");
    await writeFile(path.join(root, ".matterwaveignore"), "internal-notes.txt\n", "utf8");

    // Denied secret files containing the exact search keyword "superSecretPaymentKey"
    await writeFile(path.join(root, ".env"), "SUPER_SECRET_PAYMENT_KEY=superSecretPaymentKey_env\n", "utf8");
    await writeFile(path.join(root, ".env.production"), "SUPER_SECRET_PAYMENT_KEY=superSecretPaymentKey_prod\n", "utf8");
    await writeFile(path.join(root, "server.pem"), "superSecretPaymentKey_pem\n", "utf8");
    await writeFile(path.join(root, "id_ed25519"), "superSecretPaymentKey_ssh\n", "utf8");

    // Gitignored / matterwaveignored / skipped dir files containing the search keyword
    await writeFile(path.join(root, "ignored-dir", "secret.ts"), "export const k = 'superSecretPaymentKey_gitignored';\n", "utf8");
    await writeFile(path.join(root, "src", "schema.generated.ts"), "export const k = 'superSecretPaymentKey_generated';\n", "utf8");
    await writeFile(path.join(root, "internal-notes.txt"), "superSecretPaymentKey_mwignore\n", "utf8");
    await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "export const k = 'superSecretPaymentKey_node_modules';\n", "utf8");
    await writeFile(path.join(root, "dist", "bundle.js"), "export const k = 'superSecretPaymentKey_dist';\n", "utf8");

    // Binary file with null byte
    await writeFile(path.join(root, "src", "binary.dat"), Buffer.from("superSecretPaymentKey_binary\0hidden", "utf8"));

    // Legitimate workspace source file
    await writeFile(
      path.join(root, "src", "paymentClient.ts"),
      "export function configurePaymentClient(headerName = 'X-Payment-Key') {\n  return { headerName, label: 'superSecretPaymentKey_safe_source' };\n}\n",
      "utf8",
    );

    const index = new WorkspaceIndex({ roots: root });
    const snippets = await index.search("superSecretPaymentKey");

    expect(snippets.map((s) => s.path)).toEqual(["src/paymentClient.ts"]);
    const formatted = workspaceContext("superSecretPaymentKey", snippets);
    expect(formatted.text).toContain("superSecretPaymentKey_safe_source");
    expect(formatted.text).not.toContain("superSecretPaymentKey_env");
    expect(formatted.text).not.toContain("superSecretPaymentKey_prod");
    expect(formatted.text).not.toContain("superSecretPaymentKey_pem");
    expect(formatted.text).not.toContain("superSecretPaymentKey_ssh");
    expect(formatted.text).not.toContain("superSecretPaymentKey_gitignored");
    expect(formatted.text).not.toContain("superSecretPaymentKey_generated");
    expect(formatted.text).not.toContain("superSecretPaymentKey_mwignore");
    expect(formatted.text).not.toContain("superSecretPaymentKey_node_modules");
    expect(formatted.text).not.toContain("superSecretPaymentKey_dist");
    expect(formatted.text).not.toContain("superSecretPaymentKey_binary");
  });

  it("caches indexed files and invalidates/updates entries when file content or mtime changes or files are deleted", async () => {
    await mkdir(path.join(root, "src"), { recursive: true });
    const fileA = path.join(root, "src", "alpha.ts");
    const fileB = path.join(root, "src", "beta.ts");

    await writeFile(fileA, "export function computeAlphaMetric() { return 'alpha_v1'; }\n", "utf8");
    await writeFile(fileB, "export function computeBetaMetric() { return 'beta_v1'; }\n", "utf8");

    const index = new WorkspaceIndex({ roots: root });

    const first = await index.search("computeAlphaMetric");
    expect(first[0]?.path).toBe("src/alpha.ts");
    expect(first[0]?.content).toContain("alpha_v1");
    expect(index.stats).toEqual({ indexedFiles: 2, cacheHits: 0, cacheUpdates: 2 });

    // Second search without any file changes reuses cached entries
    const second = await index.search("computeAlphaMetric");
    expect(second[0]?.content).toContain("alpha_v1");
    expect(index.stats).toEqual({ indexedFiles: 2, cacheHits: 2, cacheUpdates: 0 });

    // Update fileA content and advance its mtime
    await writeFile(fileA, "export function computeAlphaMetric() { return 'alpha_v2_updated'; }\n", "utf8");
    const future = new Date(Date.now() + 5000);
    await utimes(fileA, future, future);

    const third = await index.search("alpha_v2_updated");
    expect(third[0]?.path).toBe("src/alpha.ts");
    expect(third[0]?.content).toContain("alpha_v2_updated");
    expect(index.stats.cacheHits).toBe(1);
    expect(index.stats.cacheUpdates).toBe(1);

    // Delete fileB and verify it is evicted from the cache
    await rm(fileB);
    const afterDelete = await index.search("beta_v1");
    expect(afterDelete).toEqual([]);
    expect(index.cachedFileCount).toBe(1);
  });

  it("enforces file count and per-file byte size caps", async () => {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), "export const sharedToken = 'one';\n", "utf8");
    await writeFile(path.join(root, "src", "b.ts"), "export const sharedToken = 'two';\n", "utf8");
    await writeFile(path.join(root, "src", "c.ts"), "export const sharedToken = 'three';\n", "utf8");
    await writeFile(path.join(root, "src", "huge.ts"), `export const sharedToken = '${"x".repeat(2048)}';\n`, "utf8");

    const index = new WorkspaceIndex({
      roots: root,
      maxFiles: 2,
      maxFileBytes: 512,
    });
    const results = await index.search("sharedToken", { topK: 10 });
    expect(index.cachedFileCount).toBe(2);
    expect(results.map((r) => r.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("ranks with optional /v1/embeddings cosine similarity and falls back to lexical BM25 when embeddings fail", async () => {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(
      path.join(root, "src", " semanticTarget.ts".trim()),
      "export function dispatchNotificationQueue() { return true; }\n",
      "utf8",
    );
    await writeFile(
      path.join(root, "src", "other.ts"),
      "export function parseCliFlags() { return false; }\n",
      "utf8",
    );

    // 1. With embeddings fetcher that gives semanticTarget.ts a high cosine similarity vector
    const embedTexts = async (texts: string[]) =>
      texts.map((t) => (t.includes("dispatchNotificationQueue") || t.includes("background worker alerts") ? [1, 0] : [0, 1]));

    const semanticIndex = new WorkspaceIndex({ roots: root, embedTexts });
    const semResults = await semanticIndex.search("background worker alerts", { topK: 1 });
    expect(semResults).toHaveLength(1);
    expect(semResults[0]?.path).toBe("src/semanticTarget.ts");

    // 2. When embeddings fetcher rejects (e.g. offline), automatically falls back to lexical ranking
    const failingIndex = new WorkspaceIndex({
      roots: root,
      embedTexts: async () => {
        throw new Error("Embeddings endpoint unreachable");
      },
    });
    const fallbackResults = await failingIndex.search("parseCliFlags", { topK: 1 });
    expect(fallbackResults).toHaveLength(1);
    expect(fallbackResults[0]?.path).toBe("src/other.ts");

    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(tokenizeWorkspaceText("@workspace parseCliFlags")).toContain("parse");
    expect(tokenizeWorkspaceText("@workspace parseCliFlags")).toContain("cli");
    expect(tokenizeWorkspaceText("@workspace parseCliFlags")).toContain("flags");
  });
});
