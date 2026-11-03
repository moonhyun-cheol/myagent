import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * API process lifecycle diagnostics -> `logs/api-runtime.log`.
 *
 * - `crash`: uncaught exception / unhandled rejection that is about to end the process.
 *   Uses `uncaughtExceptionMonitor`, so Node's default crash semantics stay unchanged.
 * - `exit`: normal exit with code and uptime. A missing `exit` line after `start` means the
 *   process was killed from outside (Task Manager, shell kill, power loss).
 * - `event_loop_stall`: the single JS thread was blocked long enough for the UI to look
 *   frozen. Very long gaps are labeled as possible PC sleep instead.
 *
 * Logging must never throw.
 */
export const API_RUNTIME_LOG_NAME = 'api-runtime.log';
const MAX_LOG_BYTES = 1024 * 1024;
const LAG_SAMPLE_MS = 1_000;
const LAG_REPORT_MS = 3_000;
const SUSPEND_GAP_MS = 120_000;
const MAX_STACK_CHARS = 4_000;

let installed = false;

function appendRuntimeLine(logsDir: string, line: string): void {
  try {
    mkdirSync(logsDir, { recursive: true });
    const file = path.join(logsDir, API_RUNTIME_LOG_NAME);
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
    /* diagnostics are best effort */
  }
}

function memoryMb(): string {
  try {
    const m = process.memoryUsage();
    return `rss_mb=${Math.round(m.rss / 1048576)} heap_mb=${Math.round(m.heapUsed / 1048576)}`;
  } catch {
    return 'rss_mb=?';
  }
}

export function describeCrashError(error: unknown): string {
  if (error instanceof Error) {
    const body = error.stack || `${error.name}: ${error.message}`;
    return body.length > MAX_STACK_CHARS ? `${body.slice(0, MAX_STACK_CHARS)}...` : body;
  }
  let text: string;
  try {
    text = JSON.stringify(error) ?? String(error);
  } catch {
    text = String(error);
  }
  return `non-error thrown: ${text}`.slice(0, MAX_STACK_CHARS);
}

/** Classify one sampling gap (exported for tests). */
export function classifyLoopGap(lagMs: number): 'ok' | 'stall' | 'suspend' {
  if (lagMs >= SUSPEND_GAP_MS) return 'suspend';
  if (lagMs >= LAG_REPORT_MS) return 'stall';
  return 'ok';
}

export function installProcessHealthLog(logsDir: string, port?: number): void {
  if (installed) return;
  installed = true;
  const startedAt = Date.now();
  const write = (message: string) =>
    appendRuntimeLine(logsDir, `${new Date().toISOString()} pid=${process.pid} ${message}`);
  const uptime = () => `uptime_s=${Math.round((Date.now() - startedAt) / 1000)}`;

  write(`start node=${process.version} port=${port ?? '?'}`);

  process.on('uncaughtExceptionMonitor', (error, origin) => {
    write(`crash origin=${origin} ${uptime()} ${memoryMb()}\n${describeCrashError(error)}`);
  });
  process.on('exit', (code) => {
    write(`exit code=${code} ${uptime()} ${memoryMb()}`);
  });

  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const lag = now - last - LAG_SAMPLE_MS;
    last = now;
    const kind = classifyLoopGap(lag);
    if (kind === 'stall') write(`event_loop_stall ms=${Math.round(lag)} ${memoryMb()}`);
    else if (kind === 'suspend') write(`event_loop_gap ms=${Math.round(lag)} (PC sleep or long block)`);
  }, LAG_SAMPLE_MS);
  timer.unref?.();
}
