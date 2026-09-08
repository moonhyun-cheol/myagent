/**
 * User memory (알잘딱): global user/computing context + per-project fragment knowledge.
 * Stored as JSON under data/memory/user-memory.json.
 * - global scope: injected into every chat/code session.
 * - project scope: injected only into sessions bound to that project/workspace node.
 * - session scope: injected only into that conversation.
 * Manual entries are user-authored. Model proposals stay pending until approved.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type MemoryScope = 'global' | 'project' | 'session';
export type MemorySource = 'user' | 'auto';
/** Absent / 'active' = normal entry; pending/rejected are model proposals. */
export type MemoryLifecycle = 'active' | 'pending' | 'rejected';

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  /** Present when scope === 'project'. */
  project_id?: string | null;
  /** Present when scope === 'session'. */
  session_id?: string | null;
  text: string;
  source: MemorySource;
  enabled: boolean;
  /** Model proposal lifecycle. Missing means active (legacy rows). */
  status?: MemoryLifecycle;
  /** Model rationale for a pending proposal. */
  reason?: string | null;
  /** Session that produced a model proposal. */
  source_session_id?: string | null;
  /** Optional originating message id when known. */
  source_message_id?: string | null;
  created_at: string;
  updated_at: string;
  reviewed_at?: string | null;
}

export interface MemoryBatchInput {
  ids: string[];
  action: 'enable' | 'disable' | 'delete' | 'move';
  project_id?: string | null;
  session_id?: string | null;
  target_scope?: MemoryScope;
}

interface MemoryIndex {
  version: number;
  entries: MemoryEntry[];
}

export class UserMemoryStoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'UserMemoryStoreError';
  }
}

const MAX_TEXT_CHARS = 500;
const MAX_ENTRIES_PER_SCOPE = 100;
const PROMPT_MAX_ENTRIES = 20;
const PROMPT_MAX_CHARS = 2_400;

