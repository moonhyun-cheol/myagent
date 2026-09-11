import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  DocumentError,
  defaultDocumentRoot,
  type DocumentNote,
  type DocumentRecord,
} from './document-store.js';

const MAX_BYTES = 2_000_000;
const MAX_FILES = 1_000;
const SKIP_DIRS = new Set([
  '.git', '.svn', '.my_agent_remote', '.my-agent', '.cqr-pa', '.build', '.tmp',
  'node_modules', 'bin', 'obj', 'dist', 'build', 'out', 'coverage', '.next', '.cache',
]);

export interface ProjectDocumentRecord extends DocumentRecord {
  source: 'project';
  path: string;
  root: string;
}

type MetaRow = {
  id: string;
  root: string;
  path: string;
  revision: number;
  hash: string;
  notes: string;
  updated_at: string;
};

function normalizedRoot(root: string): string {
  if (!root?.trim() || /^(\\\\|\/\/)/.test(root)) {
    throw new DocumentError(403, '문서협업에는 쓰기 가능한 로컬 프로젝트 폴더가 필요합니다.');
  }
  const value = path.resolve(root);
  if (!existsSync(value) || !statSync(value).isDirectory()) {
    throw new DocumentError(404, '프로젝트 작업 폴더를 찾을 수 없습니다.');
  }
  if (lstatSync(value).isSymbolicLink()) {
    throw new DocumentError(403, '링크/정션을 통한 문서 접근은 허용되지 않습니다.');
  }
  return value;
}

function relativeMarkdownPath(value: string): string {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (
    !normalized
    || normalized.length > 240
    || path.posix.isAbsolute(normalized)
    || path.win32.isAbsolute(normalized)
    || normalized.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new DocumentError(400, '프로젝트 루트 기준의 올바른 문서 경로가 필요합니다.');
  }
  if (!/\.(?:md|markdown)$/i.test(normalized)) {
    throw new DocumentError(400, '협업문서는 Markdown(.md, .markdown) 파일이어야 합니다.');
  }
  return normalized;
}

function targetFor(root: string, relative: string): string {
  const target = path.resolve(root, ...relative.split('/'));
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new DocumentError(403, '프로젝트 루트 밖의 문서는 열 수 없습니다.');
  }
  let current = existsSync(target) ? target : path.dirname(target);
  while (current.length >= root.length) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new DocumentError(403, '링크/정션을 통한 문서 접근은 허용되지 않습니다.');
    }
    if (path.normalize(current) === path.normalize(root)) break;
    current = path.dirname(current);
  }
  return target;
}

function hash(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex');
}

function validateNotes(notes: DocumentNote[] | undefined): void {
  if (
    notes !== undefined
    && (
      !Array.isArray(notes)
      || notes.length > 500
      || notes.some((note) => (
        !note
        || typeof note.id !== 'string'
        || typeof note.quote !== 'string'
        || typeof note.note !== 'string'
        || note.quote.length > 20_000
        || note.note.length > 4_000
        || !Number.isSafeInteger(note.from)
        || !Number.isSafeInteger(note.to)
        || note.from < 0
        || note.to < note.from
        || !Number.isSafeInteger(note.revision)
        || !['highlight', 'reference'].includes(note.kind)
      ))
    )
  ) {
    throw new DocumentError(400, '참조 형식이 잘못되었습니다.');
  }
}

export class ProjectDocumentStore {
  private readonly db: DatabaseSync;

