/**
 * The one piece of the SDK's own `src/types.ts` the vendored agent module
 * imports (`agent/modes.ts`: `import type { Tool } from "../types.js"`): the
 * OpenAI function-tool shape `/v1/chat/completions` takes. Kept to what the
 * SDK declares, so the vendored files stay byte-for-byte the SDK's.
 */

export interface ToolFunction {
  name: string;
  description?: string | null;
  parameters?: Record<string, unknown> | null;
  strict?: boolean | null;
}

export interface Tool {
  type: "function";
  function: ToolFunction;
}
