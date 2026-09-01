/**
 * User memory (알잘딱): global user/computing context + per-project fragment knowledge.
 * Stored as JSON under data/memory/user-memory.json.
 * - global scope: injected into every chat/code session.
 * - project scope: injected only into sessions bound to that project/workspace node.
 * Entries come from the user (수동) or auto-capture (자동, explicit cue phrases).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type MemoryScope = 'global' | 'project';
export type MemorySource = 'user' | 'auto';

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  /** Present when scope === 'project'. */
  project_id?: string | null;
  text: string;
  source: MemorySource;
  enabled: boolean;
  created_at: string;
  updated_at: string;
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

/** Explicit cue phrases that mark a user message as memory-worthy. */
const AUTO_CAPTURE_CUES: RegExp[] = [
  /기억해/, /기억하자/, /기억해줘/, /잊지\s*마/, /메모해/, /메모리에\s*(넣|저장|추가)/,
  /remember\s+this/i, /keep\s+in\s+mind/i,
];

function normalizeForDedupe(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

export class UserMemoryStore {
  private readonly indexPath: string;

  constructor(memoryDir: string) {
    this.indexPath = path.join(memoryDir, 'user-memory.json');
  }

  list(projectId?: string | null): { global: MemoryEntry[]; project: MemoryEntry[] } {
    const index = this.loadIndex();
    const global = index.entries.filter((e) => e.scope === 'global');
    const project = projectId
      ? index.entries.filter((e) => e.scope === 'project' && e.project_id === projectId)
      : [];
    return { global, project };
  }

  get(id: string): MemoryEntry | null {
    return this.loadIndex().entries.find((e) => e.id === id) ?? null;
  }

  add(input: {
    scope: MemoryScope;
    project_id?: string | null;
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
    const index = this.loadIndex();
    const scopeEntries = index.entries.filter(
      (e) => e.scope === input.scope && (input.scope === 'global' || e.project_id === input.project_id),
    );
    // Dedupe: same normalized text in the same scope refreshes instead of duplicating.
    const normalized = normalizeForDedupe(text);
    const existing = scopeEntries.find((e) => normalizeForDedupe(e.text) === normalized);
    if (existing) {
      existing.updated_at = new Date().toISOString();
      if (!existing.enabled) existing.enabled = true;
      this.saveIndex(index);
      return existing;
    }
    if (scopeEntries.length >= MAX_ENTRIES_PER_SCOPE) {
      // Drop the oldest auto entry to make room; manual entries are never evicted silently.
      const oldestAuto = scopeEntries
        .filter((e) => e.source === 'auto')
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
      text,
      source: input.source ?? 'user',
      enabled: true,
      created_at: now,
      updated_at: now,
    };
    index.entries.push(entry);
    this.saveIndex(index);
    return entry;
  }

  update(id: string, patch: { text?: string; enabled?: boolean }): MemoryEntry | null {
    const index = this.loadIndex();
    const entry = index.entries.find((e) => e.id === id);
    if (!entry) return null;
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

  /**
   * Auto-capture: store an explicit "remember this" style user message.
   * Conservative on purpose — only cue-phrase messages are captured.
   * Returns the stored entry, or null when the message has no cue.
   */
  autoCapture(message: string, projectId?: string | null): MemoryEntry | null {
    const text = (message ?? '').trim();
    if (!text || text.length < 8) return null;
    if (!AUTO_CAPTURE_CUES.some((re) => re.test(text))) return null;
    const stored = text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS - 1)}…` : text;
    try {
      return this.add({
        scope: projectId ? 'project' : 'global',
        project_id: projectId ?? null,
        text: stored,
        source: 'auto',
      });
    } catch {
      return null; // capture must never break the chat flow
    }
  }

  /** Prompt block for context injection. Empty string when nothing to inject. */
  formatForPrompt(projectId?: string | null, projectTitle?: string | null): string {
    const { global, project } = this.list(projectId);
    const pick = (entries: MemoryEntry[]) =>
      entries
        .filter((e) => e.enabled)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, PROMPT_MAX_ENTRIES);
    const g = pick(global);
    const p = pick(project);
    if (!g.length && !p.length) return '';
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
