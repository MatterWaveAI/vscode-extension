/**
 * The @-mention context assemblers: what each provider kind turns into an
 * attachment's text.
 *
 * Everything here is pure over injected IO (a directory reader, a fetch, a
 * diff), so each provider's exact output is testable without an editor or a
 * repository. Sizes are clipped here rather than left to the server's
 * extraction, because a tree or a diff that overruns the context window is
 * noise, not signal.
 */

import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import * as nodePath from "node:path";
import type { MentionKind } from "./chat/mentions";
import {
  confine,
  DEFAULT_DENY,
  DenyList,
  loadDenyList,
  loadSearchIgnore,
  type SearchIgnore,
} from "./lib/sdk/agent/node";

/** One provider's answer: an attachment's filename and its text. */
export interface ContextPart {
  filename: string;
  text: string;
}

/** The cap on any one provider's text; the model needs the shape, not the bulk. */
export const MAX_CONTEXT_CHARS = 100_000;

/** How deep the @folder tree walks, and how many entries it may list. */
export const MAX_TREE_DEPTH = 6;
export const MAX_TREE_ENTRIES = 2_000;

/**
 * Directories that are build output and vendored code: listed never, since
 * they bury the tree the person is asking about.
 */
export const SKIPPED_DIRS = new Set([".git", "node_modules", "dist", "out", "build", "__pycache__", ".venv", "venv"]);

