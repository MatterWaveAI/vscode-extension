import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { PathRefusedError } from "../lib/sdk/agent/deny";
import { confine } from "../lib/sdk/agent/confine";

/**
 * Files the agent reads on its own account rather than through a tool -- the
 * project's MATTERWAVE.md and AGENTS.md, the workspace's commands and
 * subagents, `@path` mentions -- go through the same confinement as the
 * tools: a repository's `MATTERWAVE.md` that is a link to `~/.ssh/id_rsa`, or
 * a `.matterwave` folder that is a junction elsewhere, is refused rather than
 * put into the prompt. And only the head of a file is read, so a huge one
 * costs no more than its cap.
 */

/** At most this much of a file is read; callers cut the text further. */
export const MAX_READ_BYTES = 512 * 1024;

export type ConfinedRead = { text: string; relative: string; truncated: boolean } | { refused: string } | null;

// Non-blocking, so a pipe put where a file was is never waited on (Windows
// has no such flag, nor pipes in the filesystem).
const OPEN_FLAGS = constants.O_RDONLY | ((constants as Partial<Record<string, number>>).O_NONBLOCK ?? 0);
const CHUNK = 1 << 20;

/**
 * At most `maxBytes` of the regular file at `absolute`, and its size (at
 * least the bytes read, so a file that grew while it was read still counts
 * as larger); null when it is not a regular file (a folder, a pipe, a
 * device). An error opening or reading it is thrown.
 */
export async function readBytes(absolute: string, maxBytes: number): Promise<{ bytes: Buffer; size: number } | null> {
  const handle = await open(absolute, OPEN_FLAGS);
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    const chunks: Buffer[] = [];
    let read = 0;
    while (read < maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(maxBytes - read, CHUNK, Math.max(info.size - read + 1, 8192)));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      read += bytesRead;
    }
    return { bytes: Buffer.concat(chunks, read), size: Math.max(info.size, read) };
  } finally {
    await handle.close();
  }
}

/** The first `maxBytes` of a regular file as UTF-8, or null when there is no such file (a folder, a pipe, a device count as none). */
export async function readHead(absolute: string, maxBytes = MAX_READ_BYTES): Promise<{ text: string; truncated: boolean } | null> {
  let read;
  try {
    read = await readBytes(absolute, maxBytes);
  } catch {
    return null;
  }
  return read && { text: new TextDecoder("utf-8").decode(read.bytes), truncated: read.size > read.bytes.length };
}

/** `relative` under `root`, confined, then read: the text, a refusal (the confinement's sentence), or null when it does not exist. */
export async function readConfined(root: string, relative: string, maxBytes = MAX_READ_BYTES): Promise<ConfinedRead> {
  let target;
  try {
    target = confine(root, relative);
  } catch (error) {
    if (error instanceof PathRefusedError) return { refused: error.message };
    return null;
  }
  const read = await readHead(target.absolute, maxBytes);
  return read ? { ...read, relative: target.relative } : null;
}
