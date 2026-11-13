import { durableRemoveItem, durableSetItem } from './durableUiState';
import { getStoredSessionId } from '../api/myAgentClient';

/**
 * 작업 → 할 일 → 고정 지침. Scoped to one conversation (session id).
 * Sent as `pinned_instructions`; core injects it as context, never as message text.
 *
 * One durable key holds `{ [sessionId]: string[] }` so the map is mirrored to
 * `data/config/ui-state.json` and survives restarts like other UI state.
 */
export const PINNED_INSTRUCTIONS_KEY = 'my-agent-pinned-instructions-v2';
/** Former app-wide list (leaked into every conversation). Migrated once, then removed. */
export const LEGACY_PINNED_INSTRUCTIONS_KEY = 'my-agent-pinned-instructions-v1';

type PinnedInstructionMap = Record<string, string[]>;

function cleanList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item ?? '').trim()).filter(Boolean) : [];
}

function parseMap(raw: string | null): PinnedInstructionMap {
  try {
    const value = JSON.parse(raw ?? '{}') as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: PinnedInstructionMap = {};
    for (const [sessionId, items] of Object.entries(value as Record<string, unknown>)) {
      const list = cleanList(items);
      if (sessionId && list.length) out[sessionId] = list;
    }
    return out;
  } catch {
    return {};
  }
}

function writeMap(map: PinnedInstructionMap): void {
  try {
    if (Object.keys(map).length) durableSetItem(PINNED_INSTRUCTIONS_KEY, JSON.stringify(map));
    else durableRemoveItem(PINNED_INSTRUCTIONS_KEY);
  } catch {
    // Storage may be unavailable; the in-memory list still updates for this view.
  }
}

/** Move the old global list to the conversation that was open last, then drop it. */
function migrateLegacy(map: PinnedInstructionMap): PinnedInstructionMap {
  let legacyRaw: string | null = null;
  try { legacyRaw = localStorage.getItem(LEGACY_PINNED_INSTRUCTIONS_KEY); } catch { return map; }
  if (legacyRaw === null) return map;
  let legacy: string[] = [];
  try { legacy = cleanList(JSON.parse(legacyRaw)); } catch { legacy = []; }
  let target: string | null = null;
  try { target = getStoredSessionId(); } catch { target = null; }
  let next = map;
  if (legacy.length && target && !map[target]?.length) {
    next = { ...map, [target]: legacy };
    writeMap(next);
  }
  try { durableRemoveItem(LEGACY_PINNED_INSTRUCTIONS_KEY); } catch { /* cache only */ }
  return next;
}

function readMap(): PinnedInstructionMap {
  let raw: string | null = null;
  try { raw = localStorage.getItem(PINNED_INSTRUCTIONS_KEY); } catch { return {}; }
  return migrateLegacy(parseMap(raw));
}

export function loadPinnedInstructions(sessionId: string | null | undefined): string[] {
  if (!sessionId) return [];
  return readMap()[sessionId] ?? [];
}

export function savePinnedInstructions(sessionId: string | null | undefined, items: string[]): void {
  if (!sessionId) return;
  const map = readMap();
  const list = cleanList(items);
  if (list.length) map[sessionId] = list;
  else delete map[sessionId];
  writeMap(map);
}

/** Drop a deleted conversation's instructions so they cannot linger in ui-state.json. */
export function removePinnedInstructions(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  const map = readMap();
  if (!(sessionId in map)) return;
  delete map[sessionId];
  writeMap(map);
}
