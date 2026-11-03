// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { MatterWaveClient } from "../src/api/client";
import { ChatController } from "../src/chat/controller";
import {
  appendDictatedText,
  audioMimeTypeForPath,
  decodeBase64Audio,
  defaultAudioFilename,
  transcribeAudio,
} from "../src/chat/dictation";
import type { HostMessage, ViewState, WebviewMessage } from "../src/chat/protocol";
import { activate, dictatePrompt, formatAgentEngineStatus, selectAgentEngine } from "../src/extension";
import { commands, ExtensionMode, MemorySecrets, Uri, window as vscodeWindow, workspace } from "./vscode-mock";

describe("transcribeAudio (/api/speech/transcribe)", () => {
  it("posts multipart audio bytes to /api/speech/transcribe and returns the transcript", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenAuth = "";
    let seenBody: unknown = null;

    const client = new MatterWaveClient({
      baseUrl: "https://mw.test",
      getToken: async () => "mw_test_token_123456",
      fetch: async (input, init) => {
        seenUrl = String(input);
        seenMethod = init?.method ?? "GET";
        const headers = (init?.headers ?? {}) as Record<string, string>;
        seenAuth = headers.Authorization ?? "";
        seenBody = init?.body ?? null;
        return new Response(JSON.stringify({ text: "Refactor the parser module" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const audioBytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);
    const result = await client.transcribeAudio(audioBytes, "audio/webm;codecs=opus", "voice-note.webm");

    expect(result).toEqual({ text: "Refactor the parser module" });
    expect(seenMethod).toBe("POST");
    expect(seenUrl).toBe("https://mw.test/api/speech/transcribe");
    expect(seenAuth).toBe("Bearer mw_test_token_123456");
    expect(seenBody).toBeInstanceOf(FormData);
    const file = (seenBody as FormData).get("file") as File;
    expect(file).toBeInstanceOf(Blob);
    expect(file.name).toBe("voice-note.webm");
    expect(file.type).toBe("audio/webm;codecs=opus");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(audioBytes);
  });

  it("derives default filenames from MIME types when filename is omitted", async () => {
    let uploadedName = "";
    const client = new MatterWaveClient({
      baseUrl: "https://mw.test",
      getToken: async () => "mw_test_token_123456",
      fetch: async (_input, init) => {
        const file = (init?.body as FormData).get("file") as File;
        uploadedName = file.name;
        return new Response(JSON.stringify({ text: "hello world" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const res = await transcribeAudio(client, new Uint8Array([1, 2, 3]), "audio/wav");
    expect(res).toEqual({ text: "hello world" });
    expect(uploadedName).toBe("dictation.wav");
    expect(defaultAudioFilename("audio/ogg;codecs=opus")).toBe("dictation.ogg");
    expect(defaultAudioFilename("audio/mp4")).toBe("dictation.m4a");
    expect(audioMimeTypeForPath("/tmp/recording.wav")).toBe("audio/wav");
    expect(audioMimeTypeForPath("/tmp/recording.m4a")).toBe("audio/mp4");
    expect(audioMimeTypeForPath("/tmp/recording.mp3")).toBe("audio/mpeg");
  });

  it("formats and decodes dictation helpers cleanly", () => {
    expect(appendDictatedText("", "  write unit tests  ")).toBe("write unit tests");
    expect(appendDictatedText("Please", "check the logs")).toBe("Please check the logs");
    expect(appendDictatedText("Please ", "check the logs")).toBe("Please check the logs");
    expect(appendDictatedText("Existing draft", "   ")).toBe("Existing draft");
    expect(Array.from(decodeBase64Audio("data:audio/webm;base64,AQIDBA=="))).toEqual([1, 2, 3, 4]);
  });
});

describe("composer dictation flow", () => {
  it("transcribes audio in ChatController and posts insertDictation to the webview", async () => {
    const posted: HostMessage[] = [];
    const runCommands: string[] = [];
    const client = new MatterWaveClient({
      baseUrl: "https://mw.test",
      getToken: async () => "mw_test_token_123456",
      fetch: async () =>
        new Response(JSON.stringify({ text: "  Explain how the scheduler works  " }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });

    const controller = new ChatController({
      client,
      post: (m) => posted.push(m),
      isSignedIn: async () => true,
      rememberedModel: { get: () => null, set: () => undefined },
      runCommand: (cmd) => runCommands.push(cmd),
    });

    await controller.handle({ type: "dictate" });
    expect(runCommands).toEqual(["dictatePrompt"]);

    await controller.handle({
      type: "dictate",
      audioBase64: "AQID",
      mimeType: "audio/webm",
      filename: "clip.webm",
    });

    expect(posted).toContainEqual({
      type: "insertDictation",
      text: "Explain how the scheduler works",
    });
  });

  it("inserts and appends dictated text into the webview composer textarea", async () => {
    vi.resetModules();
    document.body.innerHTML = '<div id="app"></div>';
    const sent: WebviewMessage[] = [];
    (globalThis as unknown as { acquireVsCodeApi: () => { postMessage(m: WebviewMessage): void } }).acquireVsCodeApi = () => ({
      postMessage: (m) => sent.push(m),
    });
    await import("../src/webview/main");

    const baseState: ViewState = {
      signedIn: true,
      offline: false,
      identity: "Ada",
      conversations: [],
      archivedConversations: [],
      moreConversations: false,
      moreArchived: false,
      searchResults: null,
      activeId: null,
      transcript: [],
      live: null,
      model: { id: "grt-1", label: "GRT 1" },
      preset: null,
      hasPresets: false,
      meter: null,
      streaming: false,
      error: null,
      notice: null,
      temporary: false,
      source: null,
      instructions: null,
      feedback: {},
      notifications: [],
      notificationsUnreadOnly: false,
      notificationsComplete: true,
      unreadNotifications: 0,
      usage: null,
      agent: null,
      budget: null,
      answerUsage: {},
      announcements: [],
      promptNames: [],
    };

    window.dispatchEvent(new MessageEvent("message", { data: { type: "state", state: baseState } satisfies HostMessage }));

    const textarea = document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
    expect(textarea.value).toBe("");

    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "insertDictation", text: "First dictated phrase." } satisfies HostMessage }),
    );
    expect(textarea.value).toBe("First dictated phrase.");

    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "insertDictation", text: "Second phrase." } satisfies HostMessage }),
    );
    expect(textarea.value).toBe("First dictated phrase. Second phrase.");

    const dictateBtn = Array.from(document.querySelectorAll<HTMLButtonElement>(".composer button")).find(
      (b) => b.textContent === "Dictate",
    );
    expect(dictateBtn).toBeDefined();
    dictateBtn!.click();
    expect(sent).toContainEqual({ type: "dictate" });
  });

  it("runs dictatePrompt from a buffer or open dialog and inserts into the composer", async () => {
    const posted: HostMessage[] = [];
    const client = new MatterWaveClient({
      baseUrl: "https://mw.test",
      getToken: async () => "mw_test_token_123456",
      fetch: async () =>
        new Response(JSON.stringify({ text: "Dictated from file" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const controller = new ChatController({
      client,
      post: (m) => posted.push(m),
      isSignedIn: async () => true,
      rememberedModel: { get: () => null, set: () => undefined },
      runCommand: () => undefined,
    });
    let revealed = false;
    const view = {
      reveal: () => {
        revealed = true;
      },
    };

    const fileUri = Uri.file("/workspace/sample.wav");
    workspace.files.set(fileUri.toString(), new Uint8Array([82, 73, 70, 70]));
    vscodeWindow.showOpenDialog = (() => Promise.resolve([fileUri])) as unknown as typeof vscodeWindow.showOpenDialog;

    const transcript = await dictatePrompt(controller, view);
    expect(revealed).toBe(true);
    expect(transcript).toBe("Dictated from file");
    expect(posted).toContainEqual({ type: "insertDictation", text: "Dictated from file" });
  });
});

describe("selectAgentEngine and formatAgentEngineStatus", () => {
  beforeEach(() => {
    commands.registered.clear();
    workspace.settings.clear();
    workspace.settings.set("matterwave.baseUrl", "https://mw.test");
  });

  it("switches matterwave.agent.engine between auto, pi, and builtin", async () => {
    expect(formatAgentEngineStatus("auto", true)).toBe("Pi 1.0 (auto)");
    expect(formatAgentEngineStatus("auto", false)).toBe("Built-in (auto fallback)");
    expect(formatAgentEngineStatus("pi", true)).toBe("Pi 1.0");
    expect(formatAgentEngineStatus("pi", false)).toBe("Pi 1.0 (unavailable)");
    expect(formatAgentEngineStatus("builtin", false)).toBe("Built-in");

    let seenItems: { engine: string; label: string; description: string }[] = [];
    let seenTitle = "";
    vscodeWindow.showQuickPick = ((items: { engine: string; label: string; description: string }[], options?: { title?: string }) => {
      seenItems = items;
      seenTitle = options?.title ?? "";
      return Promise.resolve(items.find((i) => i.engine === "pi"));
    }) as unknown as typeof vscodeWindow.showQuickPick;

    const chosen = await selectAgentEngine({ probePi: async () => true });
    expect(chosen).toBe("pi");
    expect(seenTitle).toContain("Pi 1.0 (auto)");
    expect(seenItems.map((i) => i.engine)).toEqual(["auto", "pi", "builtin"]);
    expect(workspace.getConfiguration("matterwave.agent").get("engine")).toBe("pi");

    vscodeWindow.showQuickPick = ((items: { engine: string; label: string; description: string }[], options?: { title?: string }) => {
      seenItems = items;
      seenTitle = options?.title ?? "";
      return Promise.resolve(items.find((i) => i.engine === "builtin"));
    }) as unknown as typeof vscodeWindow.showQuickPick;

    const next = await selectAgentEngine({ probePi: async () => false });
    expect(next).toBe("builtin");
    expect(seenTitle).toContain("Pi 1.0 (unavailable)");
    expect(workspace.getConfiguration("matterwave.agent").get("engine")).toBe("builtin");
  });

  it("registers matterwave.selectAgentEngine and matterwave.dictatePrompt on activate", () => {
    const context = {
      extensionMode: ExtensionMode.Production,
      extensionUri: Uri.file("/ext"),
      globalStorageUri: Uri.file("/storage"),
      secrets: new MemorySecrets(),
      globalState: { get: () => undefined, update: () => Promise.resolve(), setKeysForSync: () => undefined },
      workspaceState: { get: () => undefined, update: () => Promise.resolve() },
      subscriptions: [],
    } as unknown as vscode.ExtensionContext;

    activate(context);
    expect(commands.registered.has("matterwave.selectAgentEngine")).toBe(true);
    expect(commands.registered.has("matterwave.dictatePrompt")).toBe(true);
  });
});
