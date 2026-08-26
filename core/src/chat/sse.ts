import type { ServerResponse } from 'node:http';

const ssePings = new WeakMap<ServerResponse, ReturnType<typeof setInterval>>();

function clearSsePing(res: ServerResponse): void {
  const iv = ssePings.get(res);
  if (iv) {
    clearInterval(iv);
    ssePings.delete(res);
  }
}

/** Push buffered SSE frames (compression / proxy middleware) — P86 idle fetch flake. */
function flushSse(res: ServerResponse): void {
  const anyRes = res as ServerResponse & { flush?: () => void; flushHeaders?: () => void };
  try {
    if (typeof anyRes.flushHeaders === 'function' && !res.headersSent) anyRes.flushHeaders();
  } catch {
    /* ignore */
  }
  try {
    if (typeof anyRes.flush === 'function') anyRes.flush();
  } catch {
    /* ignore */
  }
}

export function initSse(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': ok\n\n');
  // Immediate ping so clients see traffic before the first LLM gap (P86 early idle).
  try {
    res.write(`data: ${JSON.stringify({ type: 'ping', t: Date.now() })}\n\n`);
    flushSse(res);
  } catch {
    /* ignore */
  }
  // Comment + data ping frames keep the socket alive during long LLM/tool gaps (P86 fetch failed).
  // 8s beats common 15–30s idle proxies; tighter than prior 10s for long secretary turns.
  const iv = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearSsePing(res);
      return;
    }
    try {
      res.write(': ping\n\n');
      // Some clients/proxies ignore SSE comments — also send a data frame (P86 idle drop).
      res.write(`data: ${JSON.stringify({ type: 'ping', t: Date.now() })}\n\n`);
      flushSse(res);
    } catch {
      clearSsePing(res);
    }
  }, 8_000);
  ssePings.set(res, iv);
  res.on('close', () => clearSsePing(res));
}

export function sseEvent(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  flushSse(res);
}

export function sseDone(res: ServerResponse): void {
  clearSsePing(res);
  if (!res.writableEnded) res.end();
}
