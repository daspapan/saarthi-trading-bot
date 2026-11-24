// Talking to Ollama on this Mac (http://127.0.0.1:11434).
// Every call uses: the JSON schema in `format` (the model can only produce that
// shape), temperature 0 and a fixed seed (same input, same output), no streaming,
// and a 60-second timeout.

export const OLLAMA_TIMEOUT_MS = 60_000;
export const OLLAMA_SEED = 42;

export type ChatRequest = { system: string; user: string; schema: Record<string, unknown> };
export type ChatResult = { text: string; latencyMs: number };
export type ChatFn = (req: ChatRequest) => Promise<ChatResult>;

export class OllamaTimeoutError extends Error {
  constructor(ms: number) {
    super(`Ollama did not answer within ${Math.round(ms / 1000)} s.`);
    this.name = "OllamaTimeoutError";
  }
}

type Timers = { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };

export function ollamaChat(opts: {
  url: string;
  model: string;
  seed?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  timers?: Timers;
  now?: () => number;
}): ChatFn {
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? OLLAMA_TIMEOUT_MS;
  const timers = opts.timers ?? { setTimeout, clearTimeout };
  const now = opts.now ?? Date.now;

  return async ({ system, user, schema }) => {
    const started = now();
    const controller = new AbortController();
    // Our own timer (not AbortSignal.timeout) so tests can use a fake clock.
    let timedOut = false;
    const timer = timers.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const res = await fetchFn(`${opts.url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: opts.model,
          stream: false,
          format: schema,
          options: { temperature: 0, seed: opts.seed ?? OLLAMA_SEED },
          keep_alive: "30m",
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });
      if (!res.ok) throw new Error(`Ollama answered HTTP ${res.status}.`);
      const body = (await res.json()) as { message?: { content?: unknown } };
      const text = body.message?.content;
      if (typeof text !== "string") throw new Error("Ollama's answer had no message content.");
      return { text, latencyMs: now() - started };
    } catch (err) {
      if (timedOut) throw new OllamaTimeoutError(timeoutMs);
      throw err;
    } finally {
      timers.clearTimeout(timer);
    }
  };
}

/** Is Ollama running, and is the model pulled? Plain-language answer for the health strip. */
export async function ollamaStatus(url: string, model: string, fetchFn: typeof fetch = fetch): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetchFn(`${url}/api/tags`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return { ok: false, detail: `Ollama answered HTTP ${res.status}` };
    const body = (await res.json()) as { models?: { name?: string }[] };
    const names = (body.models ?? []).map((m) => m.name ?? "");
    const found = names.some((n) => n === model || n === `${model}:latest`);
    return found ? { ok: true, detail: `Ollama ready (${model})` } : { ok: false, detail: `Model ${model} not pulled. Run: ollama pull ${model}` };
  } catch {
    return { ok: false, detail: `Ollama not reachable at ${url}. Is it running?` };
  }
}
