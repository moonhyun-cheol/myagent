/** Tracks in-flight agent/chat/automation work for update idle gate. */

const active = new Map<string, { label: string; startedAt: number }>();

export function beginActiveWork(key: string, label: string): void {
  active.set(key, { label, startedAt: Date.now() });
}

export function endActiveWork(key: string): void {
  active.delete(key);
}

export async function withActiveWork<T>(
  key: string,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  beginActiveWork(key, label);
  try {
    return await fn();
  } finally {
    endActiveWork(key);
  }
}

export function listActiveWork(): Array<{ key: string; label: string; age_ms: number }> {
  const now = Date.now();
  return [...active.entries()].map(([key, row]) => ({
    key,
    label: row.label,
    age_ms: Math.max(0, now - row.startedAt),
  }));
}

export function isAgentWorkBusy(): boolean {
  return active.size > 0;
}
