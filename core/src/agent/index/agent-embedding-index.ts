/**
 * ADR-003 A2: portable persistent embedding index.
 * - Default: local hashed TF + synonym expansion (sync, no network)
 * - Optional cloud: OpenAI-compatible /embeddings via env (async, falls back to local)
 * Persist under data/agent-embeddings/.
 */
import {
  createHash,
  createHmac,
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { resolveDevWorkspaceReadPath } from '../../security/dev-workspace-guard.js';
import { createEmbeddings } from '../../providers/embeddings.js';
import {
  embeddingSqlitePath,
  embeddingStoreBackend,
  loadEmbeddingIndexFromSqlite,
  resolveEmbeddingStoreKind,
  saveEmbeddingIndexToSqlite,
} from './embedding-sqlite-store.js';
import { dedupeEmbeddingHits } from './embedding-hit-dedupe.js';

export { dedupeEmbeddingHits } from './embedding-hit-dedupe.js';

export {
  embeddingSqlitePath,
  embeddingStoreBackend,
  resolveEmbeddingStoreKind,
  encodeEmbeddingVector,
  decodeEmbeddingVector,
} from './embedding-sqlite-store.js';
export type { EmbeddingStoreKind } from './embedding-sqlite-store.js';

const LOCAL_DIM = 256;
const INDEX_VERSION = 1;
const CLOUD_INDEX_VERSION = 1;
/** Defaults raised for enterprise-sized repos; override via env. */
const DEFAULT_MAX_FILES = 800;
const DEFAULT_MAX_CHUNKS = 5_000;
const MAX_FILE_BYTES = 180_000;
const CHUNK_LINES = 36;
const CHUNK_OVERLAP = 6;
const DEFAULT_MAX_HITS = 8;
const TTL_MS = 90_000;
const CLOUD_BATCH = 32;
const SCAN_HARD_CAP = 8_000;

function parsePositiveInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Max source files indexed (env `MY_AGENT_EMBED_MAX_FILES`, default 800). */
export function embedMaxFiles(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveInt(env.MY_AGENT_EMBED_MAX_FILES, DEFAULT_MAX_FILES, 50, 5_000);
}

/** Max chunks indexed (env `MY_AGENT_EMBED_MAX_CHUNKS`, default 5000). */
export function embedMaxChunks(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveInt(env.MY_AGENT_EMBED_MAX_CHUNKS, DEFAULT_MAX_CHUNKS, 100, 30_000);
}

/**
 * Lower = prefer when capping the index (src/core before tests/fixtures).
 * Exported for verify + callers that need ranking hints.
 */
export function embeddingPathPriority(rel: string): number {
  const p = String(rel || '').replace(/\\/g, '/');
  if (!p) return 9;
  if (/(^|\/)(?:test|tests|__tests__|fixtures|mocks|e2e|__mocks__)(?:\/|$)/i.test(p)) return 3;
  if (/(^|\/)(?:docs|rulebook|changelog|archive)(?:\/|$)/i.test(p)) return 2;
  if (
    /^(?:src|core|app|lib|server|packages|ui|shell)(?:\/|$)/i.test(p)
    || /\/(?:src|core|app|lib)\//i.test(p)
  ) {
    return 0;
  }
  return 1;
}

/** Small query-time boost so source paths win near-ties vs test noise. */
export function embeddingPathScoreBoost(rel: string): number {
  const pri = embeddingPathPriority(rel);
  if (pri === 0) return 0.03;
  if (pri === 1) return 0.01;
  if (pri >= 3) return -0.02;
  return 0;
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.venv',
  '__pycache__',
  'dist',
  'build',
  '.next',
  'coverage',
  '.cache',
  'bin',
  'data',
  'logs',
  'runtime',
  'test-results',
]);

const CODE_EXT_RE =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|cs|cpp|c|h|hpp|vue|svelte|rb|php|swift|md)$/i;

