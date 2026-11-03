/**
 * Voice dictation helpers for the chat composer (`POST /api/speech/transcribe`).
 */

export interface SpeechTranscription {
  text: string;
}

export interface SpeechTranscriber {
  transcribeAudio(audioBytes: Uint8Array, mimeType?: string, filename?: string): Promise<SpeechTranscription>;
}

export interface DictationL10n {
  t?(message: string, ...args: Array<string | number | boolean>): string;
}

/** Localize a dictation string via `vscode.l10n.t(...)` with a safe fallback when `vscode.l10n?.t` is unavailable. */
export function translateDictation(
  message: string,
  l10n?: DictationL10n,
  ...args: Array<string | number | boolean>
): string {
  if (typeof l10n?.t === "function") {
    return l10n.t(message, ...args);
  }
  return message.replace(/\{(\d+)\}/g, (_match, index: string) => {
    const val = args[Number(index)];
    return val !== undefined ? String(val) : `{${index}}`;
  });
}

/** Localized labels and titles for voice dictation dialogs and composer controls. */
export function dictationStrings(l10n?: DictationL10n): {
  dialogTitle: string;
  openLabel: string;
  audioFilterLabel: string;
  buttonLabel: string;
  buttonTitle: string;
} {
  return {
    dialogTitle: translateDictation("Select an audio recording to transcribe into the composer", l10n),
    openLabel: translateDictation("Transcribe", l10n),
    audioFilterLabel: translateDictation("Audio", l10n),
    buttonLabel: translateDictation("Dictate", l10n),
    buttonTitle: translateDictation("Dictate a prompt using voice transcription", l10n),
  };
}

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/flac": "flac",
};

const EXTENSION_MIMES: Readonly<Record<string, string>> = {
  webm: "audio/webm",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
};

/** Default upload filename derived from an audio MIME type. */
export function defaultAudioFilename(mimeType = "audio/webm"): string {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "audio/webm";
  const ext = MIME_EXTENSIONS[base] ?? "webm";
  return `dictation.${ext}`;
}

/** Infer the audio MIME type from a file path or filename. */
export function audioMimeTypeForPath(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return "audio/webm";
  const ext = filename.slice(dot + 1).trim().toLowerCase();
  return EXTENSION_MIMES[ext] ?? "audio/webm";
}

/**
 * Insert or append a transcribed phrase into the current composer draft,
 * adding a single space when the existing draft does not already end in whitespace.
 */
export function appendDictatedText(draft: string, transcript: string): string {
  const cleaned = transcript.trim();
  if (!cleaned) return draft;
  if (!draft) return cleaned;
  const separator = /\s$/.test(draft) ? "" : " ";
  return `${draft}${separator}${cleaned}`;
}

/** Decode a base64 or data-URI audio payload into raw bytes. */
export function decodeBase64Audio(encoded: string): Uint8Array {
  const comma = encoded.indexOf(",");
  const raw = encoded.startsWith("data:") && comma >= 0 ? encoded.slice(comma + 1) : encoded;
  const normalized = raw.trim();
  if (!normalized) return new Uint8Array(0);
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(normalized, "base64"));
  }
  const binary = atob(normalized);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Build the multipart `FormData` payload expected by `POST /api/speech/transcribe`. */
export function buildSpeechFormData(audioBytes: Uint8Array, mimeType = "audio/webm", filename?: string): FormData {
  const type = mimeType.trim() || "audio/webm";
  const name = filename?.trim() || defaultAudioFilename(type);
  const copy = new Uint8Array(audioBytes.byteLength);
  copy.set(audioBytes);
  const form = new FormData();
  const part = typeof File !== "undefined" ? new File([copy], name, { type }) : new Blob([copy], { type });
  form.append("file", part, name);
  return form;
}

/** Delegate audio transcription to a `MatterWaveClient` (or compatible transcriber). */
export async function transcribeAudio(
  client: SpeechTranscriber,
  audioBytes: Uint8Array,
  mimeType = "audio/webm",
  filename?: string,
): Promise<SpeechTranscription> {
  return client.transcribeAudio(audioBytes, mimeType, filename);
}
