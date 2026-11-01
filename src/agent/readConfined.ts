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

/** The first `maxBytes` of a regular file as UTF-8, or null when there is no such file (a folder, a pipe, a device count as none). */
export async function readHead(absolute: string, maxBytes = MAX_READ_BYTES): Promise<{ text: string; truncated: boolean } | null> {
  let handle;
  try {
    handle = await open(absolute, "r");
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    const size = Math.min(info.size, maxBytes);
    const buffer = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const { bytesRead } = await handle.read(buffer, read, size - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return { text: new TextDecoder("utf-8").decode(buffer.subarray(0, read)), truncated: info.size > read };
  } catch {
    return null;
  } finally {
    await handle.close();
  }
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
