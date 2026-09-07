import type { IncomingMessage, ServerResponse } from 'node:http';

export function clientAbortSignal(req: IncomingMessage, res: ServerResponse): AbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const cleanup = () => {
    req.off('aborted', abort);
    res.off('close', close);
    res.off('finish', cleanup);
  };
  const close = () => {
    if (!res.writableFinished) abort();
    cleanup();
  };
  req.once('aborted', abort);
  res.once('close', close);
  res.once('finish', cleanup);
  if (req.aborted || res.destroyed || (req.destroyed && !req.complete)) abort();
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
