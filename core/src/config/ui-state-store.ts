import { readFileSync, writeFileSync, existsSync, renameSync, copyFileSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { assertWritablePath } from '../security/path-guard.js';

/**
 * WebView UI preferences that must survive a WebView origin change.
 *
 * localStorage is partitioned per origin (`http://127.0.0.1:{port}`), so when the API
 * port moves (e.g. after an update restart) every value there becomes invisible. These
 * keys are mirrored into `data/config/ui-state.json`, which updates never overwrite.
 * Only allowlisted keys are accepted; the UI keeps localStorage as a fast cache.
 */
export const UI_STATE_KEYS: readonly string[] = [
  'my-agent-workspace-session',
  'my-agent-workspace-pinned-sessions',
  'my-agent-workspace-pinned-nodes',
  'my-agent-pinned-instructions-v1',
  // Per-conversation pinned instructions: `{ [sessionId]: string[] }`.
  'my-agent-pinned-instructions-v2',
  'myagent.minimize-to-tray-on-close',
  'myagent.update-auto-check',
  'myagent.update-poll-interval-ms',
  'my-agent.appearance.v1',
  'my-agent.file-associations.v1',
  'my-agent.conversation-display',
];

const KEY_SET = new Set(UI_STATE_KEYS);
export const UI_STATE_MAX_VALUE_CHARS = 256 * 1024;

export interface UiStateDocument {
  version: 1;
  entries: Record<string, string>;
  /** Keys explicitly removed by the user, so a stale cache on another origin cannot resurrect them. */
  removed: string[];
  updated_at?: string;
}

export interface UiStatePatch {
  set?: Record<string, string>;
  remove?: string[];
}

export class UiStateError extends Error {
  constructor(readonly code: 'UI_STATE_KEY_INVALID' | 'UI_STATE_VALUE_INVALID', message: string) {
    super(message);
  }
}

export function uiStatePath(userConfigPath: string): string {
  return path.join(path.dirname(userConfigPath), 'ui-state.json');
}

export function isUiStateKey(key: string): boolean {
  return KEY_SET.has(key);
}

function emptyDoc(): UiStateDocument {
  return { version: 1, entries: {}, removed: [] };
}

function tryRead(file: string): UiStateDocument | null {
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const doc = raw as Partial<UiStateDocument>;
    const entries: Record<string, string> = {};
    if (doc.entries && typeof doc.entries === 'object' && !Array.isArray(doc.entries)) {
      for (const [key, value] of Object.entries(doc.entries)) {
        if (isUiStateKey(key) && typeof value === 'string') entries[key] = value;
      }
    }
    const removed = Array.isArray(doc.removed)
      ? [...new Set(doc.removed.map(String).filter((key) => isUiStateKey(key) && !(key in entries)))]
      : [];
    return { version: 1, entries, removed, updated_at: typeof doc.updated_at === 'string' ? doc.updated_at : undefined };
  } catch {
    return null;
  }
}

/** Main file, else the last good `.bak` copy (a kill mid-write must not reset preferences). */
export function loadUiState(file: string): UiStateDocument {
  return tryRead(file) ?? tryRead(`${file}.bak`) ?? emptyDoc();
}

export function validateUiStatePatch(input: unknown): UiStatePatch {
  const body = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as {
    set?: unknown;
    remove?: unknown;
  };
  const set: Record<string, string> = {};
  if (body.set !== undefined) {
    if (!body.set || typeof body.set !== 'object' || Array.isArray(body.set)) {
      throw new UiStateError('UI_STATE_VALUE_INVALID', 'set must be an object of string values.');
    }
    for (const [key, value] of Object.entries(body.set as Record<string, unknown>)) {
      if (!isUiStateKey(key)) throw new UiStateError('UI_STATE_KEY_INVALID', `Unsupported UI state key: ${key}`);
      if (typeof value !== 'string' || value.length > UI_STATE_MAX_VALUE_CHARS) {
        throw new UiStateError('UI_STATE_VALUE_INVALID', `Invalid value for ${key}.`);
      }
      set[key] = value;
    }
  }
  const remove: string[] = [];
  if (body.remove !== undefined) {
    if (!Array.isArray(body.remove)) throw new UiStateError('UI_STATE_VALUE_INVALID', 'remove must be an array.');
    for (const key of body.remove.map(String)) {
      if (!isUiStateKey(key)) throw new UiStateError('UI_STATE_KEY_INVALID', `Unsupported UI state key: ${key}`);
      if (!(key in set)) remove.push(key);
    }
  }
  return { set, remove };
}

export function applyUiStatePatch(file: string, patch: UiStatePatch, cqrRoot: string): UiStateDocument {
  const current = loadUiState(file);
  const entries = { ...current.entries };
  const removed = new Set(current.removed);
  let changed = false;
  for (const [key, value] of Object.entries(patch.set ?? {})) {
    if (entries[key] !== value || removed.has(key)) changed = true;
    entries[key] = value;
    removed.delete(key);
  }
  for (const key of patch.remove ?? []) {
    if (key in entries || !removed.has(key)) changed = true;
    delete entries[key];
    removed.add(key);
  }
  const next: UiStateDocument = { version: 1, entries, removed: [...removed], updated_at: current.updated_at };
  if (!changed && existsSync(file)) return next;
  next.updated_at = new Date().toISOString();

  assertWritablePath(file, cqrRoot);
  mkdirSync(path.dirname(file), { recursive: true });
  if (existsSync(file)) {
    if (tryRead(file)) {
      copyFileSync(file, `${file}.bak`);
    } else {
      try {
        copyFileSync(file, `${file}.invalid-${Date.now()}.bak`);
      } catch {
        /* best effort */
      }
    }
  }
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
  return next;
}
