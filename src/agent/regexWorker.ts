import { Worker } from "node:worker_threads";

/**
 * `grep`'s matching, off the extension host's thread. The pattern is the
 * model's, and the model may be repeating what a file told it: a pattern
 * that backtracks catastrophically (`(a+)+$` on a long line of `a`s) would
 * otherwise freeze the extension host -- every extension, Stop included --
 * for as long as the regular expression engine runs. In a worker it is
 * given a deadline per batch of files and terminated when it passes it.
 */

/** One batch's matches past this is a pattern to simplify, not a search to wait for. */
export const MATCH_DEADLINE_MS = 5_000;

export interface FileText {
  relative: string;
  text: string;
}

export interface LineMatch {
  relative: string;
  line: number;
  text: string;
}

export class PatternTooSlow extends Error {
  constructor(readonly relative: string) {
    super(`The pattern took longer than ${MATCH_DEADLINE_MS / 1000}s to search ${relative}: it likely backtracks without end. Simplify it (avoid nested quantifiers such as (a+)+) and search again.`);
  }
}

// Plain CommonJS, evaluated in the worker: the extension ships as one bundle.
const SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const regex = new RegExp(workerData.source, workerData.flags);
parentPort.on("message", ({ files, limit, maxChars }) => {
  const out = [];
  for (const file of files) {
    const lines = file.text.split("\\n");
    for (let i = 0; i < lines.length && out.length < limit; i++) {
      const line = lines[i].endsWith("\\r") ? lines[i].slice(0, -1) : lines[i];
      if (regex.test(line)) out.push({ relative: file.relative, line: i + 1, text: line.length > maxChars ? line.slice(0, maxChars) + "\\u2026" : line });
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
    this.worker = new Worker(SOURCE, { eval: true, workerData: { source, flags } });
    this.worker.on("error", (error) => {
      this.failure = error;
    });
    this.worker.unref();
  }

  /** The matching lines of `files`, at most `limit`; PatternTooSlow past the deadline, an AbortError on `signal`. */
  match(files: FileText[], limit: number, maxChars: number, signal: AbortSignal): Promise<LineMatch[]> {
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
      this.worker.postMessage({ files, limit, maxChars });
    });
  }

  close(): void {
    void this.worker.terminate();
  }
}