  constructor(databasePath = path.join(defaultDocumentRoot(), 'project-documents.sqlite')) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS project_documents (id TEXT PRIMARY KEY, root TEXT NOT NULL, path TEXT NOT NULL, revision INTEGER NOT NULL, hash TEXT NOT NULL, notes TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(root,path));
      CREATE TABLE IF NOT EXISTS project_document_versions (id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(id,revision));`);
  }

  close(): void {
    this.db.close();
  }

  list(projectRoot: string): Array<Pick<ProjectDocumentRecord, 'id' | 'title' | 'path' | 'revision' | 'updatedAt' | 'source'>> {
    const root = normalizedRoot(projectRoot);
    const found: string[] = [];
    const visit = (dir: string) => {
      if (found.length >= MAX_FILES) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (found.length >= MAX_FILES) break;
        if (entry.isSymbolicLink()) continue;
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) visit(absolute);
          continue;
        }
        if (
          entry.isFile()
          && /\.(?:md|markdown)$/i.test(entry.name)
          && statSync(absolute).size <= MAX_BYTES
        ) {
          found.push(path.relative(root, absolute).split(path.sep).join('/'));
        }
      }
    };
    visit(root);
    return found.map((relative) => {
      const doc = this.ensureCurrent(root, relative);
      return {
        id: doc.id,
        title: doc.path,
        path: doc.path,
        revision: doc.revision,
        updatedAt: doc.updatedAt,
        source: 'project' as const,
      };
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.path.localeCompare(b.path));
  }

  get(projectRoot: string, id: string): ProjectDocumentRecord {
    const root = normalizedRoot(projectRoot);
    const row = this.row(id);
    if (!row || path.normalize(row.root) !== path.normalize(root)) {
      throw new DocumentError(404, '현재 프로젝트에서 협업문서를 찾을 수 없습니다.');
    }
    return this.ensureCurrent(root, row.path, row);
  }

  save(
    projectRoot: string,
    id: string | null,
    input: { title: string; markdown: string; revision: number; notes?: DocumentNote[] },
  ): ProjectDocumentRecord {
    const root = normalizedRoot(projectRoot);
    if (
      typeof input.title !== 'string'
      || typeof input.markdown !== 'string'
      || Buffer.byteLength(input.markdown) > MAX_BYTES
      || !Number.isSafeInteger(input.revision)
    ) {
      throw new DocumentError(400, '문서 경로, 본문 또는 기준 버전이 잘못되었습니다. (최대 2MB)');
    }
    validateNotes(input.notes);
    const relative = relativeMarkdownPath(input.title);
    const target = targetFor(root, relative);
    const old = id ? this.get(root, id) : null;
    if (input.revision !== (old?.revision ?? 0)) {
      throw new DocumentError(409, '모델 또는 다른 편집에서 문서가 변경되었습니다. 초안을 보존하고 최신본을 확인하세요.');
    }
    if (!old && existsSync(target)) {
      throw new DocumentError(409, '같은 경로의 문서가 이미 있습니다. 목록에서 해당 문서를 여세요.');
    }
    if (old && old.path !== relative && existsSync(target)) {
      throw new DocumentError(409, '변경할 경로에 문서가 이미 있습니다.');
    }

    mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.my-agent-${randomUUID()}.tmp`;
    const backup = `${target}.my-agent-${randomUUID()}.bak`;
    let backedUp = false;
    try {
      writeFileSync(temp, input.markdown, { encoding: 'utf8', flag: 'wx' });
      if (existsSync(target)) {
        renameSync(target, backup);
        backedUp = true;
      }
      try {
        renameSync(temp, target);
      } catch (error) {
        if (backedUp && !existsSync(target)) renameSync(backup, target);
        backedUp = false;
        throw error;
      }
      if (backedUp) {
        unlinkSync(backup);
        backedUp = false;
      }
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
      if (backedUp && existsSync(backup) && !existsSync(target)) renameSync(backup, target);
      else if (existsSync(backup)) unlinkSync(backup);
    }

    if (old && old.path !== relative) {
      const previous = targetFor(root, old.path);
      if (existsSync(previous)) unlinkSync(previous);
    }
    const revision = input.revision + 1;
    const notes = (input.notes ?? old?.notes ?? []).map((note) => ({
      ...note,
      detached: note.detached || Boolean(old && old.markdown !== input.markdown && note.revision <= old.revision),
    }));
    const doc: ProjectDocumentRecord = {
      id: id ?? randomUUID(),
      title: relative,
      path: relative,
      root,
      source: 'project',
      markdown: input.markdown,
      revision,
      hash: hash(input.markdown),
      notes,
      updatedAt: new Date().toISOString(),
    };
    this.upsert(doc);
    this.db.prepare('INSERT OR REPLACE INTO project_document_versions VALUES (?,?,?)')
      .run(doc.id, doc.revision, JSON.stringify(doc));
    return doc;
  }

  private row(id: string): MetaRow | undefined {
    return this.db.prepare('SELECT * FROM project_documents WHERE id=?').get(id) as MetaRow | undefined;
  }

  private ensureCurrent(root: string, relative: string, known?: MetaRow): ProjectDocumentRecord {
    const target = targetFor(root, relative);
    if (!existsSync(target) || !statSync(target).isFile()) {
      throw new DocumentError(404, '프로젝트 문서 파일을 찾을 수 없습니다.');
    }
    const markdown = readFileSync(target, 'utf8');
    if (Buffer.byteLength(markdown) > MAX_BYTES) throw new DocumentError(413, '협업문서는 최대 2MB입니다.');
    const currentHash = hash(markdown);
    const row = known ?? this.db.prepare('SELECT * FROM project_documents WHERE root=? AND path=?')
      .get(root, relative) as MetaRow | undefined;
    const revision = row ? row.revision + (row.hash === currentHash ? 0 : 1) : 1;
    const oldNotes = row ? JSON.parse(row.notes) as DocumentNote[] : [];
    const notes = row && row.hash !== currentHash
      ? oldNotes.map((note) => ({ ...note, detached: true }))
      : oldNotes;
    const doc: ProjectDocumentRecord = {
      id: row?.id ?? randomUUID(),
      title: relative,
      path: relative,
      root,
      source: 'project',
      markdown,
      revision,
      hash: currentHash,
      notes,
      updatedAt: row && row.hash === currentHash
        ? row.updated_at
        : new Date(statSync(target).mtimeMs).toISOString(),
    };
    if (!row || row.hash !== currentHash) {
      this.upsert(doc);
      this.db.prepare('INSERT OR REPLACE INTO project_document_versions VALUES (?,?,?)')
        .run(doc.id, doc.revision, JSON.stringify(doc));
    }
    return doc;
  }

  private upsert(doc: ProjectDocumentRecord): void {
    this.db.prepare(`INSERT INTO project_documents(id,root,path,revision,hash,notes,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET root=excluded.root,path=excluded.path,revision=excluded.revision,hash=excluded.hash,notes=excluded.notes,updated_at=excluded.updated_at`)
      .run(doc.id, doc.root, doc.path, doc.revision, doc.hash, JSON.stringify(doc.notes), doc.updatedAt);
  }
}

let projectStore: ProjectDocumentStore | undefined;

export function getProjectDocumentStore(): ProjectDocumentStore {
  return projectStore ??= new ProjectDocumentStore();
}
