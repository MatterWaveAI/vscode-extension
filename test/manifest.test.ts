import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The manifest as the Marketplace and Open VSX read it, and the package
 * the release ships: what a registry refuses, or a person installing it
 * would miss, fails here rather than at publish time.
 */

const root = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const manifest = JSON.parse(readFileSync(root("package.json"), "utf8"));

describe("the extension manifest", () => {
  it("has a PNG icon of at least 128x128, as both registries require", () => {
    expect(manifest.icon).toBe("media/icon.png");
    const png = readFileSync(root(manifest.icon));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    // IHDR: width and height, big-endian, at bytes 16 and 20.
    expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(128);
    expect(png.readUInt32BE(20)).toBe(png.readUInt32BE(16));
  });

  it("carries the gallery metadata: banner, keywords, homepage, bugs and repository", () => {
    expect(manifest.galleryBanner).toEqual({ color: expect.stringMatching(/^#[0-9A-Fa-f]{6}$/), theme: "dark" });
    expect(manifest.keywords.length).toBeGreaterThan(0);
    // The Marketplace accepts at most 30 keywords.
    expect(manifest.keywords.length).toBeLessThanOrEqual(30);
    expect(manifest.homepage).toMatch(/^https:\/\//);
    expect(manifest.bugs.url).toMatch(/^https:\/\/.*\/issues$/);
    expect(manifest.repository.url).toMatch(/^https:\/\//);
    expect(manifest.license).toBe("MIT");
  });

  it("declares limited support for untrusted workspaces", () => {
    expect(manifest.capabilities.untrustedWorkspaces.supported).toBe("limited");
    expect(manifest.capabilities.untrustedWorkspaces.description).toMatch(/Restricted Mode/);
  });

  it("binds inline edit on every platform, yielding Ctrl/Cmd+I to the editor's own inline chat", () => {
    const bindings = manifest.contributes.keybindings.filter((k: { command: string }) => k.command === "matterwave.inlineEdit");
    const primary = bindings.find((k: { key: string }) => k.key === "ctrl+i");
    expect(primary.mac).toBe("cmd+i");
    expect(primary.when).toContain("!inlineChatHasProvider");
    expect(primary.when).toContain("!inlineChatHasEditsAgent");
    expect(primary.when).toContain("isWorkspaceTrusted");
    // A second binding nothing else claims, for an editor where inline chat has Ctrl/Cmd+I.
    const fallback = bindings.find((k: { key: string }) => k.key !== "ctrl+i");
    expect(fallback.mac).toBeDefined();
    expect(fallback.when).not.toContain("inlineChat");
  });

  it("activates on the view or a command, never at start-up", () => {
    expect(manifest.activationEvents).toEqual([]);
  });

  it("binds open chat, new chat and ask about selection on every platform", () => {
    for (const command of ["matterwave.openChat", "matterwave.newChat", "matterwave.askAboutSelection"]) {
      const binding = manifest.contributes.keybindings.find((k: { command: string }) => k.command === command);
      expect(binding?.key, command).toMatch(/^ctrl\+alt\+m /);
      expect(binding?.mac, command).toMatch(/^ctrl\+cmd\+m /);
    }
  });

  it("has a walkthrough whose steps' pages exist and whose buttons run its own commands", () => {
    const [walkthrough] = manifest.contributes.walkthroughs;
    expect(walkthrough.steps.map((s: { id: string }) => s.id)).toEqual(["signIn", "askAboutSelection", "apply", "inlineEdit"]);
    const commands = new Set(manifest.contributes.commands.map((c: { command: string }) => c.command));
    for (const step of walkthrough.steps) {
      expect(readFileSync(root(step.media.markdown), "utf8").length, step.id).toBeGreaterThan(0);
      for (const [, command] of step.description.matchAll(/\(command:([\w.]+)\)/g)) expect(commands.has(command), command).toBe(true);
    }
  });

  it("offers Explain and Fix on the terminal's context menu", () => {
    expect(manifest.contributes.menus["terminal/context"].map((m: { command: string }) => m.command)).toEqual([
      "matterwave.explainTerminalCommand",
      "matterwave.fixTerminalCommand",
    ]);
  });

  it("binds and menus only commands it contributes", () => {
    const commands = new Set(manifest.contributes.commands.map((c: { command: string }) => c.command));
    for (const binding of manifest.contributes.keybindings) expect(commands.has(binding.command), binding.command).toBe(true);
    for (const items of Object.values(manifest.contributes.menus) as { command?: string }[][]) {
      for (const item of items) if (item.command) expect(commands.has(item.command), item.command).toBe(true);
    }
  });

  it("packages without the stale vsce flags", () => {
    expect(manifest.scripts.package).not.toContain("--skip-license");
    expect(manifest.scripts.package).not.toContain("--allow-missing-repository");
    for (const workflow of ["ci.yml", "release.yml"]) {
      const text = readFileSync(root(`.github/workflows/${workflow}`), "utf8");
      expect(text, workflow).not.toContain("--skip-license");
      expect(text, workflow).not.toContain("--allow-missing-repository");
    }
  });

  it("pins every action to a commit and gives the workflow token read access by default", () => {
    for (const workflow of ["ci.yml", "release.yml"]) {
      const text = readFileSync(root(`.github/workflows/${workflow}`), "utf8");
      const uses = [...text.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1] ?? "");
      expect(uses.length, workflow).toBeGreaterThan(0);
      for (const action of uses) expect(action, `${workflow}: ${action}`).toMatch(/@[0-9a-f]{40}$/);
      expect(text, workflow).toMatch(/^permissions:\n {2}contents: read$/m);
    }
  });

  it("checks in CI that no tracked file names a private ticket id", () => {
    expect(readFileSync(root(".github/workflows/ci.yml"), "utf8")).toContain("sh scripts/check-ticket-ids.sh");
  });

  it("ships the licence and the changelog in the .vsix", () => {
    const ignore = readFileSync(root(".vscodeignore"), "utf8").split(/\r?\n/);
    expect(ignore).toContain("!LICENSE");
    expect(ignore).toContain("!CHANGELOG.md");
  });
});
