/**
 * Portable sqlite persistence for embedding chunks.
 * Uses Node 22+ `node:sqlite` — no native addon. Brute-force cosine stays in JS.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { EmbeddingChunkRecord, EmbeddingEngine, EmbeddingIndexFile } from './agent-embedding-index.js';

export type EmbeddingStoreKind = 'sqlite' | 'json';

const SCHEMA_VERSION = '1';

export function resolveEmbeddingStoreKind(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingStoreKind {
  const raw = (env.MY_AGENT_EMBED_STORE ?? 'sqlite').trim().toLowerCase();
  if (raw === 'json' || raw === '0' || raw === 'off') return 'json';
  return 'sqlite';
}

/** Effective on-disk engine. */
export function embeddingStoreBackend(kind: EmbeddingStoreKind): 'sqlite' | 'json' {
  if (kind === 'json') return 'json';
  return 'sqlite';
}

export function embeddingSqlitePath(
  cqrRoot: string,
  workspaceRoot: string,
  kind: 'local' | 'cloud',
): string {
  const hash = workspaceHash(workspaceRoot);
  const suffix = kind === 'cloud' ? '.cloud.sqlite' : '.sqlite';
  return path.join(cqrRoot, 'data', 'agent-embeddings', `${hash}${suffix}`);
}

function workspaceHash(workspaceRoot: string): string {
  const key = path.resolve(workspaceRoot).replace(/\\/g, '/').toLowerCase();
  return createHash('sha1').update(key).digest('hex').slice(0, 16);
}

export function encodeEmbeddingVector(vector: number[]): Buffer {
  const f = Float32Array.from(vector);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

export function decodeEmbeddingVector(buf: Buffer, dim: number): number[] {
  if (!buf || buf.byteLength < dim * 4) return [];
  const copy = buf.buffer.slice(buf.byteOffset, buf.byteOffset + dim * 4);
  return Array.from(new Float32Array(copy));
}

function openDb(dbPath: string): DatabaseSync {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      preview TEXT NOT NULL,
      dim INTEGER NOT NULL,
      vector BLOB NOT NULL,
      mtime_ms REAL NOT NULL,
      size INTEGER NOT NULL,
      text_hash TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
  `);
  return db;
}

function metaGet(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value?: string }
    | undefined;
  return typeof row?.value === 'string' ? row.value : null;
}

function metaSet(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

export function loadEmbeddingIndexFromSqlite(
  cqrRoot: string,
  workspaceRoot: string,
  kind: 'local' | 'cloud',
  opts?: { expectDim?: number; expectVersion?: number },
): EmbeddingIndexFile | null {
  const dbPath = embeddingSqlitePath(cqrRoot, workspaceRoot, kind);
  if (!existsSync(dbPath)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = openDb(dbPath);
    if (metaGet(db, 'schema') !== SCHEMA_VERSION) return null;
    const version = Number(metaGet(db, 'version') ?? '');
    if (opts?.expectVersion != null && version !== opts.expectVersion) return null;
    const dim = Number(metaGet(db, 'dim') ?? '');
    if (!Number.isFinite(dim) || dim <= 0) return null;
    if (opts?.expectDim != null && dim !== opts.expectDim) return null;
    const workspace = metaGet(db, 'workspace') ?? path.resolve(workspaceRoot).replace(/\\/g, '/');
    const builtAt = Number(metaGet(db, 'builtAt') ?? Date.now());
    const engine = (metaGet(db, 'engine') ?? 'local-hashed-tf') as EmbeddingEngine;
    const model = metaGet(db, 'model') ?? undefined;
    const rows = db.prepare(
      'SELECT id, path, start_line, end_line, preview, dim, vector, mtime_ms, size, text_hash FROM chunks',
    ).all() as Array<{
      id: string;
      path: string;
      start_line: number;
      end_line: number;
      preview: string;
      dim: number;
      vector: Buffer;
      mtime_ms: number;
      size: number;
      text_hash: string | null;
    }>;
    const chunks: EmbeddingChunkRecord[] = [];
    for (const r of rows) {
      const vector = decodeEmbeddingVector(r.vector, r.dim);
      if (vector.length !== r.dim) continue;
      chunks.push({
        id: r.id,
        path: r.path,
        startLine: r.start_line,
        endLine: r.end_line,
        preview: r.preview,
        vector,
        mtimeMs: r.mtime_ms,
        size: r.size,
        textHash: r.text_hash ?? undefined,
      });
    }
    if (!chunks.length) return null;
    return {
      version: Number.isFinite(version) ? version : 1,
      workspace,
      builtAt: Number.isFinite(builtAt) ? builtAt : Date.now(),
      dim,
      engine,
      model,
      chunks,
    };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

export function saveEmbeddingIndexToSqlite(
  cqrRoot: string,
  index: EmbeddingIndexFile,
  kind: 'local' | 'cloud',
): string {
  const dbPath = embeddingSqlitePath(cqrRoot, index.workspace, kind);
  const db = openDb(dbPath);
  try {
    db.exec('BEGIN');
    db.exec('DELETE FROM chunks');
    metaSet(db, 'schema', SCHEMA_VERSION);
    metaSet(db, 'version', String(index.version));
    metaSet(db, 'workspace', index.workspace);
    metaSet(db, 'builtAt', String(index.builtAt));
    metaSet(db, 'dim', String(index.dim));
    metaSet(db, 'engine', index.engine ?? 'local-hashed-tf');
    if (index.model) metaSet(db, 'model', index.model);
    else {
      db.prepare("DELETE FROM meta WHERE key = 'model'").run();
    }
    const ins = db.prepare(
      `INSERT INTO chunks(id, path, start_line, end_line, preview, dim, vector, mtime_ms, size, text_hash)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const c of index.chunks) {
      if (!Array.isArray(c.vector) || c.vector.length !== index.dim) continue;
      ins.run(
        c.id,
        c.path,
        c.startLine,
        c.endLine,
        c.preview,
        index.dim,
        encodeEmbeddingVector(c.vector),
        c.mtimeMs,
        c.size,
        c.textHash ?? null,
      );
    }
    db.exec('COMMIT');
    return dbPath;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    db.close();
  }
}