/** Cut `text` at the cap, saying so where it was cut. */
export function clip(text: string, max = MAX_CONTEXT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (cut at ${max.toLocaleString()} characters)`;
}

/** The raw file as itself: the upload route extracts it, as Ask about File. */
export function fileContext(path: string, content: string): ContextPart {
  return { filename: path, text: clip(content) };
}

/** A folder's tree, with a header naming what was listed. */
export function folderContext(path: string, tree: string): ContextPart {
  return { filename: "folder-tree.txt", text: clip(`Directory tree of ${path}/:\n${tree}`) };
}

/** A terminal's buffer, headed by which terminal it came from. */
export function terminalContext(name: string, buffer: string): ContextPart {
  return { filename: "terminal.txt", text: clip(`Output of terminal “${name}”:\n${buffer}`) };
}

/** A git diff, headed by what range it covers. */
export function gitContext(label: string, diff: string): ContextPart {
  return { filename: "git-diff.diff", text: clip(`Git context: ${label}.\n${diff}`) };
}

/** A fetched documentation page, headed by where it came from. */
export function docsContext(url: string, title: string, text: string): ContextPart {
  return { filename: "docs.txt", text: clip(`Documentation from ${url}${title ? ` (${title})` : ""}:\n${text}`) };
}

/**
 * The names in one directory, directories marked with a trailing `/`.
 * Skipped names (`node_modules` and friends) are left out by the walker,
 * so a reader cannot forget them.
 */
export type DirReader = (path: string) => Promise<string[]>;

/**
 * The folder tree as an indented listing: directories end in `/`, deeper
 * levels indent two spaces, skipped directories never appear, and the walk
 * stops at the depth or entry cap with a line saying so.
 */
export async function folderTree(root: string, readDir: DirReader): Promise<string> {
  const lines: string[] = [`${root}/`];
  let entries = 0;
  let cut = false;
  const walk = async (path: string, prefix: string, depth: number): Promise<void> => {
    if (cut || depth > MAX_TREE_DEPTH) return;
    let names: string[];
    try {
      names = await readDir(path);
    } catch {
      lines.push(`${prefix}(unreadable)`);
      return;
    }
    for (const name of names) {
      const dir = name.endsWith("/");
      if (dir && SKIPPED_DIRS.has(name.slice(0, -1))) continue;
      if (entries >= MAX_TREE_ENTRIES) {
        cut = true;
        break;
      }
      entries++;
      lines.push(prefix + name);
      if (dir) await walk(`${path}/${name.slice(0, -1)}`, `${prefix}  `, depth + 1);
    }
  };
  await walk(root, "", 1);
  if (cut) lines.push(`… (tree cut at ${MAX_TREE_ENTRIES.toLocaleString()} entries)`);
  return lines.join("\n");
}

/**
 * A documentation page as text: HTML stripped to its words (scripts and
 * styles with their contents dropped, tags off, whitespace collapsed), any
 * other text type as itself. Rejects a non-2xx answer with its status.
 */
export async function fetchDocText(
  url: string,
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<{ title: string; text: string }> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const raw = await response.text();
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("html")) {
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw);
    const title = decodeEntities((titleMatch?.[1] ?? "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    const text = decodeEntities(
      raw
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<(?:p|div|br|li|h[1-6]|tr|section|article)(?:\s[^>]*)?>/gi, "\n")
        .replace(/<[^>]+>/g, " "),
    )
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return { title, text };
  }
  return { title: "", text: raw.trim() };
}

/** The entities an HTML page's text and title actually carry. */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** The provider's name in UI strings, e.g. a QuickPick title. */
export function mentionLabel(kind: MentionKind): string {
  switch (kind) {
    case "file":
      return "File contents";
    case "folder":
      return "Folder tree";
    case "workspace":
      return "Workspace codebase";
    case "terminal":
      return "Terminal output";
    case "git":
      return "Git changes";
    case "docs":
      return "Documentation page";
  }
}

/** Caps for `@workspace` codebase indexing and snippet selection. */
export const MAX_WORKSPACE_FILES = 500;
export const MAX_WORKSPACE_FILE_BYTES = 256 * 1024;
export const DEFAULT_WORKSPACE_TOP_K = 8;
export const WORKSPACE_CHUNK_LINES = 60;
export const WORKSPACE_CHUNK_OVERLAP = 10;

const EXTRA_SKIPPED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "out",
  "build",
  "__pycache__",
  ".venv",
  "venv",
  ".next",
  ".nuxt",
  "coverage",
  "target",
  ".turbo",
  ".cache",
]);

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".bz2",
  ".7z",
  ".rar",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".wasm",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  ".mp3",
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".wav",
  ".ogg",
  ".flac",
  ".class",
  ".jar",
  ".pyc",
  ".pyo",
  ".pyd",
  ".db",
  ".sqlite",
  ".sqlite3",
]);

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "do",
  "does",
  "for",
  "from",
  "has",
  "have",
  "how",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "there",
  "these",
  "this",
  "to",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "workspace",
]);

export interface WorkspaceSnippet {
  /** Workspace-relative POSIX path (prefixed with folder name in multi-root workspaces). */
  path: string;
  /** 1-based inclusive start line of the snippet. */
  startLine: number;
  /** 1-based inclusive end line of the snippet. */
  endLine: number;
  /** Snippet text. */
  content: string;
  /** Relevance score (higher is more relevant). */
  score: number;
}

export type EmbeddingsFetcher = (texts: string[]) => Promise<number[][]>;

export interface WorkspaceRootInput {
  name?: string;
  path: string;
}

export interface WorkspaceIndexOptions {
  /** Workspace root path or list of workspace roots. */
  roots: string | readonly (string | WorkspaceRootInput)[];
  /** Maximum number of files to index across the workspace (default `MAX_WORKSPACE_FILES`). */
  maxFiles?: number;
  /** Maximum file size in bytes to index (default `MAX_WORKSPACE_FILE_BYTES`). */
  maxFileBytes?: number;
  /** Maximum lines per indexed chunk (default `WORKSPACE_CHUNK_LINES`). */
  chunkLines?: number;
  /** Overlap lines between consecutive chunks (default `WORKSPACE_CHUNK_OVERLAP`). */
  chunkOverlap?: number;
  /** Optional additional deny-list globs on top of `DEFAULT_DENY` and `.matterwaveignore`. */
  extraDenyGlobs?: readonly string[];
  /** Optional `/v1/embeddings` fetcher for semantic cosine similarity scoring; falls back to lexical BM25/TF-IDF when omitted or on error. */
  embedTexts?: EmbeddingsFetcher;
}

export interface WorkspaceSearchOptions {
  /** Maximum number of top snippets to return (default `DEFAULT_WORKSPACE_TOP_K`). */
  topK?: number;
  /** Optional per-query embeddings fetcher override. */
  embedTexts?: EmbeddingsFetcher;
}

interface IndexedChunk {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  lowerContent: string;
  termFreq: Map<string, number>;
  tokenCount: number;
  pathTokens: Set<string>;
  embedding?: number[];
}

interface CachedFileEntry {
  absolutePath: string;
  displayPath: string;
  mtimeMs: number;
  size: number;
  contentSignature: string;
  chunks: IndexedChunk[];
}

/**
 * Tokenize source code or natural-language queries into lowercase lexical terms,
 * splitting both snake_case and camelCase/PascalCase identifiers while preserving
 * compound identifier tokens for exact-symbol matching.
 */
export function tokenizeWorkspaceText(text: string, options?: { keepStopWords?: boolean }): string[] {
  const cleaned = text.replace(/(^|[^A-Za-z0-9_@])@workspace(?![A-Za-z0-9_])/gi, " ");
  const rawTokens = cleaned.match(/[A-Za-z0-9_]+/g) ?? [];
  const out: string[] = [];
  const keepStop = options?.keepStopWords === true;

  const pushToken = (tok: string) => {
    const lower = tok.toLowerCase();
    if (lower.length < 2) return;
    if (!keepStop && STOP_WORDS.has(lower)) return;
    out.push(lower);
  };

  for (const raw of rawTokens) {
    pushToken(raw);
    const parts = raw
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/[_\s]+/)
      .filter(Boolean);
    if (parts.length > 1) {
      for (const part of parts) {
        pushToken(part);
      }
    }
  }
  return out;
}

/**
 * Compute cosine similarity between two numeric vectors in `[-1, 1]`.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    const va = a[i]!;
    const vb = b[i]!;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function quickSignature(text: string): string {
  const len = text.length;
  if (len === 0) return "0:";
  const head = text.slice(0, 64);
  const mid = text.slice(Math.floor(len / 2), Math.floor(len / 2) + 64);
  const tail = text.slice(Math.max(0, len - 64));
  return `${len}:${head}:${mid}:${tail}`;
}

function splitFileIntoChunks(
  displayPath: string,
  text: string,
  chunkLines: number,
  chunkOverlap: number,
): IndexedChunk[] {
  const lines = text.split(/\r?\n/);
  const effectiveChunkLines = Math.max(10, chunkLines);
  const effectiveOverlap = Math.max(0, Math.min(chunkOverlap, effectiveChunkLines - 1));
  const step = Math.max(1, effectiveChunkLines - effectiveOverlap);
  const pathTokens = new Set(tokenizeWorkspaceText(displayPath));
  const chunks: IndexedChunk[] = [];

  for (let startIdx = 0; startIdx < lines.length; startIdx += step) {
    const endIdx = Math.min(lines.length, startIdx + effectiveChunkLines);
    const slice = lines.slice(startIdx, endIdx);
    const content = slice.join("\n");
    if (content.trim().length > 0) {
      const tokens = tokenizeWorkspaceText(content);
      const termFreq = new Map<string, number>();
      for (const token of tokens) {
        termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
      }
      const startLine = startIdx + 1;
      const endLine = endIdx;
      chunks.push({
        id: `${displayPath}:${startLine}-${endLine}`,
        path: displayPath,
        startLine,
        endLine,
        content,
        lowerContent: content.toLowerCase(),
        termFreq,
        tokenCount: Math.max(1, tokens.length),
        pathTokens,
      });
    }
    if (endIdx >= lines.length) break;
  }

  return chunks;
}

/**
 * Format ranked `@workspace` codebase snippets into a `ContextPart` attachment
 * with file paths and 1-based line ranges.
 */
export function workspaceContext(query: string, snippets: readonly WorkspaceSnippet[]): ContextPart {
  const cleanedQuery = query.replace(/(^|[^A-Za-z0-9_@])@workspace(?![A-Za-z0-9_])/gi, " ").replace(/\s+/g, " ").trim();
  const header = cleanedQuery
    ? `Workspace context for “${cleanedQuery}”:`
    : "Workspace context:";
  if (snippets.length === 0) {
    return {
      filename: "workspace-context.txt",
      text: `${header}\n(no matching workspace files found)`,
    };
  }
  const sections = snippets.map((snippet) => {
    const range =
      snippet.startLine === snippet.endLine
        ? `line ${snippet.startLine}`
        : `lines ${snippet.startLine}-${snippet.endLine}`;
    return `--- ${snippet.path} (${range}) ---\n${snippet.content}`;
  });
  return {
    filename: "workspace-context.txt",
    text: clip(`${header}\n\n${sections.join("\n\n")}`),
  };
}

/**
 * Cached `@workspace` codebase indexer and searcher.
 *
 * - Walks workspace roots while respecting `.gitignore`, `.matterwaveignore`,
 *   and the `.env`/secret deny-list (`DEFAULT_DENY`), skipping `node_modules`,
 *   `.git`, `dist`, `out`, `build`, and binary files.
 * - Enforces file count (`maxFiles`) and per-file byte size (`maxFileBytes`) caps.
 * - Caches file chunks by file path + `mtimeMs` + `size`, invalidating and
 *   updating entries when files change, are deleted, or `mtimeMs` updates.
 * - Ranks chunks against the user's query using BM25 / TF-IDF lexical scoring
 *   and optional `/v1/embeddings` cosine similarity with automatic lexical fallback.
 */
export class WorkspaceIndex {
  private readonly options: WorkspaceIndexOptions;
  private readonly cache = new Map<string, CachedFileEntry>();
  private lastStats = { indexedFiles: 0, cacheHits: 0, cacheUpdates: 0 };

  constructor(options: WorkspaceIndexOptions) {
    this.options = options;
  }

  /** Number of currently cached workspace files. */
  get cachedFileCount(): number {
    return this.cache.size;
  }

  /** Statistics from the most recent `sync()` or `search()` call. */
  get stats(): { indexedFiles: number; cacheHits: number; cacheUpdates: number } {
    return { ...this.lastStats };
  }

  /** Explicitly invalidate one file (by absolute or workspace-relative path) or the entire cache. */
  invalidate(filePath?: string): void {
    if (!filePath) {
      this.cache.clear();
      return;
    }
    const normalized = filePath.replace(/\\/g, "/");
    for (const [abs, entry] of this.cache.entries()) {
      if (
        abs === filePath ||
        abs.replace(/\\/g, "/") === normalized ||
        entry.displayPath === normalized ||
        abs.replace(/\\/g, "/").endsWith(`/${normalized}`)
      ) {
        this.cache.delete(abs);
      }
    }
  }

  private normalizedRoots(): WorkspaceRootInput[] {
    const raw = typeof this.options.roots === "string" ? [this.options.roots] : this.options.roots;
    return raw.map((r) => (typeof r === "string" ? { path: r } : r));
  }

  /**
   * Synchronize the in-memory chunk cache with the workspace filesystem,
   * re-reading only new or modified files and evicting deleted or newly ignored files.
   */
  async sync(): Promise<void> {
    const roots = this.normalizedRoots();
    const multiRoot = roots.length > 1;
    const maxFiles = this.options.maxFiles ?? MAX_WORKSPACE_FILES;
    const maxFileBytes = this.options.maxFileBytes ?? MAX_WORKSPACE_FILE_BYTES;
    const chunkLines = this.options.chunkLines ?? WORKSPACE_CHUNK_LINES;
    const chunkOverlap = this.options.chunkOverlap ?? WORKSPACE_CHUNK_OVERLAP;

    const seenAbsolutePaths = new Set<string>();
    let indexedFiles = 0;
    let cacheHits = 0;
    let cacheUpdates = 0;

    for (const root of roots) {
      if (indexedFiles >= maxFiles) break;
      const rootPath = nodePath.resolve(root.path);
      const rootPrefix = multiRoot ? (root.name || nodePath.basename(rootPath)) : "";

      let deny: DenyList;
      try {
        const loaded = loadDenyList(rootPath);
        deny =
          this.options.extraDenyGlobs && this.options.extraDenyGlobs.length > 0
            ? new DenyList([...loaded.patterns, ...this.options.extraDenyGlobs])
            : loaded;
      } catch {
        deny = new DenyList([...DEFAULT_DENY, ...(this.options.extraDenyGlobs ?? [])]);
      }

      let ignore: SearchIgnore | null = null;
      try {
        ignore = loadSearchIgnore(rootPath);
      } catch {
        ignore = null;
      }

      const walkDir = async (currentAbs: string, relDirPosix: string): Promise<void> => {
        if (indexedFiles >= maxFiles) return;
        let entries: Dirent[];
        try {
          entries = await readdir(currentAbs, { withFileTypes: true });
        } catch {
          return;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));

        for (const entry of entries) {
          if (indexedFiles >= maxFiles) break;
          if (entry.isSymbolicLink()) continue;

          const name = entry.name;
          const relPosix = relDirPosix ? `${relDirPosix}/${name}` : name;
          const fullPath = nodePath.join(currentAbs, name);

          if (entry.isDirectory()) {
            if (SKIPPED_DIRS.has(name) || EXTRA_SKIPPED_DIRS.has(name)) continue;
            if (deny.matches(relPosix) || deny.matches(name)) continue;
            if (ignore?.ignored(relPosix, { isDir: true })) continue;
            await walkDir(fullPath, relPosix);
            continue;
          }

          if (!entry.isFile()) continue;

          const ext = nodePath.extname(name).toLowerCase();
          if (BINARY_EXTENSIONS.has(ext)) continue;
          if (deny.matches(relPosix) || deny.matches(name)) continue;
          if (ignore?.ignored(relPosix, { isDir: false })) continue;

          try {
            confine(rootPath, relPosix, { deny });
          } catch {
            continue;
          }

          let fileStat;
          try {
            fileStat = await stat(fullPath);
          } catch {
            continue;
          }
          if (!fileStat.isFile() || fileStat.size <= 0 || fileStat.size > maxFileBytes) {
            continue;
          }

          const displayPath = rootPrefix ? `${rootPrefix}/${relPosix}` : relPosix;
          const existing = this.cache.get(fullPath);

          if (
            existing &&
            existing.mtimeMs === fileStat.mtimeMs &&
            existing.size === fileStat.size &&
            existing.displayPath === displayPath
          ) {
            seenAbsolutePaths.add(fullPath);
            indexedFiles += 1;
            cacheHits += 1;
            continue;
          }

          let rawText: string;
          try {
            const buf = await readFile(fullPath);
            if (buf.includes(0)) {
              // Binary file (contains NUL byte)
              continue;
            }
            rawText = buf.toString("utf8");
          } catch {
            continue;
          }

          const sig = quickSignature(rawText);
          if (existing && existing.contentSignature === sig && existing.displayPath === displayPath) {
            existing.mtimeMs = fileStat.mtimeMs;
            existing.size = fileStat.size;
            seenAbsolutePaths.add(fullPath);
            indexedFiles += 1;
            cacheHits += 1;
            continue;
          }

          const chunks = splitFileIntoChunks(displayPath, rawText, chunkLines, chunkOverlap);
          if (chunks.length === 0) continue;

          this.cache.set(fullPath, {
            absolutePath: fullPath,
            displayPath,
            mtimeMs: fileStat.mtimeMs,
            size: fileStat.size,
            contentSignature: sig,
            chunks,
          });
          seenAbsolutePaths.add(fullPath);
          indexedFiles += 1;
          cacheUpdates += 1;
        }
      };

      await walkDir(rootPath, "");
    }

    for (const absPath of Array.from(this.cache.keys())) {
      if (!seenAbsolutePaths.has(absPath)) {
        this.cache.delete(absPath);
      }
    }

    this.lastStats = { indexedFiles, cacheHits, cacheUpdates };
  }

  /**
   * Search the indexed workspace for the top-k chunks relevant to `query`,
   * using BM25/TF-IDF lexical scoring and optional `/v1/embeddings` cosine similarity
   * (falling back to lexical scoring if embeddings are not configured or fail).
   */
  async search(query: string, options: WorkspaceSearchOptions = {}): Promise<WorkspaceSnippet[]> {
    await this.sync();
    const topK = Math.max(1, options.topK ?? DEFAULT_WORKSPACE_TOP_K);

    const allChunks: IndexedChunk[] = [];
    for (const entry of this.cache.values()) {
      for (const chunk of entry.chunks) {
        allChunks.push(chunk);
      }
    }
    if (allChunks.length === 0) {
      return [];
    }

    const queryTokens = tokenizeWorkspaceText(query);
    const uniqueQueryTokens = Array.from(new Set(queryTokens));
    const totalChunks = allChunks.length;
    const avgChunkLen =
      allChunks.reduce((sum, c) => sum + c.tokenCount, 0) / Math.max(1, totalChunks);

    const docFreq = new Map<string, number>();
    for (const term of uniqueQueryTokens) {
      let df = 0;
      for (const chunk of allChunks) {
        if (chunk.termFreq.has(term) || chunk.pathTokens.has(term)) {
          df += 1;
        }
      }
      docFreq.set(term, df);
    }

    const k1 = 1.5;
    const b = 0.75;
    const lexicalScores = new Map<string, number>();
    let maxLexical = 0;

    for (const chunk of allChunks) {
      let score = 0;
      for (const term of uniqueQueryTokens) {
        const df = docFreq.get(term) ?? 0;
        const idf = Math.log(1 + (totalChunks - df + 0.5) / (df + 0.5));
        const tf = chunk.termFreq.get(term) ?? 0;
        if (tf > 0) {
          const tfNorm =
            (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (chunk.tokenCount / avgChunkLen)));
          score += idf * tfNorm;
        }
        if (chunk.pathTokens.has(term)) {
          score += idf * 1.5;
        }
        if (term.length >= 4 && chunk.lowerContent.includes(term)) {
          score += idf * 0.35;
        }
      }
      lexicalScores.set(chunk.id, score);
      if (score > maxLexical) {
        maxLexical = score;
      }
    }

    const embedder = options.embedTexts ?? this.options.embedTexts;
    const semanticScores = new Map<string, number>();
    let hasSemantic = false;

    if (embedder && query.trim().length > 0) {
      try {
        const missingChunks = allChunks.filter((c) => !c.embedding);
        if (missingChunks.length > 0) {
          const vectors = await embedder(missingChunks.map((c) => `${c.path}\n${c.content}`));
          if (Array.isArray(vectors) && vectors.length === missingChunks.length) {
            for (let i = 0; i < missingChunks.length; i++) {
              const vec = vectors[i];
              if (Array.isArray(vec) && vec.length > 0) {
                missingChunks[i]!.embedding = vec;
              }
            }
          }
        }
        const [queryVector] = await embedder([query]);
        if (Array.isArray(queryVector) && queryVector.length > 0) {
          for (const chunk of allChunks) {
            if (chunk.embedding) {
              const sim = cosineSimilarity(queryVector, chunk.embedding);
              semanticScores.set(chunk.id, sim);
              if (sim > 0) {
                hasSemantic = true;
              }
            }
          }
        }
      } catch {
        // Automatic fallback to local lexical scoring when /v1/embeddings fails or is offline
        hasSemantic = false;
      }
    }

    const scored: WorkspaceSnippet[] = [];
    for (const chunk of allChunks) {
      const lex = lexicalScores.get(chunk.id) ?? 0;
      const sem = semanticScores.get(chunk.id) ?? 0;
      let combined = lex;
      if (hasSemantic) {
        const normLex = maxLexical > 0 ? lex / maxLexical : 0;
        combined = normLex * 0.45 + Math.max(0, sem) * 0.55 + lex * 0.05;
      }
      if (uniqueQueryTokens.length === 0 && !hasSemantic) {
        // When prompt is just `@workspace` with no specific query terms, provide top workspace files
        combined = 1 / (1 + chunk.startLine * 0.01);
      }
      if (combined > 0) {
        scored.push({
          path: chunk.path,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          content: chunk.content,
          score: combined,
        });
      }
    }

    scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.startLine - b.startLine);
    return scored.slice(0, topK);
  }
}

/**
 * Convenience helper to index/search a workspace for `query` and format the
 * top-k snippets as a `ContextPart`.
 */
export async function searchWorkspaceContext(
  query: string,
  options: WorkspaceIndexOptions & WorkspaceSearchOptions & { index?: WorkspaceIndex },
): Promise<ContextPart> {
  const index = options.index ?? new WorkspaceIndex(options);
  const snippets = await index.search(query, {
    topK: options.topK,
    embedTexts: options.embedTexts,
  });
  return workspaceContext(query, snippets);
}
