import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, lstatSync, existsSync, writeFileSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';

export class DocumentError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface DocumentNote {
  id: string;
  quote: string;
  note: string;
  from: number;
  to: number;
  revision: number;
  kind: 'highlight' | 'reference';
  detached?: boolean;
}

export interface DocumentRecord {
  id: string;
  title: string;
  markdown: string;
  revision: number;
  hash: string;
  notes: DocumentNote[];
  updatedAt: string;
}

export function defaultDocumentRoot(): string {
  return path.join(
    process.platform === 'win32'
      ? (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
      : path.join(os.homedir(), '.local', 'share'),
    'MYAgent',
    'default-workspace',
  );
}

function noLinks(target: string) {
  let current = path.resolve(target);
  for (;;) {
    try {
      if (lstatSync(current).isSymbolicLink()) throw new DocumentError(403, '작업공간의 링크/정션 경로는 허용되지 않습니다.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export class DocumentStore {
  private db: DatabaseSync;

  constructor(public readonly root = defaultDocumentRoot()) {
    if (/^(\\\\|\/\/)/.test(root)) throw new DocumentError(403, '기본 문서 작업공간에는 로컬 디스크가 필요합니다.');
    noLinks(root);
    mkdirSync(root, { recursive: true });
    noLinks(root);
    const probe = path.join(root, `.probe-${randomUUID()}`);
    try {
      writeFileSync(probe, 'probe', { flag: 'wx' });
      if (readFileSync(probe, 'utf8') !== 'probe') throw new Error('읽기 검사 실패');
      renameSync(probe, `${probe}.moved`);
      unlinkSync(`${probe}.moved`);
    } finally {
      for (const file of [probe, `${probe}.moved`]) if (existsSync(file)) unlinkSync(file);
    }
    const dbPath = path.join(root, 'documents.sqlite');
    for (const suffix of ['', '-wal', '-shm', '-journal']) noLinks(dbPath + suffix);
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, session TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS documents_session ON documents(session);
      CREATE TABLE IF NOT EXISTS document_grants (id TEXT NOT NULL, session TEXT NOT NULL, PRIMARY KEY(id,session));
      CREATE TABLE IF NOT EXISTS document_assets (document TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(document,id));
      CREATE TABLE IF NOT EXISTS document_versions (id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(id, revision));`);
  }

  close() {
    this.db.close();
  }

  list(session: string) {
    return (this.db.prepare('SELECT data FROM documents WHERE session=? OR id IN (SELECT id FROM document_grants WHERE session=?) ORDER BY rowid DESC').all(session, session) as { data: string }[]).map((row) => {
      const d = JSON.parse(row.data) as DocumentRecord;
      return { id: d.id, title: d.title, revision: d.revision, updatedAt: d.updatedAt };
    });
  }

  get(session: string, id: string): DocumentRecord {
    const row = this.db.prepare('SELECT data FROM documents WHERE id=? AND (session=? OR id IN (SELECT id FROM document_grants WHERE session=?))').get(id, session, session) as { data: string } | undefined;
    if (!row) throw new DocumentError(404, '이 챗에서 문서를 찾을 수 없습니다.');
    return JSON.parse(row.data);
  }

  versions(session: string, id: string): DocumentRecord[] {
    this.get(session, id);
    return (this.db.prepare('SELECT data FROM document_versions WHERE id=? ORDER BY revision DESC LIMIT 50').all(id) as { data: string }[]).map((r) => JSON.parse(r.data));
  }

  save(session: string, id: string | null, input: { title: string; markdown: string; revision: number; notes?: DocumentNote[] }): DocumentRecord {
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 180 || typeof input.markdown !== 'string' || Buffer.byteLength(input.markdown) > 2_000_000) throw new DocumentError(400, '문서명 또는 본문 크기가 잘못되었습니다. (최대 2MB)');
    if (!Number.isSafeInteger(input.revision)) throw new DocumentError(400, '기준 버전이 필요합니다.');
    if (input.notes !== undefined && (!Array.isArray(input.notes) || input.notes.length > 500 || input.notes.some((n) => !n || typeof n.id !== 'string' || typeof n.quote !== 'string' || typeof n.note !== 'string' || n.quote.length > 20000 || n.note.length > 4000 || !Number.isSafeInteger(n.from) || !Number.isSafeInteger(n.to) || n.from < 0 || n.to < n.from || !Number.isSafeInteger(n.revision) || !['highlight', 'reference'].includes(n.kind)))) throw new DocumentError(400, '참조 형식이 잘못되었습니다.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old = id ? this.get(session, id) : null;
      if (input.revision !== (old?.revision ?? 0)) throw new DocumentError(409, '다른 편집에서 문서가 변경되었습니다. 초안을 다운로드하고 최신본을 확인하세요.');
      const revision = input.revision + 1;
      const notes = (input.notes ?? old?.notes ?? []).map((n) => ({ ...n, detached: n.detached || Boolean(old && old.markdown !== input.markdown && n.revision <= old.revision) }));
      const doc: DocumentRecord = {
        id: id ?? randomUUID(),
        title: input.title.trim(),
        markdown: input.markdown,
        notes,
        revision,
        hash: createHash('sha256').update(input.markdown).digest('hex'),
        updatedAt: new Date().toISOString(),
      };
      const data = JSON.stringify(doc);
      if (old) {
        this.requireOwner(session, doc.id);
        this.db.prepare('UPDATE documents SET revision=?, data=? WHERE id=? AND session=?').run(revision, data, doc.id, session);
      } else {
        this.db.prepare('INSERT INTO documents VALUES (?,?,?,?)').run(doc.id, session, revision, data);
      }
      this.db.prepare('INSERT INTO document_versions VALUES (?,?,?)').run(doc.id, revision, data);
      this.db.exec('COMMIT');
      return doc;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private requireOwner(session: string, id: string) {
    if (!this.ownedBy(session, id)) throw new DocumentError(403, '문서 소유자만 변경할 수 있습니다.');
  }

  ownedBy(scope: string, id: string) {
    return Boolean(this.db.prepare('SELECT 1 FROM documents WHERE session=? AND id=?').get(scope, id));
  }

  share(session: string, id: string, target: string, remove = false) {
    this.requireOwner(session, id);
    if (!/^[a-zA-Z0-9_-]+$/.test(target)) throw new DocumentError(400, '잘못된 대상 챗입니다.');
    if (remove) this.db.prepare('DELETE FROM document_grants WHERE id=? AND session=?').run(id, target);
    else this.db.prepare('INSERT OR IGNORE INTO document_grants VALUES (?,?)').run(id, target);
  }

  moveToProject(session: string, id: string, project: string, revision: number) {
    this.requireOwner(session, id);
    if (!/^[a-zA-Z0-9_-]+$/.test(project)) throw new DocumentError(400, '잘못된 프로젝트입니다.');
    const result = this.db.prepare('UPDATE documents SET session=? WHERE id=? AND session=? AND revision=?').run(`project:${project}`, id, session, revision);
    if (!result.changes) throw new DocumentError(409, '최신 버전에서 이동해 주세요.');
  }

  hasAsset(id: string, asset: string) {
    return Boolean(this.db.prepare('SELECT 1 FROM document_assets WHERE document=? AND id=?').get(id, asset));
  }

  addAsset(session: string, id: string, asset: { id: string; name: string; mime: string; bytes: Buffer }) {
    this.requireOwner(session, id);
    if (!/^[a-zA-Z0-9_-]+$/.test(asset.id) || asset.name.length > 255 || asset.mime.length > 200 || asset.bytes.length > 20_000_000) throw new DocumentError(400, '첨부 형식/크기 오류입니다.');
    const total = this.db.prepare('SELECT COALESCE(SUM(length(bytes)),0) AS size FROM document_assets WHERE document=? AND id<>?').get(id, asset.id) as { size: number };
    if (total.size + asset.bytes.length > 50_000_000) throw new DocumentError(413, '문서 첨부 합계는 50MB 이하입니다.');
    this.db.prepare('INSERT OR REPLACE INTO document_assets VALUES (?,?,?,?,?)').run(id, asset.id, asset.name, asset.mime, asset.bytes);
  }

  bundle(session: string, id: string) {
    this.db.exec('BEGIN');
    try {
      const document = this.get(session, id);
      const attachments = (this.db.prepare('SELECT id,name,mime,bytes FROM document_assets WHERE document=? ORDER BY id').all(id) as unknown as { id: string; name: string; mime: string; bytes: Uint8Array }[]).map((a) => ({
        id: a.id,
        name: a.name,
        mime: a.mime,
        sha256: createHash('sha256').update(a.bytes).digest('hex'),
        base64: Buffer.from(a.bytes).toString('base64'),
      }));
      this.db.exec('COMMIT');
      return { format: 'document-bundle', version: 1, document, attachments };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  deleteSession(session: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const table of ['document_assets', 'document_versions', 'document_grants']) {
        const key = table === 'document_assets' ? 'document' : 'id';
        this.db.prepare(`DELETE FROM ${table} WHERE ${key} IN (SELECT id FROM documents WHERE session=?)`).run(session);
      }
      this.db.prepare('DELETE FROM document_grants WHERE session=?').run(session);
      this.db.prepare('DELETE FROM documents WHERE session=?').run(session);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

let store: DocumentStore | undefined;

export function getDocumentStore() {
  return (store ??= new DocumentStore());
}

export function cleanupSessionDocuments(session: string) {
  if (store || existsSync(path.join(defaultDocumentRoot(), 'documents.sqlite'))) getDocumentStore().deleteSession(session);
}
