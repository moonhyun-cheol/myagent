/** Tracks detached OpenClaw/automaton sidecar jobs for update idle gate. */

let running = 0;

export function beginAutomatonBackground(): void {
  running += 1;
}

export function endAutomatonBackground(): void {
  running = Math.max(0, running - 1);
}

export async function withAutomatonBackground<T>(fn: () => Promise<T>): Promise<T> {
  beginAutomatonBackground();
  try {
    return await fn();
  } finally {
    endAutomatonBackground();
  }
}

export function isAutomatonBackgroundBusy(): boolean {
  return running > 0;
}

export function countAutomatonBackgroundJobs(): number {
  return running;
}
