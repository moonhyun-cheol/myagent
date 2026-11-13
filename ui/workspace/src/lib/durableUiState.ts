/**
 * Durable UI preferences.
 *
 * WebView localStorage is partitioned per origin (`http://127.0.0.1:{port}`). When the
 * local API comes back on a different port (e.g. after an update restart) every value
 * stored there becomes invisible: pinned chats, the active chat (and with it the model),
 * app preferences. These keys are mirrored to `data/config/ui-state.json` through the
 * local API; localStorage stays the synchronous cache the rest of the UI reads.
 *
 * Keep this list in sync with core `UI_STATE_KEYS` (core/src/config/ui-state-store.ts).
 */
export const DURABLE_UI_KEYS: readonly string[] = [
  'my-agent-workspace-session',
  'my-agent-workspace-pinned-sessions',
  'my-agent-workspace-pinned-nodes',
  // v1 = former app-wide list, kept only so its migration/removal reaches ui-state.json.
  'my-agent-pinned-instructions-v1',
  'my-agent-pinned-instructions-v2',
  'myagent.minimize-to-tray-on-close',
  'myagent.update-auto-check',
  'myagent.update-poll-interval-ms',
  'my-agent.appearance.v1',
  'my-agent.file-associations.v1',
  'my-agent.conversation-display',
];

const ENDPOINT = '/config/ui-state';
const FLUSH_DELAY_MS = 300;
const durable = new Set(DURABLE_UI_KEYS);
const pendingSet = new Map<string, string>();
const pendingRemove = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let listenersInstalled = false;

function localGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function localSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* cache only */ }
}

function localRemove(key: string): void {
  try { localStorage.removeItem(key); } catch { /* cache only */ }
}

function takePatch(): { set: Record<string, string>; remove: string[] } | null {
  if (pendingSet.size === 0 && pendingRemove.size === 0) return null;
  const patch = { set: Object.fromEntries(pendingSet), remove: [...pendingRemove] };
  pendingSet.clear();
  pendingRemove.clear();
  return patch;
}

function send(patch: { set: Record<string, string>; remove: string[] }, keepalive = false): Promise<void> {
  return fetch(ENDPOINT, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
    keepalive,
  }).then(() => undefined, () => undefined);
}

/** Send queued changes now (used on page hide so the last toggle is not lost). */
export function flushDurableUiState(keepalive = false): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const patch = takePatch();
  return patch ? send(patch, keepalive) : Promise.resolve();
}

function installListeners(): void {
  if (listenersInstalled || typeof window === 'undefined') return;
  listenersInstalled = true;
  window.addEventListener('pagehide', () => { void flushDurableUiState(true); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushDurableUiState(true);
  });
}

function schedule(): void {
  installListeners();
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => { void flushDurableUiState(); }, FLUSH_DELAY_MS);
}

function queueSet(key: string, value: string): void {
  if (!durable.has(key)) return;
  pendingRemove.delete(key);
  pendingSet.set(key, value);
  schedule();
}

function queueRemove(key: string): void {
  if (!durable.has(key)) return;
  pendingSet.delete(key);
  pendingRemove.add(key);
  schedule();
}

/** localStorage.setItem + mirror to data/. Throws like localStorage when the cache write fails. */
export function durableSetItem(key: string, value: string): void {
  queueSet(key, value);
  localStorage.setItem(key, value);
}

/** localStorage.removeItem + remember the removal in data/. */
export function durableRemoveItem(key: string): void {
  queueRemove(key);
  localStorage.removeItem(key);
}

/**
 * Call once before React renders. The file copy wins over the per-origin cache; values
 * only this origin knows (first run after this feature) are migrated up.
 */
export async function hydrateDurableUiState(timeoutMs = 2500): Promise<void> {
  installListeners();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT, { cache: 'no-store', signal: controller.signal });
    if (!res.ok) return;
    const payload = await res.json() as { entries?: Record<string, unknown>; removed?: unknown };
    const entries = payload.entries && typeof payload.entries === 'object' ? payload.entries : {};
    const removed = new Set(Array.isArray(payload.removed) ? payload.removed.map(String) : []);
    for (const key of DURABLE_UI_KEYS) {
      const stored = entries[key];
      const local = localGet(key);
      if (typeof stored === 'string') {
        if (local !== stored) localSet(key, stored);
      } else if (removed.has(key)) {
        if (local !== null) localRemove(key);
      } else if (local !== null) {
        queueSet(key, local);
      }
    }
    await flushDurableUiState();
  } catch {
    // Offline/older core: keep using the local cache.
  } finally {
    clearTimeout(timer);
  }
}