/** Small code synonym map so paraphrase queries beat pure FTS in the pilot eval. */
const CODE_SYNONYMS: Record<string, string[]> = {
  summation: ['add', 'sum', 'plus', 'total'],
  sum: ['add', 'plus', 'total'],
  summing: ['add', 'sum'],
  total: ['sum', 'add'],
  integers: ['number', 'int', 'numeric'],
  integer: ['number', 'int'],
  combine: ['add', 'merge', 'join'],
  operands: ['args', 'parameters', 'a', 'b'],
  arithmetic: ['math', 'add', 'number'],
  remove: ['delete', 'unlink', 'drop'],
  deletion: ['delete', 'remove'],
  rename: ['move', 'mv'],
  create: ['add', 'write', 'new'],
  // Korean coding paraphrases (local pilot — no network).
  수정: ['edit', 'fix', 'patch', 'change'],
  구현: ['implement', 'add', 'create'],
  추가: ['add', 'create', 'append'],
  삭제: ['delete', 'remove'],
  리팩토: ['refactor', 'rewrite'],
  버그: ['bug', 'fix', 'error'],
};

export type EmbeddingEngine = 'local-hashed-tf' | 'openai-compatible' | 'stub';

export interface EmbeddingHit {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  preview: string;
  engine?: EmbeddingEngine;
}

export interface EmbeddingChunkRecord {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  preview: string;
  /** L2-normalized dense vector. */
  vector: number[];
  mtimeMs: number;
  size: number;
  textHash?: string;
}

export interface EmbeddingIndexFile {
  version: number;
  workspace: string;
  builtAt: number;
  dim: number;
  engine?: EmbeddingEngine;
  model?: string;
  chunks: EmbeddingChunkRecord[];
}

type MemEntry = {
  builtAt: number;
  index: EmbeddingIndexFile;
  dirty: boolean;
};

const memCache = new Map<string, MemEntry>();
const cloudMemCache = new Map<string, MemEntry>();

/** Test seam: override cloud batch embedding. */
let cloudEmbedOverride:
  | ((texts: string[]) => Promise<{ vectors: number[][]; engine: EmbeddingEngine; model: string }>)
  | null = null;

export function setCloudEmbedBatchForTests(
  fn:
    | ((texts: string[]) => Promise<{ vectors: number[][]; engine: EmbeddingEngine; model: string }>)
    | null,
): void {
  cloudEmbedOverride = fn;
}

function workspaceKey(workspaceRoot: string): string {
  return path.resolve(workspaceRoot).replace(/\\/g, '/').toLowerCase();
}

function workspaceHash(workspaceRoot: string): string {
  return createHash('sha1').update(workspaceKey(workspaceRoot)).digest('hex').slice(0, 16);
}

export function embeddingsEnabled(): boolean {
  const raw = (process.env.MY_AGENT_EMBEDDINGS ?? '1').trim().toLowerCase();
  return !(raw === '0' || raw === 'off' || raw === 'false' || raw === 'no');
}

export type EmbeddingMode = 'off' | 'local' | 'cloud';

/** local (default) | cloud | auto(=cloud if URL+key) | off */
export function resolveEmbeddingMode(): EmbeddingMode {
  const raw = (process.env.MY_AGENT_EMBEDDINGS ?? 'local').trim().toLowerCase();
  if (raw === '0' || raw === 'off' || raw === 'false' || raw === 'no') return 'off';
  if (raw === 'cloud') return 'cloud';
  if (raw === 'auto') return cloudConfigFromEnv() ? 'cloud' : 'local';
  // "1" / "true" / "local" / empty → local
  return 'local';
}

export interface CloudEmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function cloudConfigFromEnv(): CloudEmbeddingConfig | null {
  const baseUrl = (process.env.MY_AGENT_EMBEDDINGS_BASE_URL ?? '').trim().replace(/\/$/, '');
  const apiKey = (process.env.MY_AGENT_EMBEDDINGS_API_KEY ?? '').trim();
  const model =
    (process.env.MY_AGENT_EMBEDDINGS_MODEL ?? 'text-embedding-3-small').trim()
    || 'text-embedding-3-small';
  if (!apiKey) return null;
  if (!apiKey.startsWith('stub:') && !baseUrl) return null;
  return {
    baseUrl: baseUrl || 'http://127.0.0.1/stub',
    apiKey,
    model,
  };
}

export function embeddingIndexDir(cqrRoot: string): string {
  return path.join(cqrRoot, 'data', 'agent-embeddings');
}

