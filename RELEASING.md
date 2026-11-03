# Releasing the MatterWave VS Code Extension

This document describes the release workflow for the MatterWave Visual Studio Code extension (`matterwave.matterwave`).

## Branch Model

- **`develop`**: Default integration branch for active feature work and continuous integration.
- **`main`**: Production release branch. Only commits merged into `main` may be tagged for release.

## Step-by-Step Release Process

### 1. Prepare the Release on `develop`

1. Update the `"version"` field in `package.json` to the new semantic version (for example, `0.3.1`).
2. Add a corresponding `## [0.3.1] - YYYY-MM-DD` section at the top of `CHANGELOG.md` summarizing the changes since the previous release.
3. Verify all local checks and packaging gates pass:
   ```bash
   pnpm install --frozen-lockfile
   pnpm lint
   pnpm typecheck
   pnpm test
   pnpm build
   node scripts/release.mjs check-tag "v$(node -p 'require("./package.json").version')"
   node scripts/release.mjs notes
   ```

### 2. Merge `develop` into `main`

1. Open a pull request from `develop` into `main` (or fast-forward merge `develop` into `main` once CI is green).
2. Ensure all CI checks in `.github/workflows/ci.yml` succeed on the PR before merging.

### 3. Tag `v*` on `main`

1. Check out the updated `main` branch locally:
   ```bash
   git checkout main
   git pull origin main
   ```
2. Cut and push an annotated `v*` tag matching `package.json`:
   ```bash
   VERSION="$(node -p 'require("./package.json").version')"
   git tag -a "v${VERSION}" -m "Release v${VERSION}"
   git push origin "v${VERSION}"
   ```

### 4. Automated Release & Registry Publish (`.github/workflows/release.yml`)

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which runs two jobs:

1. **`release` job**:
   - **Branch ancestry guard**: Runs `git fetch origin main --depth=1` and `git merge-base --is-ancestor "$GITHUB_SHA" origin/main` to ensure the tagged commit is an ancestor of `origin/main`. Tags pushed from unmerged branches are rejected before building or publishing.
   - **Tag & changelog gate**: Runs `node scripts/release.mjs check-tag "$TAG"` and `node scripts/release.mjs notes > notes.md` to confirm the tag matches `package.json` and has a non-empty `CHANGELOG.md` entry.
   - **Quality & packaging gates**: Runs `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `vsce package`, and generates a CycloneDX SBOM (`scripts/sbom.mjs`).
   - **GitHub Release**: Creates the GitHub Release titled `vX.Y.Z` with the extracted `CHANGELOG.md` notes, attaching both `matterwave-X.Y.Z.vsix` and `matterwave-X.Y.Z.cdx.json`.

2. **`marketplace` job**:
   - Downloads the exact `.vsix` artifact built by the `release` job.
   - Publishes to the **Visual Studio Code Marketplace** using `VSCE_TOKEN` (`vsce publish --packagePath matterwave-*.vsix`).
   - Publishes to **Open VSX** using `OVSX_TOKEN` (`ovsx publish matterwave-*.vsix`).
   - If either token secret is not configured, that registry step logs a warning and exits cleanly without failing the other registry.
