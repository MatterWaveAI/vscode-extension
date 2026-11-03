import { describe, expect, it } from "vitest";
import type * as vscode from "vscode";
import type { FimCompletionRequest } from "../src/api/client";
import {
  DEFAULT_FIM_MAX_TOKENS,
  DEFAULT_FIM_STOP,
  extractFimWindow,
  isDeniedDocumentPath,
  MatterWaveInlineCompletionProvider,
} from "../src/inlineCompletions";
import { CancellationTokenSource, Position, TextDocument, Uri } from "./vscode-mock";

describe("extractFimWindow", () => {
  it("splits text into bounded prefix and suffix around the cursor offset", () => {
    const text = "function add(a: number, b: number) {\n  return ;\n}\n";
    const cursor = text.indexOf(";");
    const { prefix, suffix } = extractFimWindow(text, cursor);
    expect(prefix).toBe("function add(a: number, b: number) {\n  return ");
    expect(suffix).toBe(";\n}\n");
  });

  it("caps prefix and suffix to the configured character limits", () => {
    const text = "0123456789ABCDEF";
    const { prefix, suffix } = extractFimWindow(text, 10, 4, 3);
    expect(prefix).toBe("6789");
    expect(suffix).toBe("ABC");
  });
});

describe("isDeniedDocumentPath", () => {
  it("blocks .env and secret key paths while allowing normal source files", () => {
    expect(isDeniedDocumentPath("/workspace/.env")).toBe(true);
    expect(isDeniedDocumentPath("/workspace/.env.local")).toBe(true);
    expect(isDeniedDocumentPath("/workspace/certs/server.pem")).toBe(true);
    expect(isDeniedDocumentPath("/workspace/id_ed25519")).toBe(true);
    expect(isDeniedDocumentPath("/workspace/src/index.ts")).toBe(false);
  });
});

describe("MatterWaveInlineCompletionProvider", () => {
  const dummyContext = {} as vscode.InlineCompletionContext;
  const pos = (line: number, character: number) => new Position(line, character) as unknown as vscode.Position;

  it("returns null when matterwave.inlineCompletions.enabled is false or workspace is untrusted", async () => {
    const calls: FimCompletionRequest[] = [];
    const doc = new TextDocument(Uri.file("/workspace/src/app.ts"), "const x = ", "typescript");
    const cts = new CancellationTokenSource();

    const disabledProvider = new MatterWaveInlineCompletionProvider({
      client: {
        fimComplete: async (req) => {
          calls.push(req);
          return { choices: [{ text: "42;", index: 0, finish_reason: "stop" }] };
        },
      },
      isEnabled: () => false,
      isTrusted: () => true,
      debounceMs: 0,
    });
    expect(await disabledProvider.provideInlineCompletionItems(doc as unknown as vscode.TextDocument, pos(0, 10), dummyContext, cts.token)).toBeNull();

    const untrustedProvider = new MatterWaveInlineCompletionProvider({
      client: {
        fimComplete: async (req) => {
          calls.push(req);
          return { choices: [{ text: "42;", index: 0, finish_reason: "stop" }] };
        },
      },
      isEnabled: () => true,
      isTrusted: () => false,
      debounceMs: 0,
    });
    expect(await untrustedProvider.provideInlineCompletionItems(doc as unknown as vscode.TextDocument, pos(0, 10), dummyContext, cts.token)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("calls fimComplete with prefix, suffix, max_tokens=128, and FIM stop tokens when enabled and trusted", async () => {
    const calls: FimCompletionRequest[] = [];
    const doc = new TextDocument(
      Uri.file("/workspace/src/math.ts"),
      "export function square(n: number) {\n  return \n}\n",
      "typescript",
    );
    const cts = new CancellationTokenSource();

    const provider = new MatterWaveInlineCompletionProvider({
      client: {
        fimComplete: async (req) => {
          calls.push(req);
          return { choices: [{ text: "n * n;", index: 0, finish_reason: "stop" }] };
        },
      },
      isEnabled: () => true,
      isTrusted: () => true,
      getModel: () => "grt-small",
      debounceMs: 5,
    });

    const items = await provider.provideInlineCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(1, 9),
      dummyContext,
      cts.token,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      model: "grt-small",
      prompt: "export function square(n: number) {\n  return ",
      suffix: "\n}\n",
      max_tokens: DEFAULT_FIM_MAX_TOKENS,
      stop: [...DEFAULT_FIM_STOP],
    });
    expect(items).toHaveLength(1);
    expect(items?.[0]?.insertText).toBe("n * n;");
  });

  it("debounces rapid calls so only the latest keystroke triggers /v1/completions", async () => {
    const calls: FimCompletionRequest[] = [];
    const doc = new TextDocument(Uri.file("/workspace/src/app.ts"), "const total = a + b", "typescript");
    const cts = new CancellationTokenSource();

    const provider = new MatterWaveInlineCompletionProvider({
      client: {
        fimComplete: async (req) => {
          calls.push(req);
          return { choices: [{ text: ";", index: 0, finish_reason: "stop" }] };
        },
      },
      isEnabled: () => true,
      isTrusted: () => true,
      debounceMs: 25,
    });

    const first = provider.provideInlineCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(0, 15),
      dummyContext,
      cts.token,
    );
    const second = provider.provideInlineCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(0, 19),
      dummyContext,
      cts.token,
    );

    const [res1, res2] = await Promise.all([first, second]);
    expect(res1).toBeNull();
    expect(res2).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toBe("const total = a + b");
  });

  it("never sends FIM requests for .env or secret files", async () => {
    const calls: FimCompletionRequest[] = [];
    const doc = new TextDocument(Uri.file("/workspace/.env"), "API_KEY=", "plaintext");
    const cts = new CancellationTokenSource();

    const provider = new MatterWaveInlineCompletionProvider({
      client: {
        fimComplete: async (req) => {
          calls.push(req);
          return { choices: [{ text: "secret", index: 0, finish_reason: "stop" }] };
        },
      },
      isEnabled: () => true,
      isTrusted: () => true,
      debounceMs: 0,
    });

    const items = await provider.provideInlineCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(0, 8),
      dummyContext,
      cts.token,
    );
    expect(items).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
