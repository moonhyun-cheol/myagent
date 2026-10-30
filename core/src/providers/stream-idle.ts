/**
 * Stream stall detection for model responses.
 *
 * The per-request timeout (10 min for agent steps) covers the whole response, so a stream
 * that stops sending bytes mid-way would otherwise hold a step until that limit. Reads that
 * see no bytes for the idle window are cancelled with a STREAM_IDLE_TIMEOUT error, which the
 * agent step loop treats as a retryable infra timeout.
 *
 * Any bytes reset the window, including SSE keep-alive comments (OpenRouter sends
 * `: OPENROUTER PROCESSING` while a model is thinking). Before the first output delta the
 * window is longer, because some providers stay silent while reasoning without a summary.
 */
export const STREAM_IDLE_TIMEOUT_MS = 120_000;
export const STREAM_FIRST_OUTPUT_IDLE_TIMEOUT_MS = 300_000;

export class StreamIdleTimeoutError extends Error {
  readonly idleMs: number;
  constructor(idleMs: number) {
    super(`STREAM_IDLE_TIMEOUT: no data from the model for ${Math.round(idleMs / 1000)}s`);
    this.name = 'StreamIdleTimeoutError';
    this.idleMs = idleMs;
  }
}

function envMs(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n)) return fallback;
  if (n <= 0) return 0; // 0 disables idle detection
  return Math.min(900_000, Math.max(15_000, Math.floor(n)));
}

/** Idle window for the current read: longer until the first output delta has arrived. */
export function resolveStreamIdleTimeoutMs(sawOutput: boolean, env: NodeJS.ProcessEnv = process.env): number {
  return sawOutput
    ? envMs(env.MY_AGENT_STREAM_IDLE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS)
    : envMs(env.MY_AGENT_STREAM_FIRST_OUTPUT_TIMEOUT_MS, STREAM_FIRST_OUTPUT_IDLE_TIMEOUT_MS);
}

/** reader.read() that rejects with StreamIdleTimeoutError (and cancels the stream) after idleMs of silence. */
export async function readWithIdleTimeout<T>(
  reader: ReadableStreamDefaultReader<T>,
  idleMs: number,
): Promise<ReadableStreamReadResult<T>> {
  if (!(idleMs > 0)) return reader.read();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new StreamIdleTimeoutError(idleMs);
      // Reject before cancelling: cancel() settles the pending read as done, which would win the race.
      reject(error);
      reader.cancel(error).catch(() => { /* already closed */ });
    }, idleMs);
  });
  try {
    return await Promise.race([reader.read(), idle]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
