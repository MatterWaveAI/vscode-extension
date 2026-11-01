import { Worker } from "node:worker_threads";
import { OUTPUTS } from "../lib/sdk/agent/node";

/**
 * `grep`'s matching, off the extension host's thread. The pattern is the
 * model's, and the model may be repeating what a file told it: a pattern
 * that backtracks catastrophically (`(a+)+$` on a long line of `a`s) would
 * otherwise freeze the extension host -- every extension, Stop included --
 * for as long as the regular expression engine runs. In a worker it is
 * given a deadline per batch of files and terminated when it passes it.
 *
 * The worker only tests lines: the files' lines come split by the SDK's
 * `textLines`, and what it hands back is shown through the SDK's `grepLine`.
 * So that a huge line is not copied back whole, a match comes back cut to
 * TEXT_BOUND characters after its trailing whitespace is dropped (as
 * `grepLine` drops it), with `more` set when there was more: twice
 * `line_max_chars` plus two always holds the code points `grepLine` keeps,
 * and `more` says it must cut there.
 */

/** One batch's matches past this is a pattern to simplify, not a search to wait for. */
export const MATCH_DEADLINE_MS = 5_000;

const TEXT_BOUND = 2 * OUTPUTS.grep.line_max_chars + 2;

export interface FileLines {
  relative: string;
  lines: string[];
}

export interface LineMatch {
  relative: string;
  line: number;
  text: string;
  /** The line went on past `text` (after its trailing whitespace was dropped). */
  more: boolean;
}

export class PatternTooSlow extends Error {
  constructor(readonly relative: string) {
    super(`The pattern took longer than ${MATCH_DEADLINE_MS / 1000}s to search ${relative}: it likely backtracks without end. Simplify it (avoid nested quantifiers such as (a+)+) and search again.`);
  }
}

// Plain CommonJS, evaluated in the worker: the extension ships as one bundle.
// The trailing whitespace is grepLine's: space, tab, CR, FF and VT.
const SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const regex = new RegExp(workerData.source, workerData.flags);
const bound = workerData.bound;
const space = (c) => c === 32 || c === 9 || c === 13 || c === 12 || c === 11;
parentPort.on("message", ({ files, limit }) => {
  const out = [];
  for (const file of files) {
    const lines = file.lines;
    for (let i = 0; i < lines.length && out.length < limit; i++) {
      const line = lines[i];
      if (!regex.test(line)) continue;
      let end = line.length;
      while (end > 0 && space(line.charCodeAt(end - 1))) end--;
      out.push({ relative: file.relative, line: i + 1, text: line.slice(0, Math.min(end, bound)), more: end > bound });
    }
    if (out.length >= limit) break;
  }
  parentPort.postMessage(out);
});
`;

/** A regular expression's matcher in a worker of its own; `close()` when the search is done. */
export class RegexWorker {
  private readonly worker: Worker;
  private failure: Error | null = null;

  constructor(source: string, flags: string) {
    this.worker = new Worker(SOURCE, { eval: true, workerData: { source, flags, bound: TEXT_BOUND } });
    this.worker.on("error", (error) => {
      this.failure = error;
    });
    this.worker.unref();
  }

  /** The matching lines of `files`, at most `limit`; PatternTooSlow past the deadline, an AbortError on `signal`. */
  match(files: FileLines[], limit: number, signal: AbortSignal): Promise<LineMatch[]> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<LineMatch[]>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.worker.off("message", onMessage);
        this.worker.off("error", onError);
      };
      const onMessage = (matches: LineMatch[]) => {
        done();
        resolve(matches);
      };
      const onError = (error: Error) => {
        done();
        reject(error);
      };
      const onAbort = () => {
        done();
        void this.worker.terminate();
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      };
      const timer = setTimeout(() => {
        done();
        void this.worker.terminate();
        reject(new PatternTooSlow(files[0]?.relative ?? "the files"));
      }, MATCH_DEADLINE_MS);
      this.worker.on("message", onMessage);
      this.worker.on("error", onError);
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      this.worker.postMessage({ files, limit });
    });
  }

  close(): void {
    void this.worker.terminate();
  }
}