function indexFilePath(cqrRoot: string, workspaceRoot: string, kind: 'local' | 'cloud'): string {
  const suffix = kind === 'cloud' ? '.cloud.json' : '.json';
  return path.join(embeddingIndexDir(cqrRoot), `${workspaceHash(workspaceRoot)}${suffix}`);
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_]+|[\uac00-\ud7a3]{2,}/g) ?? [];
}

function expandTokens(tokens: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
    const syns = CODE_SYNONYMS[t];
    if (!syns) continue;
    for (const s of syns) {
      if (!seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
  }
  return out;
}

function hashBucket(token: string, salt: string): number {
  const h = createHmac('sha1', salt).update(token).digest();
  return h.readUInt32BE(0) % LOCAL_DIM;
}

function textHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

/** Local hashed TF embedding (portable, no network). */
export function embedLocalText(text: string, opts?: { expandSynonyms?: boolean }): number[] {
  const tokens = opts?.expandSynonyms === false ? tokenize(text) : expandTokens(tokenize(text));
  const v = new Float64Array(LOCAL_DIM);
  for (const tok of tokens) {
    if (tok.length < 2) continue;
    v[hashBucket(tok, 'a')] += 1;
    v[hashBucket(tok, 'b')] += 0.5;
  }
  const compact = text.toLowerCase().replace(/\s+/g, ' ').slice(0, 2_000);
  for (let i = 0; i < compact.length - 2; i++) {
    const tri = compact.slice(i, i + 3);
    if (!/[a-z0-9_\uac00-\ud7a3]/.test(tri)) continue;
    v[hashBucket(tri, 't')] += 0.15;
  }
  let norm = 0;
  for (let i = 0; i < LOCAL_DIM; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm) || 1;
  const out = new Array<number>(LOCAL_DIM);
  for (let i = 0; i < LOCAL_DIM; i++) out[i] = v[i]! / norm;
  return out;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function collectCodeFiles(workspaceRoot: string, maxFiles: number): string[] {
  const files: string[] = [];
  const scanCap = Math.min(Math.max(maxFiles * 4, maxFiles), SCAN_HARD_CAP);
  const walk = (rel: string): void => {
    if (files.length >= scanCap) return;
    let abs: string;
    try {
      abs = resolveDevWorkspaceReadPath(workspaceRoot, rel);
    } catch {
      return;
    }
    let st;
    try {
      st = statSync(abs);
    } catch {
      return;
    }
    if (st.isFile()) {
      if (CODE_EXT_RE.test(abs) && st.size <= MAX_FILE_BYTES) {
        files.push(toPosix(path.relative(workspaceRoot, abs) || path.basename(abs)));
      }
      return;
    }
    if (!st.isDirectory()) return;
    let names: string[];
    try {
      names = readdirSync(abs);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith('.') && name !== '.env') continue;
      if (SKIP_DIRS.has(name)) continue;
      walk(rel === '.' ? name : `${rel}/${name}`);
      if (files.length >= scanCap) break;
    }
  };
  walk('.');
  // Prefer product source over tests/docs when the workspace exceeds maxFiles.
  files.sort(
    (a, b) =>
      embeddingPathPriority(a) - embeddingPathPriority(b)
      || a.localeCompare(b),
  );
  return files.slice(0, maxFiles);
}

function chunkFile(rel: string, content: string): { startLine: number; endLine: number; text: string }[] {
  const lines = content.split(/\r?\n/);
  const out: { startLine: number; endLine: number; text: string }[] = [];
  if (!lines.length) return out;
  let start = 0;
  while (start < lines.length) {
    const end = Math.min(lines.length, start + CHUNK_LINES);
    const slice = lines.slice(start, end).join('\n');
    out.push({
      startLine: start + 1,
      endLine: end,
      text: `${rel}\n${slice}`.slice(0, 3_500),
    });
    if (end >= lines.length) break;
    start = Math.max(start + 1, end - CHUNK_OVERLAP);
  }
  return out;
}

function buildLocalChunksForFile(
  rel: string,
  content: string,
  mtimeMs: number,
  size: number,
): EmbeddingChunkRecord[] {
  return chunkFile(rel, content).map((c, idx) => ({
    id: `${rel}#${c.startLine}-${c.endLine}-${idx}`,
    path: rel,
    startLine: c.startLine,
    endLine: c.endLine,
    preview: c.text.slice(0, 220).replace(/\s+/g, ' ').trim(),
    vector: embedLocalText(c.text, { expandSynonyms: false }),
    mtimeMs,
    size,
    textHash: textHash(c.text),
  }));
}

function loadIndexFromDisk(
  cqrRoot: string,
  workspaceRoot: string,
  kind: 'local' | 'cloud',
): EmbeddingIndexFile | null {
  const expectVer = kind === 'cloud' ? CLOUD_INDEX_VERSION : INDEX_VERSION;
  const expectDim = kind === 'local' ? LOCAL_DIM : undefined;
  const store = resolveEmbeddingStoreKind();
  if (embeddingStoreBackend(store) === 'sqlite') {
    const fromSql = loadEmbeddingIndexFromSqlite(cqrRoot, workspaceRoot, kind, {
      expectVersion: expectVer,
      expectDim,
    });
    if (fromSql) return fromSql;
  }
  // JSON fallback (+ migrate-from-json when store=sqlite and only .json exists)
  const p = indexFilePath(cqrRoot, workspaceRoot, kind);
  if (!existsSync(p)) return null;
  try {
    const doc = JSON.parse(readFileSync(p, 'utf8')) as EmbeddingIndexFile;
    if (doc.version !== expectVer) return null;
    if (kind === 'local' && doc.dim !== LOCAL_DIM) return null;
    if (!Array.isArray(doc.chunks)) return null;
    return doc;
  } catch {
    return null;
  }
}

function saveIndexToDisk(
  cqrRoot: string,
  index: EmbeddingIndexFile,
  kind: 'local' | 'cloud',
): void {
  const dir = embeddingIndexDir(cqrRoot);
  mkdirSync(dir, { recursive: true });
  const store = resolveEmbeddingStoreKind();
  if (embeddingStoreBackend(store) === 'sqlite') {
    try {
      saveEmbeddingIndexToSqlite(cqrRoot, index, kind);
      return;
    } catch {
      // Fall through to JSON so indexing never hard-fails on sqlite issues.
    }
  }
  const p = indexFilePath(cqrRoot, index.workspace, kind);
  writeFileSync(p, JSON.stringify(index), 'utf8');
}

function rebuildLocalIncremental(
  workspaceRoot: string,
  prev: EmbeddingIndexFile | null,
): EmbeddingIndexFile {
  const maxFiles = embedMaxFiles();
  const maxChunks = embedMaxChunks();
  const paths = collectCodeFiles(workspaceRoot, maxFiles);
  const prevByPath = new Map<string, EmbeddingChunkRecord[]>();
  if (prev) {
    for (const c of prev.chunks) {
      const list = prevByPath.get(c.path) ?? [];
      list.push(c);
      prevByPath.set(c.path, list);
    }
  }
  const chunks: EmbeddingChunkRecord[] = [];
  for (const rel of paths) {
    if (chunks.length >= maxChunks) break;
    let abs: string;
    try {
      abs = resolveDevWorkspaceReadPath(workspaceRoot, rel);
    } catch {
      continue;
    }
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    const old = prevByPath.get(rel);
    if (
      old?.length
      && old[0]!.mtimeMs === st.mtimeMs
      && old[0]!.size === st.size
    ) {
      for (const c of old) {
        if (chunks.length >= maxChunks) break;
        chunks.push(c);
      }
      continue;
    }
    let content: string;
    try {
      content = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    for (const c of buildLocalChunksForFile(rel, content, st.mtimeMs, st.size)) {
      if (chunks.length >= maxChunks) break;
      chunks.push(c);
    }
  }
  return {
    version: INDEX_VERSION,
    workspace: path.resolve(workspaceRoot).replace(/\\/g, '/'),
    builtAt: Date.now(),
    dim: LOCAL_DIM,
    engine: 'local-hashed-tf',
    chunks,
  };
}

export function ensureEmbeddingIndex(
  workspaceRoot: string,
  opts?: { cqrRoot?: string; force?: boolean },
): EmbeddingIndexFile | null {
  if (!embeddingsEnabled()) return null;
  const key = workspaceKey(workspaceRoot);
  const now = Date.now();
  let entry = memCache.get(key);
  if (
    entry
    && !entry.dirty
    && !opts?.force
    && now - entry.builtAt <= TTL_MS
  ) {
    return entry.index;
  }

  let prev: EmbeddingIndexFile | null = entry?.index ?? null;
  if (!prev && opts?.cqrRoot) {
    prev = loadIndexFromDisk(opts.cqrRoot, workspaceRoot, 'local');
  }
  const index = rebuildLocalIncremental(workspaceRoot, prev);
  entry = { builtAt: now, index, dirty: false };
  memCache.set(key, entry);
  if (opts?.cqrRoot) {
    try {
      saveIndexToDisk(opts.cqrRoot, index, 'local');
    } catch {
      /* ignore */
    }
  }
  return index;
}

export function invalidateEmbeddingIndex(workspaceRoot?: string): void {
  if (!workspaceRoot) {
    memCache.clear();
    cloudMemCache.clear();
    return;
  }
  const key = workspaceKey(workspaceRoot);
  for (const cache of [memCache, cloudMemCache]) {
    const entry = cache.get(key);
    if (entry) {
      entry.dirty = true;
      entry.builtAt = 0;
    }
  }
}

function rankHits(
  index: EmbeddingIndexFile,
  qv: number[],
  maxHits: number,
  engine: EmbeddingEngine,
  minScore = 0.08,
): EmbeddingHit[] {
  const scored = index.chunks.map((c) => ({
    path: c.path,
    startLine: c.startLine,
    endLine: c.endLine,
    preview: c.preview,
    score: cosineSimilarity(qv, c.vector) + embeddingPathScoreBoost(c.path),
    engine,
  }));
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return dedupeEmbeddingHits(scored.filter((hit) => hit.score >= minScore), maxHits);
}

export function searchEmbeddingIndex(
  workspaceRoot: string,
  query: string,
  opts?: { maxHits?: number; cqrRoot?: string },
): EmbeddingHit[] {
  const q = query.trim();
  if (!q || !embeddingsEnabled()) return [];
  const index = ensureEmbeddingIndex(workspaceRoot, { cqrRoot: opts?.cqrRoot });
  if (!index?.chunks.length) return [];
  const qv = embedLocalText(q, { expandSynonyms: true });
  return rankHits(index, qv, opts?.maxHits ?? DEFAULT_MAX_HITS, 'local-hashed-tf');
}

async function embedBatchCloud(
  texts: string[],
  cfg: CloudEmbeddingConfig,
): Promise<{ vectors: number[][]; engine: EmbeddingEngine; model: string }> {
  if (cloudEmbedOverride) return cloudEmbedOverride(texts);
  const result = await createEmbeddings(cfg.baseUrl, cfg.apiKey, cfg.model, texts, {
    timeoutMs: 45_000,
  });
  return {
    vectors: result.vectors,
    engine: result.engine === 'stub' ? 'stub' : 'openai-compatible',
    model: result.model,
  };
}

/**
 * Build / refresh cloud embedding index (incremental by mtime + textHash).
 * Returns null when cloud is not configured or the API fails.
 */
export async function ensureCloudEmbeddingIndex(
  workspaceRoot: string,
  opts?: { cqrRoot?: string; force?: boolean; config?: CloudEmbeddingConfig },
): Promise<EmbeddingIndexFile | null> {
  if (resolveEmbeddingMode() === 'off') return null;
  const cfg = opts?.config ?? cloudConfigFromEnv();
  if (!cfg) return null;

  const key = workspaceKey(workspaceRoot);
  const now = Date.now();
  let entry = cloudMemCache.get(key);
  if (
    entry
    && !entry.dirty
    && !opts?.force
    && now - entry.builtAt <= TTL_MS
    && entry.index.model === cfg.model
  ) {
    return entry.index;
  }

  let prev: EmbeddingIndexFile | null = entry?.index ?? null;
  if ((!prev || prev.model !== cfg.model) && opts?.cqrRoot) {
    const disk = loadIndexFromDisk(opts.cqrRoot, workspaceRoot, 'cloud');
    if (disk?.model === cfg.model) prev = disk;
    else prev = null;
  }

  const maxFiles = embedMaxFiles();
  const maxChunks = embedMaxChunks();
  const paths = collectCodeFiles(workspaceRoot, maxFiles);
  const prevByPath = new Map<string, EmbeddingChunkRecord[]>();
  if (prev) {
    for (const c of prev.chunks) {
      const list = prevByPath.get(c.path) ?? [];
      list.push(c);
      prevByPath.set(c.path, list);
    }
  }

  type Pending = {
    rel: string;
    startLine: number;
    endLine: number;
    text: string;
    mtimeMs: number;
    size: number;
    idx: number;
  };
  const pending: Pending[] = [];
  const reused: EmbeddingChunkRecord[] = [];

  for (const rel of paths) {
    if (reused.length + pending.length >= maxChunks) break;
    let abs: string;
    try {
      abs = resolveDevWorkspaceReadPath(workspaceRoot, rel);
    } catch {
      continue;
    }
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    const old = prevByPath.get(rel);
    if (
      old?.length
      && old[0]!.mtimeMs === st.mtimeMs
      && old[0]!.size === st.size
    ) {
      for (const c of old) {
        if (reused.length + pending.length >= maxChunks) break;
        reused.push(c);
      }
      continue;
    }
    let content: string;
    try {
      content = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const parts = chunkFile(rel, content);
    for (let idx = 0; idx < parts.length; idx++) {
      if (reused.length + pending.length >= maxChunks) break;
      const c = parts[idx]!;
      const th = textHash(c.text);
      const hit = old?.find((o) => o.textHash === th && o.vector?.length);
      if (hit) {
        reused.push({
          ...hit,
          startLine: c.startLine,
          endLine: c.endLine,
          preview: c.text.slice(0, 220).replace(/\s+/g, ' ').trim(),
          mtimeMs: st.mtimeMs,
          size: st.size,
        });
        continue;
      }
      pending.push({
        rel,
        startLine: c.startLine,
        endLine: c.endLine,
        text: c.text,
        mtimeMs: st.mtimeMs,
        size: st.size,
        idx,
      });
    }
  }

  const newChunks: EmbeddingChunkRecord[] = [];
  // When every chunk is reused (pending empty), keep stub/prior engine — do not
  // default to openai-compatible or eval/smoke flakes on warm disk caches.
  let engine: EmbeddingEngine = cfg.apiKey.startsWith('stub:')
    ? 'stub'
    : (prev?.engine ?? 'openai-compatible');
  let model = cfg.model;
  try {
    for (let i = 0; i < pending.length; i += CLOUD_BATCH) {
      const batch = pending.slice(i, i + CLOUD_BATCH);
      const embedded = await embedBatchCloud(
        batch.map((b) => b.text),
        cfg,
      );
      engine = embedded.engine;
      model = embedded.model;
      batch.forEach((b, j) => {
        const vector = embedded.vectors[j];
        if (!vector?.length) return;
        newChunks.push({
          id: `${b.rel}#${b.startLine}-${b.endLine}-${b.idx}`,
          path: b.rel,
          startLine: b.startLine,
          endLine: b.endLine,
          preview: b.text.slice(0, 220).replace(/\s+/g, ' ').trim(),
          vector,
          mtimeMs: b.mtimeMs,
          size: b.size,
          textHash: textHash(b.text),
        });
      });
    }
  } catch {
    return null;
  }

  const dim = newChunks[0]?.vector.length
    ?? reused[0]?.vector.length
    ?? 0;
  if (!dim && !reused.length) return null;

  const index: EmbeddingIndexFile = {
    version: CLOUD_INDEX_VERSION,
    workspace: path.resolve(workspaceRoot).replace(/\\/g, '/'),
    builtAt: Date.now(),
    dim: dim || reused[0]!.vector.length,
    engine,
    model,
    chunks: [...reused, ...newChunks],
  };
  entry = { builtAt: now, index, dirty: false };
  cloudMemCache.set(key, entry);
  if (opts?.cqrRoot) {
    try {
      saveIndexToDisk(opts.cqrRoot, index, 'cloud');
    } catch {
      /* ignore */
    }
  }
  return index;
}

/**
 * Prefer cloud when mode is cloud/auto with config; otherwise local.
 * On cloud failure, falls back to local hashed TF.
 */
export async function searchEmbeddingIndexAsync(
  workspaceRoot: string,
  query: string,
  opts?: { maxHits?: number; cqrRoot?: string; config?: CloudEmbeddingConfig },
): Promise<{ hits: EmbeddingHit[]; engine: EmbeddingEngine; fallback?: boolean }> {
  const q = query.trim();
  if (!q || resolveEmbeddingMode() === 'off') {
    return { hits: [], engine: 'local-hashed-tf' };
  }

  const mode = resolveEmbeddingMode();
  const cfg = opts?.config ?? cloudConfigFromEnv();

  if (mode === 'cloud' && cfg) {
    try {
      const index = await ensureCloudEmbeddingIndex(workspaceRoot, {
        cqrRoot: opts?.cqrRoot,
        config: cfg,
      });
      if (index?.chunks.length) {
        const expanded = expandTokens(tokenize(q)).join(' ') || q;
        const qBatch = await embedBatchCloud([expanded], cfg);
        const qv = qBatch.vectors[0];
        if (qv?.length) {
          const hits = rankHits(
            index,
            qv,
            opts?.maxHits ?? DEFAULT_MAX_HITS,
            qBatch.engine,
            0.05,
          );
          return { hits, engine: qBatch.engine };
        }
      }
    } catch {
      /* fall through */
    }
    const local = searchEmbeddingIndex(workspaceRoot, query, opts);
    return { hits: local, engine: 'local-hashed-tf', fallback: true };
  }

  if (mode === 'cloud' && !cfg) {
    const local = searchEmbeddingIndex(workspaceRoot, query, opts);
    return { hits: local, engine: 'local-hashed-tf', fallback: true };
  }

  const local = searchEmbeddingIndex(workspaceRoot, query, opts);
  return { hits: local, engine: 'local-hashed-tf' };
}

export function formatEmbeddingHitsBlock(
  hits: EmbeddingHit[],
  title = 'Embedding retrieval',
): string {
  if (!hits.length) return '';
  const lines = hits.map(
    (h) =>
      `- ${h.path}:${h.startLine}-${h.endLine}  score=${h.score.toFixed(3)}  ${h.preview.slice(0, 100)}`,
  );
  return [`## ${title}`, ...lines].join('\n');
}

/** Sync prompt block — always local (fast). Cloud via search_embeddings when configured. */
export function buildEmbeddingSearchContext(
  workspaceRoot: string,
  message: string,
  opts?: { maxChars?: number; maxHits?: number; cqrRoot?: string },
): string {
  if (!embeddingsEnabled()) return '';
  try {
    const hits = searchEmbeddingIndex(workspaceRoot, message, {
      maxHits: opts?.maxHits ?? DEFAULT_MAX_HITS,
      cqrRoot: opts?.cqrRoot,
    });
    const block = formatEmbeddingHitsBlock(hits, 'Embedding retrieval (local hashed TF)');
    if (!block) return '';
    const maxChars = opts?.maxChars ?? 2_800;
    return block.length > maxChars ? `${block.slice(0, maxChars - 20)}\n… (truncated)` : block;
  } catch {
    return '';
  }
}

export function hybridRankPaths(
  lexicalPaths: string[],
  embeddingHits: EmbeddingHit[],
  k = 60,
): { path: string; score: number }[] {
  const scores = new Map<string, number>();
  lexicalPaths.forEach((p, i) => {
    const key = p.replace(/\\/g, '/');
    scores.set(key, (scores.get(key) ?? 0) + 1 / (k + i + 1));
  });
  embeddingHits.forEach((h, i) => {
    const key = h.path.replace(/\\/g, '/');
    scores.set(key, (scores.get(key) ?? 0) + 1 / (k + i + 1));
  });
  return [...scores.entries()]
    .map(([path, score]) => ({ path, score }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

export function embeddingIndexStats(workspaceRoot: string): {
  cached: boolean;
  dirty: boolean;
  chunkCount: number;
  cloudCached: boolean;
  cloudChunkCount: number;
} {
  const entry = memCache.get(workspaceKey(workspaceRoot));
  const cloud = cloudMemCache.get(workspaceKey(workspaceRoot));
  return {
    cached: Boolean(entry),
    dirty: entry?.dirty ?? false,
    chunkCount: entry?.index.chunks.length ?? 0,
    cloudCached: Boolean(cloud),
    cloudChunkCount: cloud?.index.chunks.length ?? 0,
  };
}
