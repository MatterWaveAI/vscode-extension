import type { Message, SummaryPart } from "../api/types";
import type { TranscriptEntry } from "./protocol";

/**
 * The conversation tree, client-side: sibling counts for the switcher and
 * the leaf a switch lands on. The same rules as the web app's
 * `branches.ts` -- creation order decides sibling order, and a switch
 * follows the newest child down to a leaf.
 */

function byCreation(a: Message, b: Message): number {
  return a.created_at === b.created_at ? a.id.localeCompare(b.id) : a.created_at.localeCompare(b.created_at);
}

export function childrenOf(tree: readonly Message[]): Map<string | null, Message[]> {
  const index = new Map<string | null, Message[]>();
  for (const message of [...tree].sort(byCreation)) {
    const key = message.parent_id ?? null;
    const list = index.get(key);
    if (list) list.push(message);
    else index.set(key, [message]);
  }
  return index;
}

/** Root first. A missing parent ends the walk: half a transcript beats none. */
export function pathToLeaf(tree: readonly Message[], leafId: string | null): Message[] {
  if (leafId === null) return [];
  const byId = new Map(tree.map((m) => [m.id, m]));
  const path: Message[] = [];
  const seen = new Set<string>();
  let cursor = byId.get(leafId);
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    path.push(cursor);
    cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined;
  }
  return path.reverse();
}

export function newestLeaf(tree: readonly Message[], fromId: string): string {
  const children = childrenOf(tree);
  let id = fromId;
  for (;;) {
    const next = children.get(id);
    const last = next?.[next.length - 1];
    if (!last) return id;
    id = last.id;
  }
}

/** The leaf to show after stepping `step` siblings away from `messageId`, or null at an end. */
export function switchTarget(tree: readonly Message[], messageId: string, step: -1 | 1): string | null {
  const message = tree.find((m) => m.id === messageId);
  if (!message) return null;
  const siblings = childrenOf(tree).get(message.parent_id ?? null) ?? [];
  const at = siblings.findIndex((m) => m.id === messageId);
  const target = siblings[at + step];
  return target ? newestLeaf(tree, target.id) : null;
}

/** The transcript rows for a path, with sibling positions and, for a summary, what it folded. */
export function transcriptOf(path: readonly Message[], tree: readonly Message[]): TranscriptEntry[] {
  const children = childrenOf(tree.length > 0 ? tree : path);
  return path.map((message) => {
    const siblings = children.get(message.parent_id ?? null) ?? [message];
    const entry: TranscriptEntry = {
      message,
      siblingIndex: Math.max(1, siblings.findIndex((m) => m.id === message.id) + 1),
      siblingCount: Math.max(1, siblings.length),
    };
    const summary = message.parts.find((p): p is SummaryPart => p.type === "summary");
    if (summary?.covers_to) {
      const covered = pathToLeaf(tree, summary.covers_to);
      const from = covered.findIndex((m) => m.id === summary.covers_from);
      entry.originals = from >= 0 ? covered.slice(from) : covered;
    }
    return entry;
  });
}
