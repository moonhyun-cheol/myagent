import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { assertWritablePath } from '../security/path-guard.js';
import type { ProjectColor, ProjectKind, ProjectRecord, ProjectSummary, WorkspaceNode, MoveTarget } from './types.js';
import type { SessionSummary } from '../sessions/types.js';

interface ProjectIndex {
  version: number;
  projects: ProjectRecord[];
}

export interface CreateProjectInput {
  title?: string;
  kind?: ProjectKind;
  parent_id?: string | null;
  folder_path?: string | null;
}

export class ProjectStore {
  private readonly indexPath: string;

  constructor(
    projectsDir: string,
    private readonly cqrRoot: string,
  ) {
    this.indexPath = path.join(projectsDir, 'index.json');
  }

  list(sessionSummaries: SessionSummary[]): ProjectSummary[] {
    const index = this.loadIndex();
    return index.projects
      .map((p) => this.toSummary(p, sessionSummaries))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  listGeneral(sessionSummaries: SessionSummary[]): ProjectSummary[] {
    const index = this.loadIndex();
    return index.projects
      .filter((p) => this.resolveKind(p) === 'project' && !p.parent_id)
      .map((p) => this.toSummary(p, sessionSummaries))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  get(id: string): ProjectRecord | null {
    const safe = sanitizeId(id);
    if (!safe) return null;
    return this.loadIndex().projects.find((p) => p.id === safe) ?? null;
  }

  findByFolderPath(folderPath: string): ProjectRecord | null {
    const norm = normalizeFsPath(folderPath);
    return (
      this.loadIndex().projects.find(
        (p) =>
          this.resolveKind(p) === 'workspace_root' &&
          p.folder_path &&
          normalizeFsPath(p.folder_path) === norm,
      ) ?? null
    );
  }

  listWorkspaceRoots(): ProjectRecord[] {
    const index = this.loadIndex();
    return index.projects
      .filter((p) => this.resolveKind(p) === 'workspace_root')
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  upsertWorkspaceRoot(folderPath: string): ProjectRecord {
    const resolved = path.resolve(folderPath);
    const existing = this.findByFolderPath(resolved);
    const title = path.basename(resolved) || '작업 폴더';
    const now = new Date().toISOString();
    if (existing) {
      if (existing.title !== title) {
        const index = this.loadIndex();
        const rec = index.projects.find((p) => p.id === existing.id);
        if (rec) {
          rec.title = title.slice(0, 64);
          rec.updated_at = now;
          this.saveIndex(index);
        }
        existing.title = title.slice(0, 64);
        existing.updated_at = now;
      }
      return existing;
    }
    const rec: ProjectRecord = {
      id: randomUUID().slice(0, 12),
      title: title.slice(0, 64),
      kind: 'workspace_root',
      parent_id: null,
      folder_path: resolved,
      created_at: now,
      updated_at: now,
    };
    const index = this.loadIndex();
    index.projects.push(rec);
    this.saveIndex(index);
    return rec;
  }

  create(input: CreateProjectInput = {}): ProjectRecord {
    const kind = input.kind ?? 'project';
    const parentId = input.parent_id ? sanitizeId(input.parent_id) : null;
    if (kind === 'folder' && !parentId) {
      throw new ProjectStoreError('PARENT_REQUIRED', 'Folder must have a parent_id');
    }
    if (parentId) {
      const parent = this.get(parentId);
      if (!parent) throw new ProjectStoreError('PARENT_NOT_FOUND', 'Parent folder not found');
      const parentKind = this.resolveKind(parent);
      if (parentKind !== 'workspace_root' && parentKind !== 'folder') {
        throw new ProjectStoreError('INVALID_PARENT', 'Parent must be a workspace or folder');
      }
    }
    if (kind === 'workspace_root') {
      throw new ProjectStoreError('INVALID_KIND', 'Use upsertWorkspaceRoot for workspace_root');
    }

    const now = new Date().toISOString();
    const rec: ProjectRecord = {
      id: randomUUID().slice(0, 12),
      title: (input.title?.trim() || defaultTitle(kind)).slice(0, 64),
      kind,
      parent_id: parentId,
      folder_path: null,
      created_at: now,
      updated_at: now,
    };
    const index = this.loadIndex();
    index.projects.push(rec);
    this.saveIndex(index);
    return rec;
  }

  rename(id: string, title: string): ProjectRecord | null {
    const safe = sanitizeId(id);
    if (!safe) return null;
    const index = this.loadIndex();
    const rec = index.projects.find((p) => p.id === safe);
    if (!rec) return null;
    rec.title = title.trim().slice(0, 64) || rec.title;
    rec.updated_at = new Date().toISOString();
    this.saveIndex(index);
    return rec;
  }

  setColor(id: string, color: ProjectColor | null): ProjectRecord | null {
    const safe = sanitizeId(id);
    if (!safe) return null;
    const allowed: ProjectColor[] = ['gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'pink'];
    if (color !== null && !allowed.includes(color)) {
      throw new ProjectStoreError('INVALID_COLOR', 'Unsupported project color');
    }
    const index = this.loadIndex();
    const rec = index.projects.find((project) => project.id === safe);
    if (!rec) return null;
    rec.color = color;
    rec.updated_at = new Date().toISOString();
    this.saveIndex(index);
    return rec;
  }

  touch(id: string): void {
    const safe = sanitizeId(id);
    if (!safe) return;
    const index = this.loadIndex();
    const rec = index.projects.find((p) => p.id === safe);
    if (!rec) return;
    rec.updated_at = new Date().toISOString();
    this.saveIndex(index);
  }

  collectDescendantIds(id: string): string[] {
    const safe = sanitizeId(id);
    if (!safe) return [];
    const index = this.loadIndex();
    const out: string[] = [];
    const visiting = new Set<string>();
    const walk = (pid: string) => {
      if (visiting.has(pid)) return;
      visiting.add(pid);
      for (const p of index.projects) {
        if (p.parent_id === pid) {
          out.push(p.id);
          walk(p.id);
        }
      }
      visiting.delete(pid);
    };
    walk(safe);
    return out;
  }

  isDeletable(id: string): boolean {
    return this.get(id) !== null;
  }

  delete(id: string): boolean {
    const safe = sanitizeId(id);
    if (!safe) return false;
    const index = this.loadIndex();
    const target = index.projects.find((p) => p.id === safe);
    if (!target) return false;
    const removeIds = new Set([safe, ...this.collectDescendantIds(safe)]);
    const before = index.projects.length;
    index.projects = index.projects.filter((p) => !removeIds.has(p.id));
    if (index.projects.length === before) return false;
    this.saveIndex(index);
    return true;
  }

  listMoveTargets(): MoveTarget[] {
    const index = this.loadIndex();
    const targets: MoveTarget[] = [{ id: null, label: '일반 대화', path: '', kind: 'standalone' }];

    const walk = (rec: ProjectRecord, prefix: string) => {
      targets.push({
        id: rec.id,
        label: rec.title,
        path: prefix,
        kind: this.resolveKind(rec),
      });
      for (const child of index.projects
        .filter((p) => p.parent_id === rec.id)
        .sort((a, b) => a.title.localeCompare(b.title))) {
        walk(child, `${prefix} / ${child.title}`);
      }
    };

    for (const root of index.projects
      .filter((p) => this.resolveKind(p) === 'workspace_root')
      .sort((a, b) => a.title.localeCompare(b.title))) {
      walk(root, `작업 폴더 / ${root.title}`);
    }

    for (const p of index.projects
      .filter((p) => this.resolveKind(p) === 'project')
      .sort((a, b) => a.title.localeCompare(b.title))) {
      targets.push({
        id: p.id,
        label: p.title,
        path: `프로젝트 / ${p.title}`,
        kind: 'project',
      });
    }

    return targets;
  }

  buildNodeTree(rootId: string, sessions: SessionSummary[], ancestors = new Set<string>()): WorkspaceNode | null {
    const rec = this.get(rootId);
    if (!rec) return null;
    if (ancestors.has(rootId)) return null;
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(rootId);
    const index = this.loadIndex();
    const children = index.projects
      .filter((p) => p.parent_id === rootId)
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((p) => this.buildNodeTree(p.id, sessions, nextAncestors))
      .filter((n): n is WorkspaceNode => n !== null);
    const nodeSessions = sessions
      .filter((s) => s.project_id === rootId)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    const childCount = children.reduce((n, c) => n + c.session_count, 0);
    return {
      id: rec.id,
      title: rec.title,
      kind: this.resolveKind(rec),
      parent_id: rec.parent_id ?? null,
      folder_path: rec.folder_path ?? null,
      color: rec.color ?? null,
      created_at: rec.created_at,
      updated_at: rec.updated_at,
      sessions: nodeSessions,
      children,
      session_count: nodeSessions.length + childCount,
    };
  }

  private toSummary(rec: ProjectRecord, sessions: SessionSummary[]): ProjectSummary {
    const ids = new Set([rec.id, ...this.collectDescendantIds(rec.id)]);
    const session_count = sessions.filter((s) => s.project_id && ids.has(s.project_id)).length;
    return {
      ...rec,
      kind: this.resolveKind(rec),
      parent_id: rec.parent_id ?? null,
      folder_path: rec.folder_path ?? null,
      session_count,
    };
  }

  resolveKind(rec: ProjectRecord): ProjectKind {
    if (rec.kind) return rec.kind;
    if (rec.folder_path) return 'workspace_root';
    return 'project';
  }

  /** Resolve filesystem root for a session's project (walks up to workspace_root). */
  resolveWorkspaceRootForProject(projectId: string): string | null {
    const rec = this.get(projectId);
    if (!rec) return null;
    if (this.resolveKind(rec) === 'workspace_root' && rec.folder_path?.trim()) {
      return rec.folder_path.trim();
    }
    if (rec.parent_id) return this.resolveWorkspaceRootForProject(rec.parent_id);
    return null;
  }

  private loadIndex(): ProjectIndex {
    if (!existsSync(this.indexPath)) {
      return { version: 1, projects: [] };
    }
    try {
      const doc = JSON.parse(readFileSync(this.indexPath, 'utf8')) as ProjectIndex;
      return { version: 1, projects: doc.projects ?? [] };
    } catch {
      return { version: 1, projects: [] };
    }
  }

  private saveIndex(index: ProjectIndex): void {
    assertWritablePath(this.indexPath, this.cqrRoot);
    writeFileSync(this.indexPath, JSON.stringify(index, null, 2) + '\n', 'utf8');
  }
}

export class ProjectStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectStoreError';
  }
}

function sanitizeId(id: string): string | null {
  const s = id.trim().slice(0, 64);
  if (!/^[a-zA-Z0-9_-]+$/.test(s)) return null;
  return s;
}

function normalizeFsPath(p: string): string {
  return path.resolve(p).replace(/\\/g, '/').toLowerCase();
}

function defaultTitle(kind: ProjectKind): string {
  switch (kind) {
    case 'folder':
      return '새 폴더';
    case 'project':
      return '새 프로젝트';
    default:
      return '폴더';
  }
}
