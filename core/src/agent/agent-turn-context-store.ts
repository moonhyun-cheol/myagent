/**
 * Byte-exact record of the per-turn context sent with each user request.
 *
 * Provider prompt caches (Claude via OpenRouter Responses) only accept the
 * automatic breakpoint at the request tail, so a later question can reuse the
 * cache only when its prefix equals an earlier request exactly. The "## Turn
 * context" message sent before a user request is otherwise dropped from later
 * history, which changed the prefix on every new question (cache read 0).
 * Replaying the exact recorded context + user content keeps the prefix stable.
 *
 * Stored under data/agent-turn-context/<sessionId>.json (request-scoped data only).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type TurnContextRecord = {
  key: string;
  /** Exact turn context message content. */
  context: string;
  /** Exact user content sent with it (when it was plain text). */
  user?: string;
  at: string;
};

type TurnContextDoc = { version: 1; entries: TurnContextRecord[] };

const MAX_ENTRIES = 80;
/** Very large snapshots are not replayed: keeping them would crowd the history budget. */
export const MAX_REPLAY_CONTEXT_CHARS = 48_000;

function sanitizeSessionKey(sessionId: string): string {
  return String(sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || 'default';
}

export function turnContextStorePath(cqrRoot: string, sessionId: string): string {
  return path.join(cqrRoot, 'data', 'agent-turn-context', `${sanitizeSessionKey(sessionId)}.json`);
}

/** Key = predecessor message timestamp + hash of the user text (stable across turns). */
export function turnContextKey(previousAt: string | undefined | null, userText: string): string {
  const hash = createHash('sha256').update(String(userText ?? '')).digest('hex').slice(0, 24);
  return `${previousAt || 'start'}|${hash}`;
}

function loadDoc(cqrRoot: string, sessionId: string): TurnContextDoc {
  const fp = turnContextStorePath(cqrRoot, sessionId);
  if (!existsSync(fp)) return { version: 1, entries: [] };
  try {
    const doc = JSON.parse(readFileSync(fp, 'utf8')) as Partial<TurnContextDoc>;
    return { version: 1, entries: Array.isArray(doc.entries) ? doc.entries.filter((e) => e && typeof e.key === 'string' && typeof e.context === 'string') : [] };
  } catch {
    return { version: 1, entries: [] };
  }
}

export function loadTurnContextRecords(cqrRoot: string, sessionId: string | undefined): Map<string, TurnContextRecord> {
  const out = new Map<string, TurnContextRecord>();
  if (!sessionId) return out;
  try {
    for (const entry of loadDoc(cqrRoot, sessionId).entries) out.set(entry.key, entry);
  } catch {
    /* replay is an optimization only */
  }
  return out;
}

export function saveTurnContextRecord(
  cqrRoot: string,
  sessionId: string | undefined,
  record: Omit<TurnContextRecord, 'at'>,
): void {
  if (!sessionId || !record.context || record.context.length > MAX_REPLAY_CONTEXT_CHARS) return;
  try {
    const doc = loadDoc(cqrRoot, sessionId);
    const entries = doc.entries.filter((e) => e.key !== record.key);
    entries.push({ ...record, at: new Date().toISOString() });
    const next: TurnContextDoc = { version: 1, entries: entries.slice(-MAX_ENTRIES) };
    const fp = turnContextStorePath(cqrRoot, sessionId);
    mkdirSync(path.dirname(fp), { recursive: true });
    const tmp = `${fp}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next), 'utf8');
    renameSync(tmp, fp);
  } catch {
    /* replay is an optimization only */
  }
}
