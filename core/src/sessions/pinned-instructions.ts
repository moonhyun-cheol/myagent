import { applyUiStatePatch, loadUiState } from '../config/ui-state-store.js';
import type { SessionStore } from './session-store.js';

/**
 * 작업 → 할 일 → 고정 지침. Stored on the conversation record (`SessionRecord.pinned_instructions`)
 * so it travels with the chat in sessions.sqlite and is deleted with it. Core injects it as
 * context each turn; it is never part of message text.
 */
export const MAX_PINNED_INSTRUCTIONS = 12;
export const MAX_PINNED_INSTRUCTION_CHARS = 500;

/** Untrusted input: strings only, trimmed, de-duplicated, count/length capped. */
export function normalizePinnedInstructions(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = [...new Set(
    value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim().slice(0, MAX_PINNED_INSTRUCTION_CHARS))
      .filter(Boolean),
  )].slice(0, MAX_PINNED_INSTRUCTIONS);
  return items.length ? items : undefined;
}

/** Former UI-side storage in data/config/ui-state.json (`{ [sessionId]: string[] }`). */
export const UI_STATE_PINNED_V2_KEY = 'my-agent-pinned-instructions-v2';
/** Older app-wide list; belongs to the conversation that was open last. */
export const UI_STATE_PINNED_V1_KEY = 'my-agent-pinned-instructions-v1';
const UI_STATE_ACTIVE_SESSION_KEY = 'my-agent-workspace-session';

export interface PinnedInstructionsMigration {
  moved: number;
  /** Already had DB instructions — DB wins. */
  kept: number;
  /** Conversation no longer exists. */
  dropped: number;
}

/**
 * One-time move of UI-stored pinned instructions into the session records. Conversations that
 * already have DB instructions keep them. The ui-state keys are removed only after every entry
 * was handled; any throw leaves them in place so the next start retries.
 */
export function migratePinnedInstructionsFromUiState(
  sessionStore: SessionStore,
  uiStateFile: string,
  cqrRoot: string,
): PinnedInstructionsMigration | null {
  const { entries } = loadUiState(uiStateFile);
  const rawV2 = entries[UI_STATE_PINNED_V2_KEY];
  const rawV1 = entries[UI_STATE_PINNED_V1_KEY];
  if (rawV2 === undefined && rawV1 === undefined) return null;

  const map: Record<string, unknown> = {};
  if (rawV2 !== undefined) {
    try {
      const parsed = JSON.parse(rawV2) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) Object.assign(map, parsed);
    } catch { /* unreadable value: nothing to move, still cleared below */ }
  }
  if (rawV1 !== undefined) {
    const target = entries[UI_STATE_ACTIVE_SESSION_KEY]?.trim();
    let legacy: unknown = undefined;
    try { legacy = JSON.parse(rawV1); } catch { legacy = undefined; }
    if (target && !(target in map)) map[target] = legacy;
  }

  const result: PinnedInstructionsMigration = { moved: 0, kept: 0, dropped: 0 };
  for (const [sessionId, items] of Object.entries(map)) {
    const list = normalizePinnedInstructions(items);
    if (!list) continue;
    const rec = sessionStore.load(sessionId);
    if (!rec) { result.dropped++; continue; }
    if (rec.pinned_instructions?.length) { result.kept++; continue; }
    sessionStore.setPinnedInstructions(sessionId, list);
    result.moved++;
  }
  applyUiStatePatch(uiStateFile, { remove: [UI_STATE_PINNED_V2_KEY, UI_STATE_PINNED_V1_KEY] }, cqrRoot);
  return result;
}