function normalizeForDedupe(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function lifecycle(entry: MemoryEntry): MemoryLifecycle {
  return entry.status === 'pending' || entry.status === 'rejected' ? entry.status : 'active';
}

function isPromptEligible(entry: MemoryEntry): boolean {
  return entry.enabled && lifecycle(entry) === 'active';
}

export class UserMemoryStore {
  private readonly indexPath: string;

  constructor(memoryDir: string) {
    this.indexPath = path.join(memoryDir, 'user-memory.json');
  }

  list(
    projectId?: string | null,
    sessionId?: string | null,
  ): { global: MemoryEntry[]; project: MemoryEntry[]; session: MemoryEntry[] } {
    const index = this.loadIndex();
    const global = index.entries.filter((e) => e.scope === 'global');
    const project = projectId
      ? index.entries.filter((e) => e.scope === 'project' && e.project_id === projectId)
      : [];
    const session = sessionId
      ? index.entries.filter((e) => e.scope === 'session' && e.session_id === sessionId)
      : [];
    return { global, project, session };
  }

  get(id: string): MemoryEntry | null {
    return this.loadIndex().entries.find((e) => e.id === id) ?? null;
  }

  add(input: {
    scope: MemoryScope;
    project_id?: string | null;
    session_id?: string | null;
    text: string;
    source?: MemorySource;
  }): MemoryEntry {
    const text = (input.text ?? '').trim();
    if (!text) throw new UserMemoryStoreError('EMPTY_TEXT', 'Memory text is required');
    if (text.length > MAX_TEXT_CHARS) {
      throw new UserMemoryStoreError('TEXT_TOO_LONG', `Memory text must be <= ${MAX_TEXT_CHARS} chars`);
    }
    if (input.scope === 'project' && !input.project_id) {
      throw new UserMemoryStoreError('PROJECT_REQUIRED', 'project_id is required for project scope');
    }
    if (input.scope === 'session' && !input.session_id) {
      throw new UserMemoryStoreError('SESSION_REQUIRED', 'session_id is required for session scope');
    }
    const index = this.loadIndex();
    const scopeEntries = index.entries.filter(
      (e) => e.scope === input.scope
        && (input.scope !== 'project' || e.project_id === input.project_id)
        && (input.scope !== 'session' || e.session_id === input.session_id),
    );
    // Dedupe: same normalized text in the same scope refreshes instead of duplicating.
    const normalized = normalizeForDedupe(text);
    const existing = scopeEntries.find((e) => normalizeForDedupe(e.text) === normalized);
    if (existing) {
      if (lifecycle(existing) === 'pending' || lifecycle(existing) === 'rejected') {
        throw new UserMemoryStoreError('DUPLICATE_TEXT', '같은 범위에 동일하거나 거절된 후보가 있습니다.');
      }
      existing.updated_at = new Date().toISOString();
      if (!existing.enabled) existing.enabled = true;
      existing.status = 'active';
      this.saveIndex(index);
      return existing;
    }
    if (scopeEntries.length >= MAX_ENTRIES_PER_SCOPE) {
      // Drop the oldest auto entry to make room; manual entries are never evicted silently.
      const oldestAuto = scopeEntries
        .filter((e) => e.source === 'auto' && lifecycle(e) !== 'pending')
        .sort((a, b) => a.updated_at.localeCompare(b.updated_at))[0];
      if (!oldestAuto) {
        throw new UserMemoryStoreError('SCOPE_FULL', `Memory scope is full (max ${MAX_ENTRIES_PER_SCOPE})`);
      }
      index.entries = index.entries.filter((e) => e.id !== oldestAuto.id);
    }
    const now = new Date().toISOString();
    const entry: MemoryEntry = {
      id: randomUUID(),
      scope: input.scope,
      project_id: input.scope === 'project' ? input.project_id : null,
      session_id: input.scope === 'session' ? input.session_id : null,
      text,
      source: input.source ?? 'user',
      enabled: true,
      status: 'active',
      created_at: now,
      updated_at: now,
    };
    index.entries.push(entry);
    this.saveIndex(index);
    return entry;
  }

  /**
   * Model-authored proposal. Never enters the prompt until approve().
   * Rejected / identical active / pending duplicates are suppressed.
   */
  propose(input: {
    scope: MemoryScope;
    project_id?: string | null;
    session_id?: string | null;
    text: string;
    reason?: string | null;
    source_session_id?: string | null;
    source_message_id?: string | null;
  }): MemoryEntry {
    const text = (input.text ?? '').trim();
    if (!text) throw new UserMemoryStoreError('EMPTY_TEXT', 'Memory text is required');
    if (text.length > MAX_TEXT_CHARS) {
      throw new UserMemoryStoreError('TEXT_TOO_LONG', `Memory text must be <= ${MAX_TEXT_CHARS} chars`);
    }
    if (input.scope === 'project' && !input.project_id) {
      throw new UserMemoryStoreError('PROJECT_REQUIRED', 'project_id is required for project scope');
    }
    if (input.scope === 'session' && !input.session_id) {
      throw new UserMemoryStoreError('SESSION_REQUIRED', 'session_id is required for session scope');
    }
    const index = this.loadIndex();
    const scopeEntries = index.entries.filter(
      (e) => e.scope === input.scope
        && (input.scope !== 'project' || e.project_id === input.project_id)
        && (input.scope !== 'session' || e.session_id === input.session_id),
    );
    const normalized = normalizeForDedupe(text);
    const clash = scopeEntries.find((e) => normalizeForDedupe(e.text) === normalized);
    if (clash) {
      if (lifecycle(clash) === 'pending') return clash;
      throw new UserMemoryStoreError(
        lifecycle(clash) === 'rejected' ? 'REJECTED_DUPLICATE' : 'DUPLICATE_TEXT',
        lifecycle(clash) === 'rejected'
          ? '거절된 후보와 동일해 재제안하지 않습니다.'
          : '이미 같은 메모리가 있습니다.',
      );
    }
    const pendingCount = scopeEntries.filter((e) => lifecycle(e) === 'pending').length;
    if (pendingCount + scopeEntries.filter((e) => lifecycle(e) === 'active').length >= MAX_ENTRIES_PER_SCOPE) {
      throw new UserMemoryStoreError('SCOPE_FULL', `Memory scope is full (max ${MAX_ENTRIES_PER_SCOPE})`);
    }
    const now = new Date().toISOString();
    const entry: MemoryEntry = {
      id: randomUUID(),
      scope: input.scope,
      project_id: input.scope === 'project' ? input.project_id : null,
      session_id: input.scope === 'session' ? input.session_id : null,
      text,
      source: 'auto',
      enabled: false,
      status: 'pending',
      reason: (input.reason ?? '').trim().slice(0, 300) || null,
      source_session_id: input.source_session_id ?? input.session_id ?? null,
      source_message_id: input.source_message_id ?? null,
      created_at: now,
      updated_at: now,
    };
    index.entries.push(entry);
    this.saveIndex(index);
    return entry;
  }

  approve(id: string, patch: { text?: string } = {}): MemoryEntry | null {
    const index = this.loadIndex();
    const entry = index.entries.find((e) => e.id === id);
    if (!entry || lifecycle(entry) !== 'pending') return null;
    if (patch.text !== undefined) {
      const text = patch.text.trim();
      if (!text) throw new UserMemoryStoreError('EMPTY_TEXT', 'Memory text is required');
      if (text.length > MAX_TEXT_CHARS) {
        throw new UserMemoryStoreError('TEXT_TOO_LONG', `Memory text must be <= ${MAX_TEXT_CHARS} chars`);
      }
      const normalized = normalizeForDedupe(text);
      const clash = index.entries.find(
        (e) => e.id !== id
          && e.scope === entry.scope
          && (entry.scope !== 'project' || e.project_id === entry.project_id)
          && (entry.scope !== 'session' || e.session_id === entry.session_id)
          && normalizeForDedupe(e.text) === normalized
          && lifecycle(e) === 'active',
      );
      if (clash) throw new UserMemoryStoreError('DUPLICATE_TEXT', '승인 본문이 기존 메모리와 중복됩니다.');
      entry.text = text;
    }
    const now = new Date().toISOString();
    entry.status = 'active';
    entry.enabled = true;
    entry.updated_at = now;
    entry.reviewed_at = now;
    this.saveIndex(index);
    return entry;
  }

  reject(id: string): MemoryEntry | null {
    const index = this.loadIndex();
    const entry = index.entries.find((e) => e.id === id);
    if (!entry || lifecycle(entry) !== 'pending') return null;
    const now = new Date().toISOString();
    entry.status = 'rejected';
    entry.enabled = false;
    entry.updated_at = now;
    entry.reviewed_at = now;
    this.saveIndex(index);
    return entry;
  }

  update(id: string, patch: { text?: string; enabled?: boolean }): MemoryEntry | null {
    const index = this.loadIndex();
    const entry = index.entries.find((e) => e.id === id);
    if (!entry) return null;
    if (lifecycle(entry) === 'pending' || lifecycle(entry) === 'rejected') {
      throw new UserMemoryStoreError('PENDING_LOCKED', '승인/거절이 필요한 후보는 일반 수정할 수 없습니다.');
    }
    if (patch.text !== undefined) {
      const text = patch.text.trim();
      if (!text) throw new UserMemoryStoreError('EMPTY_TEXT', 'Memory text is required');
      if (text.length > MAX_TEXT_CHARS) {
        throw new UserMemoryStoreError('TEXT_TOO_LONG', `Memory text must be <= ${MAX_TEXT_CHARS} chars`);
      }
      entry.text = text;
      // User edit promotes an auto capture to a curated entry.
      entry.source = 'user';
    }
    if (patch.enabled !== undefined) entry.enabled = patch.enabled;
    entry.updated_at = new Date().toISOString();
    this.saveIndex(index);
    return entry;
  }

  /** Validate the entire selection before a single write; never copy/delete a move. */
  batch(input: MemoryBatchInput): number {
    if (!input || !Array.isArray(input.ids) || !input.ids.length || input.ids.length > 300
      || input.ids.some((id) => typeof id !== 'string' || !id)
      || !['enable', 'disable', 'delete', 'move'].includes(input.action)) {
      throw new UserMemoryStoreError('INVALID_BATCH', '유효한 항목과 작업을 선택하세요.');
    }
    const ids = new Set(input.ids);
    const index = this.loadIndex();
    const selected = index.entries.filter((e) => ids.has(e.id));
    if (selected.length !== ids.size || selected.some((e) =>
      e.scope === 'project' ? !input.project_id || e.project_id !== input.project_id
        : e.scope === 'session' ? !input.session_id || e.session_id !== input.session_id : e.scope !== 'global')) {
      throw new UserMemoryStoreError('STALE_SELECTION', '선택한 항목이 없거나 현재 범위 밖에 있습니다. 새로고침하세요.');
    }
    if (input.action !== 'delete' && selected.some((e) => lifecycle(e) === 'pending' || lifecycle(e) === 'rejected')) {
      throw new UserMemoryStoreError('PENDING_LOCKED', '대기/거절 후보는 승인·거절 또는 삭제로만 처리하세요.');
    }
    if (input.action === 'move') {
      const scope = input.target_scope;
      if (!scope || !['global', 'project', 'session'].includes(scope)
        || (scope === 'project' && !input.project_id) || (scope === 'session' && !input.session_id)) {
        throw new UserMemoryStoreError('INVALID_TARGET', '사용 가능한 저장 범위를 선택하세요.');
      }
      const destination = index.entries.filter((e) => !ids.has(e.id) && e.scope === scope
        && (scope !== 'project' || e.project_id === input.project_id)
        && (scope !== 'session' || e.session_id === input.session_id));
      if (destination.length + selected.length > MAX_ENTRIES_PER_SCOPE) {
        throw new UserMemoryStoreError('SCOPE_FULL', `대상 범위는 최대 ${MAX_ENTRIES_PER_SCOPE}개까지 저장할 수 있습니다.`);
      }
      const texts = new Set(destination.map((e) => normalizeForDedupe(e.text)));
      for (const entry of selected) {
        const text = normalizeForDedupe(entry.text);
        if (texts.has(text)) throw new UserMemoryStoreError('DUPLICATE_TEXT', '대상 범위 또는 선택 항목에 같은 메모리가 있습니다. 중복을 정리한 뒤 이동하세요.');
        texts.add(text);
      }
      for (const entry of selected) {
        entry.scope = scope;
        entry.project_id = scope === 'project' ? input.project_id : null;
        entry.session_id = scope === 'session' ? input.session_id : null;
      }
    }
    if (input.action === 'delete') {
      index.entries = index.entries.filter((e) => !ids.has(e.id));
    } else {
      const now = new Date().toISOString();
      for (const entry of selected) {
        if (input.action !== 'move') entry.enabled = input.action === 'enable';
        entry.updated_at = now;
      }
    }
    this.saveIndex(index);
    return selected.length;
  }

  remove(id: string): boolean {
    const index = this.loadIndex();
    const before = index.entries.length;
    index.entries = index.entries.filter((e) => e.id !== id);
    if (index.entries.length === before) return false;
    this.saveIndex(index);
    return true;
  }

  /** Remove project-scope entries when their project is deleted. */
  removeByProject(projectIds: string[]): number {
    if (!projectIds.length) return 0;
    const ids = new Set(projectIds);
    const index = this.loadIndex();
    const before = index.entries.length;
    index.entries = index.entries.filter(
      (e) => !(e.scope === 'project' && e.project_id && ids.has(e.project_id)),
    );
    const removed = before - index.entries.length;
    if (removed > 0) this.saveIndex(index);
    return removed;
  }

  /** Remove session-scope entries when their conversation is deleted. */
  removeBySession(sessionIds: string[]): number {
    if (!sessionIds.length) return 0;
    const ids = new Set(sessionIds);
    const index = this.loadIndex();
    const before = index.entries.length;
    index.entries = index.entries.filter(
      (e) => !(e.scope === 'session' && e.session_id && ids.has(e.session_id)),
    );
    const removed = before - index.entries.length;
    if (removed > 0) this.saveIndex(index);
    return removed;
  }

  /**
   * @deprecated Regex cue auto-save removed. Model proposals use propose() / memory_propose.
   * Kept as a no-op so older callers cannot silently persist memories.
   */
  autoCapture(_message: string, _projectId?: string | null): MemoryEntry | null {
    return null;
  }

  /** Prompt block for context injection. Empty string when nothing to inject. Pending/rejected never appear. */
  formatForPrompt(
    projectId?: string | null,
    projectTitle?: string | null,
    sessionId?: string | null,
    sessionTitle?: string | null,
  ): string {
    const { global, project, session } = this.list(projectId, sessionId);
    const pick = (entries: MemoryEntry[]) =>
      entries
        .filter((e) => isPromptEligible(e))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, PROMPT_MAX_ENTRIES);
    const g = pick(global);
    const p = pick(project);
    const s = pick(session);
    if (!g.length && !p.length && !s.length) return '';
    const lines: string[] = [
      '## 사용자 메모리 (알잘딱)',
      '아래는 사용자가 저장한 맥락이다. 답변과 판단에 반영하라.',
    ];
    if (g.length) {
      lines.push('### 전역 맥락');
      for (const e of g) lines.push(`- ${e.text}`);
    }
    if (p.length) {
      lines.push(projectTitle ? `### 프로젝트 메모리: ${projectTitle}` : '### 프로젝트 메모리');
      for (const e of p) lines.push(`- ${e.text}`);
    }
    if (s.length) {
      lines.push(sessionTitle ? `### 대화 메모리: ${sessionTitle}` : '### 대화 메모리');
      for (const e of s) lines.push(`- ${e.text}`);
    }
    let block = lines.join('\n');
    if (block.length > PROMPT_MAX_CHARS) block = `${block.slice(0, PROMPT_MAX_CHARS)}…`;
    return block;
  }

  private loadIndex(): MemoryIndex {
    if (!existsSync(this.indexPath)) return { version: 1, entries: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.indexPath, 'utf8')) as MemoryIndex;
      if (!parsed || !Array.isArray(parsed.entries)) return { version: 1, entries: [] };
      return parsed;
    } catch {
      return { version: 1, entries: [] };
    }
  }

  private saveIndex(index: MemoryIndex): void {
    mkdirSync(path.dirname(this.indexPath), { recursive: true });
    writeFileSync(this.indexPath, JSON.stringify(index, null, 2), 'utf8');
  }
}

/** Singleton per data dir so callers can reach memory without rewiring constructors. */
const storeCache = new Map<string, UserMemoryStore>();

export function getUserMemoryStore(dataDir: string): UserMemoryStore {
  const key = path.resolve(dataDir).toLowerCase();
  let store = storeCache.get(key);
  if (!store) {
    store = new UserMemoryStore(path.join(dataDir, 'memory'));
    storeCache.set(key, store);
  }
  return store;
}
