import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: RequestInit["body"];
}

type Handler = (call: Call) => Response | Promise<Response>;

/** A `fetch` that answers from a route table and records every call. */
export function fakeFetch(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const fetchImpl = async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const call: Call = {
      method: init.method ?? "GET",
      url: url.pathname + url.search,
      headers: { ...(init.headers as Record<string, string>) },
      body: init.body,
    };
    calls.push(call);
    const key = `${call.method} ${url.pathname}`;
    const handler = routes[key];
    if (!handler) return json({ detail: `no route ${key}` }, 404);
    return handler(call);
  };
  return { fetch: fetchImpl, calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-Request-Id": "req-test", ...headers },
  });
}

/** An SSE body delivered in small chunks, so frames split across reads. */
export function sse(text: string, chunk = 7): Response {
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunk) controller.enqueue(bytes.slice(i, i + chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream", "X-Request-Id": "req-stream" } });
}

export const MODELS = {
  object: "list",
  default_model: "grt-small",
  data: [
    { id: "grt-small", label: "GRT Small", included: true, upgrade_to: null, partner: false, research_preview: false, supports_vision: false, context_window: 32768 },
    { id: "grt-large", label: "GRT Large", included: false, upgrade_to: "Team", partner: false, research_preview: false, supports_vision: false, context_window: 131072 },
    { id: "partner-x", label: "Partner X", included: true, upgrade_to: null, partner: true, research_preview: false, supports_vision: true, context_window: 200000 },
    { id: "grt-next", label: "GRT Next", included: true, upgrade_to: null, partner: false, research_preview: true, supports_vision: false, context_window: null },
  ],
};

export const CONVERSATION = {
  id: "c_1",
  title: "New chat",
  created_at: "2026-10-18T10:00:00+00:00",
  updated_at: "2026-10-18T10:00:00+00:00",
  last_message_at: null,
  default_model: null,
  current_leaf_message_id: null,
  pinned_at: null,
  archived_at: null,
};
