import type { IncomingMessage } from 'node:http';

export function clientAbortSignal(req: IncomingMessage): AbortSignal {
  const controller = new AbortController();
  req.on('close', () => {
    if (!controller.signal.aborted) controller.abort();
  });
  return controller.signal;
}

export function isAbortError(e: unknown): boolean {
  if (e instanceof Error && e.name === 'AbortError') return true;
  if (typeof DOMException !== 'undefined' && e instanceof DOMException && e.name === 'AbortError') {
    return true;
  }
  return false;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}
