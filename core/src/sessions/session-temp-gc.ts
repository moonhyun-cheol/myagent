/**
 * Session temp GC for chat outputs, attachments, and leftover .playwright scratch.
 *
 * Keep files still referenced by remaining chats. Do not cap/delete assets
 * that are still in the visible message window. Capacity limits apply only
 * to shared fetch-cache and unreferenced orphans.
 */
import {
  existsSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { assertWritablePath } from '../security/path-guard.js';
import { removePlaywrightSessionDir } from './workspace-scratch-gitignore.js';
import type { SessionMessage, SessionRecord } from './types.js';

export const OUTPUT_KINDS = ['images', 'research', 'browser', 'crawl', 'web'] as const;
export type OutputKind = (typeof OUTPUT_KINDS)[number];

export const SHARED_OUTPUT_DIR_NAMES = new Set(['fetch-cache']);

export interface SessionTempGcPolicy {
  fetchCacheMaxAgeMs: number;
  fetchCacheMaxBytes: number;
}

export interface SessionTempGcResult {
  removedFiles: number;
  freedBytes: number;
  keptShared: number;
}

export interface LiveTempRefs {
  outputs: Set<string>;
  attachments: Set<string>;
}

const OUTPUT_REF_RE =
  /\/outputs\/(images|research|browser|crawl|web)\/([A-Za-z0-9_-]+)\/([^/\s"'?#>]+)/gi;
const ATTACH_REF_RE =
  /\/attachments\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

const DAY_MS = 24 * 60 * 60 * 1000;

export function resolveSessionTempGcPolicy(
  env: NodeJS.ProcessEnv = process.env,
): SessionTempGcPolicy {
  return {
    fetchCacheMaxAgeMs: parseEnvInt(env.MY_AGENT_FETCH_CACHE_MAX_AGE_DAYS, 7) * DAY_MS,
    fetchCacheMaxBytes: parseEnvInt(env.MY_AGENT_FETCH_CACHE_MAX_MB, 200) * 1024 * 1024,
  };
}

function parseEnvInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function outputRefKey(kind: string, sessionId: string, filename: string): string {
  return `${kind}/${sessionId}/${filename}`;
}

function decodeFilename(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function collectFromText(text: string, into: LiveTempRefs): void {
  if (!text) return;
  OUTPUT_REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OUTPUT_REF_RE.exec(text))) {
    const kind = m[1];
    const sid = m[2];
    const file = decodeFilename(m[3]).replace(/[\\/]/g, '');
    if (kind && sid && file && file !== '..') {
      into.outputs.add(outputRefKey(kind, sid, path.basename(file)));
    }
  }
  ATTACH_REF_RE.lastIndex = 0;
  while ((m = ATTACH_REF_RE.exec(text))) {
    if (m[1]) into.attachments.add(m[1].toLowerCase());
  }
}

export function collectLiveTempRefs(messages: SessionMessage[] | undefined): LiveTempRefs {
  const into: LiveTempRefs = { outputs: new Set(), attachments: new Set() };
  for (const msg of messages ?? []) {
    collectFromText(msg.content || '', into);
    for (const url of msg.image_urls ?? []) collectFromText(url, into);
  }
  return into;
}

export function collectLiveTempRefsFromSessions(
  sessions: SessionRecord[],
  exceptSessionId?: string,
): LiveTempRefs {
  const into: LiveTempRefs = { outputs: new Set(), attachments: new Set() };
  for (const rec of sessions) {
    if (exceptSessionId && rec.id === exceptSessionId) continue;
    const part = collectLiveTempRefs(rec.messages);
    for (const k of part.outputs) into.outputs.add(k);
    for (const k of part.attachments) into.attachments.add(k);
  }
  return into;
}

function removeFile(cqrRoot: string, abs: string): number {
  try {
    assertWritablePath(abs, cqrRoot);
    const bytes = statSync(abs).size;
    unlinkSync(abs);
    return bytes;
  } catch {
    return 0;
  }
}

function rmdirIfEmpty(cqrRoot: string, dir: string): void {
  if (!existsSync(dir)) return;
  try {
    if (readdirSync(dir).length > 0) return;
    assertWritablePath(dir, cqrRoot);
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function pruneKindDir(
  cqrRoot: string,
  kind: OutputKind,
  sessionId: string,
  liveThis: LiveTempRefs,
  liveOthers: LiveTempRefs,
  result: SessionTempGcResult,
): void {
  const dir = path.join(cqrRoot, 'data', 'outputs', kind, sessionId);
  if (!existsSync(dir)) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const abs = path.join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const key = outputRefKey(kind, sessionId, name);
    if (liveOthers.outputs.has(key)) {
      result.keptShared += 1;
      continue;
    }
    if (liveThis.outputs.has(key)) continue;
    const freed = removeFile(cqrRoot, abs);
    if (freed) {
      result.removedFiles += 1;
      result.freedBytes += freed;
    }
  }
  rmdirIfEmpty(cqrRoot, dir);
}

function pruneAttachments(
  cqrRoot: string,
  sessionId: string,
  liveOthers: LiveTempRefs,
  result: SessionTempGcResult,
): void {
  const dir = path.join(cqrRoot, 'data', 'attachments', sessionId);
  if (!existsSync(dir)) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const id = name.split('_')[0]?.toLowerCase();
    if (id && liveOthers.attachments.has(id)) {
      result.keptShared += 1;
      continue;
    }
    const freed = removeFile(cqrRoot, path.join(dir, name));
    if (freed) {
      result.removedFiles += 1;
      result.freedBytes += freed;
    }
  }
  rmdirIfEmpty(cqrRoot, dir);
}

export function pruneSessionTemp(
  cqrRoot: string,
  sessionId: string,
  remainingSessions: SessionRecord[],
  opts?: { dropAttachments?: boolean; workspaceRoot?: string | null },
): SessionTempGcResult {
  const result: SessionTempGcResult = { removedFiles: 0, freedBytes: 0, keptShared: 0 };
  const safe = sessionId.trim();
  if (!safe || SHARED_OUTPUT_DIR_NAMES.has(safe)) return result;

  const self = remainingSessions.find((s) => s.id === safe);
  const liveThis = collectLiveTempRefs(self?.messages);
  const liveOthers = collectLiveTempRefsFromSessions(remainingSessions, safe);

  for (const kind of OUTPUT_KINDS) {
    pruneKindDir(cqrRoot, kind, safe, liveThis, liveOthers, result);
  }
  if (opts?.dropAttachments || !self) {
    pruneAttachments(cqrRoot, safe, liveOthers, result);
  }
  if (!self) {
    removePlaywrightSessionDir(opts?.workspaceRoot, safe);
  }
  return result;
}

/** After the session JSON is gone. */
export function gcDeletedSessionTemp(
  cqrRoot: string,
  sessionId: string,
  remainingSessions: SessionRecord[],
  workspaceRoot?: string | null,
): SessionTempGcResult {
  return pruneSessionTemp(cqrRoot, sessionId, remainingSessions, {
    dropAttachments: true,
    workspaceRoot,
  });
}

function sweepFetchCache(
  cqrRoot: string,
  policy: SessionTempGcPolicy,
  result: SessionTempGcResult,
  now: number,
): void {
  const dir = path.join(cqrRoot, 'data', 'outputs', 'browser', 'fetch-cache');
  if (!existsSync(dir)) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const files: { abs: string; mtimeMs: number; bytes: number }[] = [];
  for (const name of names) {
    const abs = path.join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (now - st.mtimeMs > policy.fetchCacheMaxAgeMs) {
      const freed = removeFile(cqrRoot, abs);
      if (freed) {
        result.removedFiles += 1;
        result.freedBytes += freed;
      }
      continue;
    }
    files.push({ abs, mtimeMs: st.mtimeMs, bytes: st.size });
  }
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = files.reduce((n, f) => n + f.bytes, 0);
  for (const file of files) {
    if (total <= policy.fetchCacheMaxBytes) break;
    const freed = removeFile(cqrRoot, file.abs);
    if (freed) {
      result.removedFiles += 1;
      result.freedBytes += freed;
      total -= file.bytes;
    }
  }
  rmdirIfEmpty(cqrRoot, dir);
}

function listSessionFolderNames(cqrRoot: string): string[] {
  const ids = new Set<string>();
  for (const kind of OUTPUT_KINDS) {
    const rootDir = path.join(cqrRoot, 'data', 'outputs', kind);
    if (!existsSync(rootDir)) continue;
    try {
      for (const e of readdirSync(rootDir, { withFileTypes: true })) {
        if (e.isDirectory() && !SHARED_OUTPUT_DIR_NAMES.has(e.name)) ids.add(e.name);
      }
    } catch {
      /* ignore */
    }
  }
  const attachRoot = path.join(cqrRoot, 'data', 'attachments');
  if (existsSync(attachRoot)) {
    try {
      for (const e of readdirSync(attachRoot, { withFileTypes: true })) {
        if (e.isDirectory()) ids.add(e.name);
      }
    } catch {
      /* ignore */
    }
  }
  return [...ids];
}

export function sweepSessionTemp(
  cqrRoot: string,
  sessions: SessionRecord[],
  opts?: { policy?: SessionTempGcPolicy; now?: number; workspaceRootForSession?: (sessionId: string) => string | null },
): SessionTempGcResult {
  const result: SessionTempGcResult = { removedFiles: 0, freedBytes: 0, keptShared: 0 };
  const policy = opts?.policy ?? resolveSessionTempGcPolicy();
  const now = opts?.now ?? Date.now();
  const known = new Set(sessions.map((s) => s.id));

  for (const sid of listSessionFolderNames(cqrRoot)) {
    const part = pruneSessionTemp(cqrRoot, sid, sessions, {
      dropAttachments: !known.has(sid),
      workspaceRoot: known.has(sid) ? null : opts?.workspaceRootForSession?.(sid),
    });
    result.removedFiles += part.removedFiles;
    result.freedBytes += part.freedBytes;
    result.keptShared += part.keptShared;
  }
  sweepFetchCache(cqrRoot, policy, result, now);
  return result;
}
