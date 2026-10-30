import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

/** Requests whose response headers take at least this long are logged (env override). */
const DEFAULT_THRESHOLD_MS = 500;
const MAX_LOG_BYTES = 1024 * 1024;
const LOG_NAME = 'slow-requests.log';

let inflight = 0;

function thresholdMs(): number {
  const raw = Number(process.env.MY_AGENT_SLOW_REQUEST_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_THRESHOLD_MS;
}

function appendLine(logsDir: string, line: string): void {
  try {
    mkdirSync(logsDir, { recursive: true });
    const file = path.join(logsDir, LOG_NAME);
    try {
      if (statSync(file).size > MAX_LOG_BYTES) {
        const previous = `${file}.1`;
        rmSync(previous, { force: true });
        renameSync(file, previous);
      }
    } catch {
      /* no log yet */
    }
    appendFileSync(file, `${line}\n`, 'utf8');
  } catch {
    /* diagnostics must never break a request */
  }
}

/**
 * Track time-to-headers for one API request and append a line to logs/slow-requests.log
 * when it exceeds the threshold. Time-to-headers (not total time) is measured so SSE /
 * long-lived streams that answer headers immediately are not reported as slow.
 * `inflight` (requests already running when this one started) separates "this route is
 * slow" from "the single-threaded server was busy with other work".
 */
export function trackSlowRequest(logsDir: string, req: IncomingMessage, res: ServerResponse, pathname: string): void {
  const started = performance.now();
  const startedAt = new Date();
  const concurrent = inflight;
  inflight += 1;
  let headersMs: number | null = null;
  const writeHead = res.writeHead;
  res.writeHead = function patchedWriteHead(this: ServerResponse, ...args: unknown[]) {
    if (headersMs === null) headersMs = performance.now() - started;
    return (writeHead as (...a: unknown[]) => ServerResponse).apply(this, args);
  } as typeof res.writeHead;
  let done = false;
  const finish = (event: 'finish' | 'close') => {
    if (done) return;
    done = true;
    inflight = Math.max(0, inflight - 1);
    const totalMs = performance.now() - started;
    const waitMs = headersMs ?? totalMs;
    if (waitMs < thresholdMs()) return;
    appendLine(logsDir, [
      startedAt.toISOString(),
      req.method ?? 'GET',
      pathname,
      `status=${res.statusCode}`,
      `headers_ms=${Math.round(waitMs)}`,
      `total_ms=${Math.round(totalMs)}`,
      `inflight=${concurrent}`,
      ...(event === 'close' && !res.writableFinished ? ['aborted=1'] : []),
    ].join(' '));
  };
  res.once('finish', () => finish('finish'));
  res.once('close', () => finish('close'));
}
