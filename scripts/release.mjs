#!/usr/bin/env node
// The release workflow's two checks on the CHANGELOG and the version.
//
//     node scripts/release.mjs check-tag v0.4.0   # exit 1 unless it names package.json's version
//     node scripts/release.mjs notes [0.4.0]      # print that version's CHANGELOG section
//
// `check-tag` keeps a tag from publishing one version under another's name;
// `notes` is the GitHub release's text, the section as written, so the
// CHANGELOG stays the one place release notes are kept. The same script as
// the SDKs' release scripts.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function packageVersion() {
  return JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")).version;
}

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function notes(changelog, version) {
  const heading = new RegExp(`^## \\[${escape(version)}\\][^\\n]*\\n`, "m");
  const found = heading.exec(changelog);
  if (!found) throw new Error(`CHANGELOG.md has no section for ${version}`);
  const rest = changelog.slice(found.index + found[0].length);
  const next = /^## \[/m.exec(rest);
  const body = (next ? rest.slice(0, next.index) : rest).trim();
  if (!body) throw new Error(`CHANGELOG.md's section for ${version} is empty`);
  return `${body}\n`;
}

const [command, value] = process.argv.slice(2);
try {
  if (command === "check-tag" && value) {
    const version = packageVersion();
    if (value !== `v${version}`) {
      console.error(`tag ${value} does not name the package version ${version} (expected v${version})`);
      process.exit(1);
    }
  } else if (command === "notes") {
    process.stdout.write(notes(readFileSync(resolve(ROOT, "CHANGELOG.md"), "utf8").replace(/\r\n/g, "\n"), value ?? packageVersion()));
  } else {
    console.error("usage: release.mjs check-tag <tag> | notes [version]");
    process.exit(2);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
