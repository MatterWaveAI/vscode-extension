import { describe, expect, it } from "vitest";
import {
  clip,
  docsContext,
  fetchDocText,
  fileContext,
  folderContext,
  folderTree,
  gitContext,
  MAX_CONTEXT_CHARS,
  MAX_TREE_DEPTH,
  MAX_TREE_ENTRIES,
  terminalContext,
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
