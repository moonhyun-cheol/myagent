/**
 * Debug mode log ingest (`POST /debug/ingest/<token>`).
 *
 * Temporary probes in the user's code (browser or Node) send NDJSON/JSON/plain text here; the
 * core appends each record to `<workspace>/.myagent-debug/<session>.ndjson`. One random token
 * per conversation binds the request to that conversation's workspace, so the endpoint can be
 * exempt from the browser Origin guard: it is write-only, bounded, and returns no data.
 * Tokens live in memory only (an app restart issues a new URL).
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { DEBUG_LOG_DIR, ensureDebugLogGitignore } from '../sessions/workspace-scratch-gitignore.js';

export const DEBUG_INGEST_PATH_PREFIX = '/debug/ingest/';
export const DEBUG_INGEST_MAX_BODY_BYTES = 256 * 1024;
const MAX_LINE_CHARS = 8 * 1024;
const MAX_RECORDS_PER_POST = 500;
const MAX_TRACE_BYTES = 5 * 1024 * 1024;
const TOKEN_RE = /^[0-9a-f]{32}$/;
const MARK_SRC = 'mark';
const READ_DEFAULT_MAX = 200;
const READ_HARD_MAX = 1000;
const READ_LINE_CHARS = 2000;

export interface DebugIngestBinding {
  token: string;
  sessionId: string;
  workspaceRoot: string;
}

const byToken = new Map<string, DebugIngestBinding>();
const bySession = new Map<string, string>();
let ingestPort: number | null = null;

/** Called once at API start (null clears, for tests). */
export function configureDebugIngestPort(port: number | null): void {
  ingestPort = port && Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

export function isDebugIngestPath(pathname: string): boolean {
  return pathname.startsWith(DEBUG_INGEST_PATH_PREFIX);
}

export function debugTraceRelPath(sessionId: string): string {
  const safe = String(sessionId || 'default').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'default';
  return `${DEBUG_LOG_DIR}/${safe}.ndjson`;
}

/** Reuse the conversation's token while its workspace is unchanged; otherwise issue a new one. */
export function registerDebugIngest(sessionId: string, workspaceRoot: string): DebugIngestBinding {
  const root = path.resolve(workspaceRoot);
  const prev = bySession.get(sessionId);
  const existing = prev ? byToken.get(prev) : undefined;
  if (existing && existing.workspaceRoot === root) return existing;
  if (prev) byToken.delete(prev);
  const binding: DebugIngestBinding = { token: randomBytes(16).toString('hex'), sessionId, workspaceRoot: root };
  byToken.set(binding.token, binding);
  bySession.set(sessionId, binding.token);
  return binding;
}

export function resolveDebugIngestToken(token: string): DebugIngestBinding | null {
  return TOKEN_RE.test(token) ? byToken.get(token) ?? null : null;
}

export function debugIngestUrl(binding: DebugIngestBinding): string | null {
  return ingestPort ? `http://127.0.0.1:${ingestPort}${DEBUG_INGEST_PATH_PREFIX}${binding.token}` : null;
}

/** JSON array, NDJSON, a single JSON value, or plain text lines → records. */
export function parseDebugIngestBody(raw: string): Record<string, unknown>[] {
  const text = raw.replace(/^\uFEFF/, '').trim();
  if (!text) return [];
  const toRecord = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { msg: v };
  if (text.startsWith('[')) {
    try {
      const arr = JSON.parse(text) as unknown;
      if (Array.isArray(arr)) return arr.slice(0, MAX_RECORDS_PER_POST).map(toRecord);
    } catch {
      /* fall through to line mode */
    }
  }
  const out: Record<string, unknown>[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (out.length >= MAX_RECORDS_PER_POST) break;
    const l = line.trim();
    if (!l) continue;
    try {
      out.push(toRecord(JSON.parse(l)));
    } catch {
      out.push({ msg: l });
    }
  }
  return out;
}

export interface DebugIngestAppendResult {
  accepted: number;
  dropped: number;
  file: string;
}

export function appendDebugIngest(binding: DebugIngestBinding, raw: string, now = Date.now()): DebugIngestAppendResult {
  const rel = debugTraceRelPath(binding.sessionId);
  const abs = path.join(binding.workspaceRoot, rel);
  const records = parseDebugIngestBody(raw);
  if (!records.length) return { accepted: 0, dropped: 0, file: rel };
  mkdirSync(path.dirname(abs), { recursive: true });
  ensureDebugLogGitignore(binding.workspaceRoot);
  let size = 0;
  try {
    size = statSync(abs).size;
  } catch {
    /* new file */
  }
  const lines: string[] = [];
  let dropped = 0;
  for (const rec of records) {
    let line = JSON.stringify({ ts: rec.ts ?? now, ...rec, src: 'ingest' });
    if (line.length > MAX_LINE_CHARS) {
      line = JSON.stringify({ ts: rec.ts ?? now, src: 'ingest', truncated: true, msg: line.slice(0, MAX_LINE_CHARS) });
    }
    const bytes = Buffer.byteLength(line, 'utf8') + 1;
    if (size + bytes > MAX_TRACE_BYTES) {
      dropped += 1;
      continue;
    }
    size += bytes;
    lines.push(line);
  }
  if (lines.length) appendFileSync(abs, `${lines.join('\n')}\n`, 'utf8');
  return { accepted: lines.length, dropped, file: rel };
}

function splitLogLines(abs: string): string[] {
  if (!existsSync(abs)) return [];
  return readFileSync(abs, 'utf8').split(/\r?\n/).filter((l) => l.trim());
}

function markOf(line: string): { ts?: unknown; label?: unknown } | null {
  if (!line.includes(`"src":"${MARK_SRC}"`)) return null;
  try {
    const rec = JSON.parse(line) as Record<string, unknown>;
    return rec && rec.src === MARK_SRC ? rec : null;
  } catch {
    return null;
  }
}

export interface DebugLogMarkResult {
  file: string;
  mark_ts: number;
  records_before: number;
}

/**
 * Append a reproduction boundary. Ingest records always carry `src:"ingest"`, so a probe cannot
 * forge a mark through the HTTP endpoint.
 */
export function markDebugLog(
  workspaceRoot: string,
  sessionId: string,
  label?: string,
  now = Date.now(),
): DebugLogMarkResult {
  const root = path.resolve(workspaceRoot);
  const rel = debugTraceRelPath(sessionId);
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  ensureDebugLogGitignore(root);
  const before = splitLogLines(abs).filter((l) => !markOf(l)).length;
  const rec: Record<string, unknown> = { ts: now, src: MARK_SRC };
  const cleanLabel = String(label ?? '').trim().slice(0, 200);
  if (cleanLabel) rec.label = cleanLabel;
  appendFileSync(abs, `${JSON.stringify(rec)}\n`, 'utf8');
  return { file: rel, mark_ts: now, records_before: before };
}

export interface DebugLogReadOptions {
  /** `mark` (default): only records after the latest mark; `all`: the whole file. */
  since?: 'mark' | 'all';
  /** Case-insensitive substring filter applied to raw lines. */
  contains?: string;
  skip?: number;
  max?: number;
}

/** Plain-text tool body: one meta line, then the selected raw NDJSON lines. */
export function readDebugLog(workspaceRoot: string, sessionId: string, opts: DebugLogReadOptions = {}): string {
  const rel = debugTraceRelPath(sessionId);
  const abs = path.join(path.resolve(workspaceRoot), rel);
  const all = splitLogLines(abs);
  if (!all.length) {
    return `[debug_log_read meta] file=${rel} records=0 — nothing received yet. Check that the probe ran and posts to the Ingest URL (or appends to this file).`;
  }
  let lastMark = -1;
  for (let i = all.length - 1; i >= 0; i -= 1) {
    if (markOf(all[i]!)) {
      lastMark = i;
      break;
    }
  }
  const sinceMark = opts.since !== 'all' && lastMark >= 0;
  const scope = (sinceMark ? all.slice(lastMark + 1) : all).filter((l) => !markOf(l));
  const needle = String(opts.contains ?? '').trim().toLowerCase();
  const matched = needle ? scope.filter((l) => l.toLowerCase().includes(needle)) : scope;
  const skip = Math.max(0, Math.floor(Number(opts.skip) || 0));
  const max = Math.min(READ_HARD_MAX, Math.max(1, Math.floor(Number(opts.max) || READ_DEFAULT_MAX)));
  const page = matched.slice(skip, skip + max);

  const byHypothesis = new Map<string, number>();
  for (const line of matched) {
    try {
      const h = (JSON.parse(line) as Record<string, unknown>).h;
      if (typeof h === 'string' && h) byHypothesis.set(h, (byHypothesis.get(h) ?? 0) + 1);
    } catch {
      /* non-JSON line */
    }
  }
  const mark = lastMark >= 0 ? markOf(all[lastMark]!) : null;
  const markTs = typeof mark?.ts === 'number' ? new Date(mark.ts).toISOString() : String(mark?.ts ?? '');
  const scopeText = sinceMark
    ? `since=mark(${markTs}${typeof mark?.label === 'string' ? ` "${mark.label}"` : ''})`
    : lastMark >= 0
      ? 'since=all'
      : 'since=all(no mark yet — call action=mark before the next reproduction)';
  const meta = [
    `[debug_log_read meta] file=${rel}`,
    scopeText,
    `records=${matched.length}${needle ? ` (filter "${needle}" of ${scope.length})` : ''}`,
    page.length ? `shown=${skip + 1}-${skip + page.length}` : 'shown=0',
    byHypothesis.size ? `h={${[...byHypothesis].map(([k, v]) => `${k}:${v}`).join(', ')}}` : '',
    skip + page.length < matched.length ? `more: skip=${skip + page.length}` : '',
  ].filter(Boolean).join(' ');
  const body = page.map((l) => (l.length > READ_LINE_CHARS ? `${l.slice(0, READ_LINE_CHARS)}…[truncated]` : l));
  return [meta, ...body].join('\n');
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Max-Age': '600',
};

function reply(res: ServerResponse, status: number, body?: unknown): void {
  res.writeHead(status, {
    ...CORS_HEADERS,
    ...(body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
  });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

function readCappedBody(req: IncomingMessage, cap: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      total += c.length;
      if (total > cap) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Route handler; returns false when the path is not an ingest path. */
export async function handleDebugIngestRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
): Promise<boolean> {
  if (!isDebugIngestPath(pathname)) return false;
  if (method === 'OPTIONS') {
    reply(res, 204);
    req.resume();
    return true;
  }
  if (method !== 'POST') {
    reply(res, 405, { error: 'method_not_allowed' });
    req.resume();
    return true;
  }
  const binding = resolveDebugIngestToken(pathname.slice(DEBUG_INGEST_PATH_PREFIX.length));
  if (!binding) {
    reply(res, 404, { error: 'unknown_debug_session' });
    req.resume();
    return true;
  }
  const raw = await readCappedBody(req, DEBUG_INGEST_MAX_BODY_BYTES);
  if (raw === null) {
    reply(res, 413, { error: 'body_too_large', max_bytes: DEBUG_INGEST_MAX_BODY_BYTES });
    return true;
  }
  const r = appendDebugIngest(binding, raw);
  reply(res, 200, { ok: true, accepted: r.accepted, dropped: r.dropped });
  return true;
}

/** System note for Debug mode runs: where probes send their records. */
export function formatDebugIngestNote(binding: DebugIngestBinding): string {
  const url = debugIngestUrl(binding);
  const rel = debugTraceRelPath(binding.sessionId);
  if (!url) {
    return `## Debug log file (this conversation)\nAppend NDJSON records to \`<workspace>/${rel}\`.`;
  }
  return [
    '## Debug log ingest (this conversation)',
    `- Ingest URL: \`${url}\``,
    `- Log file: \`<workspace>/${rel}\` — the app appends every received record there (adds \`ts\` if missing, \`src:"ingest"\`).`,
    '- Body: one JSON object, a JSON array, NDJSON, or plain text lines (max 256KB per POST, 5MB per file).',
    '- Browser code: `fetch(URL, { method: "POST", body: JSON.stringify(rec) }).catch(() => {})` — no Content-Type header keeps it a simple request (no CORS preflight).',
    '- Node/other runtimes: POST the same way, or append the NDJSON line to the log file directly.',
    '- Read it with `debug_log_read` (`action=mark` before each reproduction, then `action=read` for records after the mark).',
    '- The URL is valid only for this conversation while the app runs. It is a temporary probe target: mark those lines with `@myagent-debug` and never commit it.',
  ].join('\n');
}
