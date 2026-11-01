import { describe, expect, it } from "vitest";
import { MAX_PROMPTS, normalizePromptName, PromptLibrary, type Memento } from "../src/promptLibrary";

function fakeMemento(initial: Record<string, unknown> = {}): Memento & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>(Object.entries(initial));
  return {
    values,
    get<T>(key: string): T | undefined {
      return values.get(key) as T | undefined;
    },
    update(key: string, value: unknown): Promise<void> {
      values.set(key, value);
      return Promise.resolve();
    },
  };
}

describe("normalizePromptName", () => {
  it("trims, drops the leading slash and lower cases", () => {
    expect(normalizePromptName("  /Code-Review_2 ")).toBe("code-review_2");
    expect(normalizePromptName("Plain")).toBe("plain");
  });
});

describe("PromptLibrary", () => {
  it("round-trips a prompt through save, get, list and remove", async () => {
    const library = new PromptLibrary(fakeMemento());
    expect(await library.save("Code-Review", "Review this diff.\nBe thorough.")).toBe(true);
    expect(await library.get("/code-review")).toBe("Review this diff.\nBe thorough.");
    expect(await library.get("CODE-REVIEW")).toBe("Review this diff.\nBe thorough.");
    expect(await library.list()).toEqual([{ name: "code-review", text: "Review this diff.\nBe thorough.", scope: "global" }]);

    await library.remove("/CODE-REVIEW");
    expect(await library.get("code-review")).toBeNull();
    expect(await library.list()).toEqual([]);
  });

  it("replaces a prompt saved again under the same name", async () => {
    const library = new PromptLibrary(fakeMemento());
    await library.save("a", "one");
    await library.save("a", "two");
    expect(await library.get("a")).toBe("two");
    expect((await library.list()).length).toBe(1);
  });

  it("refuses empty text, oversized text, and malformed names", async () => {
    const library = new PromptLibrary(fakeMemento());
    expect(await library.save("empty", "   ")).toBe(false);
    expect(await library.save("long", "x".repeat(10_001))).toBe(false);
    expect(await library.save("has space", "x")).toBe(false);
    expect(await library.save("ümlaut", "x")).toBe(false);
    expect(await library.save("", "x")).toBe(false);
    expect(await library.list()).toEqual([]);
  });

  it("caps the library and says so", async () => {
    const library = new PromptLibrary(fakeMemento());
    for (let i = 0; i < MAX_PROMPTS; i++) expect(await library.save(`p${i}`, "text")).toBe(true);
    expect(await library.save("one-more", "text")).toBe(false);
    // A replacement of an existing prompt is still allowed at the cap.
    expect(await library.save("p0", "replaced")).toBe(true);
    expect(await library.get("p0")).toBe("replaced");
  });

  it("keeps a workspace's own prompts beside the global ones, the workspace's answering first", async () => {
    const global = fakeMemento();
    const workspace = fakeMemento();
    const library = new PromptLibrary(global, workspace);
    expect(library.hasWorkspace).toBe(true);
    await library.save("review", "General review.", "global");
    await library.save("review", "This project's review checklist.", "workspace");
    await library.save("tests", "Write tests.", "global");

    expect(await library.get("/review")).toBe("This project's review checklist.");
    expect(await library.get("tests")).toBe("Write tests.");
    expect(await library.list()).toEqual([
      { name: "review", text: "This project's review checklist.", scope: "workspace" },
      { name: "review", text: "General review.", scope: "global" },
      { name: "tests", text: "Write tests.", scope: "global" },
    ]);
    // Each scope is its own value: another workspace sees only the global prompts.
    expect(await new PromptLibrary(global, fakeMemento()).get("review")).toBe("General review.");

    await library.remove("review", "workspace");
    expect(await library.get("review")).toBe("General review.");
  });

  it("has no workspace scope in a window with no folder open", async () => {
    const library = new PromptLibrary(fakeMemento(), null);
    expect(library.hasWorkspace).toBe(false);
    expect(await library.save("x", "text", "workspace")).toBe(false);
    expect(await library.list()).toEqual([]);
  });

  it("caps each scope on its own", async () => {
    const library = new PromptLibrary(fakeMemento(), fakeMemento());
    for (let i = 0; i < MAX_PROMPTS; i++) await library.save(`p${i}`, "text", "global");
    expect(await library.save("one-more", "text", "global")).toBe(false);
    expect(await library.save("one-more", "text", "workspace")).toBe(true);
  });

  it("answers null for a name that was never saved and keeps other rows on remove", async () => {
    const library = new PromptLibrary(fakeMemento());
    await library.save("keep", "kept");
    expect(await library.get("missing")).toBeNull();
    await library.remove("other");
    expect(await library.get("keep")).toBe("kept");
  });
});
