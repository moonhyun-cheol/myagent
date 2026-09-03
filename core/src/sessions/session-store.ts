import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { assertWritablePath } from '../security/path-guard.js';
import { DEFAULT_EXECUTION_POLICY, normalizeExecutionPolicy, type ExecutionPolicy } from '../execution-policy.js';
import type {
  ResponsesContinuationState,
  ResponsesStateMode,
  SessionMessage,
  SessionRecord,
  SessionSummary,
} from './types.js';
import { gcDeletedSessionTemp, pruneSessionTemp } from './session-temp-gc.js';

const MAX_MESSAGES = 80;
const MAX_ASSISTANT_THOUGHT_CHARS = 200_000;
const TRUNCATED_THOUGHT_PREFIX = '[이전 작업 로그 일부 생략]\n';

const MAX_SESSION_TITLE_LENGTH = 80;

export function normalizeSessionTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim().slice(0, MAX_SESSION_TITLE_LENGTH);
}

export class SessionStore {
  /** Work-log deltas collected before the matching assistant message is persisted. */
  private readonly pendingAssistantThought = new Map<string, string>();

  constructor(
    private readonly sessionsDir: string,
    private readonly cqrRoot: string,
    private readonly onProjectActivity?: (projectId: string) => void,
    private readonly resolveWorkspaceRoot?: (rec: SessionRecord) => string | null,
  ) {}

  list(): SessionSummary[] {
    return this.loadAll()
      .map((rec) => this.toSummary(rec))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  /** Import the portable cqr-pa conversation export as a new local session. */
  importPortable(raw: unknown, projectId: string | null = null, legacyWorkspaceProjectId: string | null = null): SessionRecord {
    const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const conversation = source.conversation && typeof source.conversation === 'object'
      ? source.conversation as Record<string, unknown>
      : source;
    const rawMessages = Array.isArray(conversation.messages) ? conversation.messages : [];
    const messages: SessionMessage[] = rawMessages
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item): SessionMessage => ({
        role: item.role === 'assistant' ? 'assistant' : 'user',
        content: typeof item.content === 'string' ? item.content : '',
        at: typeof item.at === 'string' ? item.at : new Date().toISOString(),
        ...(typeof item.mode === 'string' ? { mode: item.mode } : {}),
        ...(typeof item.thought === 'string' && item.thought.trim()
          ? { thought: item.thought }
          : {}),
      }))
      .filter((item) => item.content.trim())
      .slice(-MAX_MESSAGES);
    const title = normalizeSessionTitle(
      typeof conversation.title === 'string' && conversation.title.trim()
        ? conversation.title
        : messages.find((message) => message.role === 'user')?.content ?? '가져온 세션',
    ) || '가져온 세션';
    const now = new Date().toISOString();
    const membershipProjectId = projectId ?? legacyWorkspaceProjectId;
    const rec: SessionRecord = {
      id: randomUUID(), title, created_at: now, updated_at: now, messages,
      project_id: membershipProjectId ? sanitizeId(membershipProjectId) : null,
    };
    this.save(rec);
    return withLegacyWorkspaceAlias(rec);
  }

  loadAll(): SessionRecord[] {
    if (!existsSync(this.sessionsDir)) return [];
    const out: SessionRecord[] = [];
    for (const name of readdirSync(this.sessionsDir)) {
      if (!name.endsWith('.json')) continue;
      const rec = this.load(name.slice(0, -5));
      if (rec) out.push(rec);
    }
    return out;
  }

  listStandalone(): SessionSummary[] {
    return this.list().filter((s) => !s.project_id);
  }

  listByProject(projectId: string): SessionSummary[] {
    const safe = sanitizeId(projectId);
    if (!safe) return [];
    return this.list().filter((s) => s.project_id === safe);
  }

  load(id: string): SessionRecord | null {
    const safe = sanitizeId(id);
    if (!safe) return null;
    const fp = this.filePath(safe);
    if (!existsSync(fp)) return null;
    try {
      const rec = JSON.parse(readFileSync(fp, 'utf8')) as SessionRecord;
      const persistedProjectId = rec.project_id ? sanitizeId(rec.project_id) : null;
      const legacyWorkspaceProjectId = rec.workspace_project_id
        ? sanitizeId(rec.workspace_project_id)
        : null;
      const projectId = persistedProjectId ?? legacyWorkspaceProjectId;
      const needsMigration = rec.project_id !== projectId || rec.workspace_project_id !== undefined;
      rec.project_id = projectId;
      rec.execution_policy = normalizeExecutionPolicy(rec.execution_policy);
      if (needsMigration) this.save(rec);
      return withLegacyWorkspaceAlias(rec);
    } catch {
      return null;
    }
  }

  ensure(id: string, opts?: { project_id?: string | null; execution_policy?: ExecutionPolicy }): SessionRecord {
    const existing = this.load(id);
    if (existing) {
      if (opts?.project_id !== undefined && existing.project_id !== opts.project_id) {
        existing.project_id = opts.project_id ? sanitizeId(opts.project_id) : null;
        this.save(existing);
      }
      return existing;
    }
    const now = new Date().toISOString();
    const projectId =
      opts?.project_id === undefined || opts.project_id === null
        ? null
        : sanitizeId(opts.project_id);
    const rec: SessionRecord = {
      id: sanitizeId(id) ?? randomUUID(),
      title: '새 대화',
      created_at: now,
      updated_at: now,
      messages: [],
      project_id: projectId,
      execution_policy: normalizeExecutionPolicy(opts?.execution_policy, DEFAULT_EXECUTION_POLICY),
    };
    this.save(rec);
    return withLegacyWorkspaceAlias(rec);
  }

  setProject(id: string, projectId: string | null): SessionRecord | null {
    const rec = this.load(id);
    if (!rec) return null;
    rec.project_id = projectId ? sanitizeId(projectId) : null;
    rec.updated_at = new Date().toISOString();
    this.save(rec);
    return rec;
  }

  rename(id: string, title: string): SessionRecord | null {
    const rec = this.load(id);
    if (!rec) return null;
    const next = normalizeSessionTitle(title);
    if (!next) return null;
    rec.title = next;
    rec.updated_at = new Date().toISOString();
    this.save(rec);
    return rec;
  }

  replaceWithSummary(id: string, summary: string, sourceTitle: string): SessionRecord | null {
    const rec = this.load(id);
    if (!rec) return null;
    const now = new Date().toISOString();
    rec.title = `${sourceTitle.trim().slice(0, 36) || '대화'} · 요약`;
    rec.messages = [{
      role: 'assistant',
      content: `이전 대화 요약\n\n${summary.trim()}`,
      at: now,
      model_exclude: false,
    }];
    delete rec.responses_state;
    delete rec.responses_states;
    rec.updated_at = now;
    this.save(rec);
    return rec;
  }

  unlinkAllFromProject(projectId: string): number {
    const safe = sanitizeId(projectId);
    if (!safe) return 0;
    let n = 0;
    for (const s of this.list()) {
      if (s.project_id !== safe) continue;
      const rec = this.load(s.id);
      if (!rec) continue;
      rec.project_id = null;
      this.save(rec);
      n++;
    }
    return n;
  }

  deleteAllInProject(projectId: string): number {
    const safe = sanitizeId(projectId);
    if (!safe) return 0;
    let n = 0;
    for (const s of this.list()) {
      if (s.project_id !== safe) continue;
      if (this.delete(s.id)) n++;
    }
    return n;
  }

  /** Start collecting the public work log for one streamed assistant turn. */
  beginAssistantThought(id: string): void {
    const safe = sanitizeId(id);
    if (!safe) return;
    this.pendingAssistantThought.delete(safe);
  }

  /** Append an SSE `thought` delta without feeding it back into future model context. */
  appendAssistantThought(id: string, delta: string): void {
    const safe = sanitizeId(id);
    if (!safe || !delta) return;
    const combined = `${this.pendingAssistantThought.get(safe) ?? ''}${delta}`;
    const bounded = combined.length <= MAX_ASSISTANT_THOUGHT_CHARS
      ? combined
      : `${TRUNCATED_THOUGHT_PREFIX}${combined.slice(-(MAX_ASSISTANT_THOUGHT_CHARS - TRUNCATED_THOUGHT_PREFIX.length))}`;
    this.pendingAssistantThought.set(safe, bounded);
  }

  append(id: string, message: SessionMessage): SessionRecord {
    const rec = this.ensure(id);
    let storedMessage = message;
    if (message.role === 'assistant') {
      const pendingThought = this.pendingAssistantThought.get(rec.id);
      this.pendingAssistantThought.delete(rec.id);
      if (!message.thought && pendingThought?.trim()) {
        storedMessage = { ...message, thought: pendingThought };
      }
    }
    rec.messages.push(storedMessage);
    const trimmed = rec.messages.length > MAX_MESSAGES;
    if (trimmed) {
      rec.messages = rec.messages.slice(-MAX_MESSAGES);
    }
    if (storedMessage.role === 'user' && rec.title === '새 대화') {
      rec.title = storedMessage.content.trim().slice(0, 48) || '새 대화';
    }
    rec.updated_at = new Date().toISOString();
    this.save(rec);
    if (rec.project_id) this.onProjectActivity?.(rec.project_id);
    if (trimmed) {
      try {
        pruneSessionTemp(this.cqrRoot, rec.id, this.loadAll());
      } catch {
        /* temp GC must not fail the turn */
      }
    }
    return rec;
  }

  delete(id: string): boolean {
    const safe = sanitizeId(id);
    if (!safe) return false;
    const rec = this.load(safe);
    const fp = this.filePath(safe);
    if (!existsSync(fp)) return false;
    assertWritablePath(fp, this.cqrRoot);
    unlinkSync(fp);
    try {
      const workspaceRoot = rec ? this.resolveWorkspaceRoot?.(rec) ?? null : null;
      gcDeletedSessionTemp(this.cqrRoot, safe, this.loadAll(), workspaceRoot);
    } catch {
      /* session JSON is already gone */
    }
    return true;
  }

  recentMessages(id: string, limit = 20): SessionMessage[] {
    const rec = this.load(id);
    if (!rec) return [];
    return rec.messages.slice(-limit);
  }

  /** @deprecated Legacy workspace binding now moves the session to that tree node. */
  setWorkspaceProject(id: string, workspaceProjectId: string | null): SessionRecord | null {
    return this.setProject(id, workspaceProjectId);
  }

  setPreferredModel(id: string, model: string): SessionRecord | null {
    const rec = this.load(id);
    if (!rec) return null;
    const normalized = model.trim();
    if (!normalized || normalized.length > 240) return null;
    rec.preferred_model = normalized;
    rec.updated_at = new Date().toISOString();
    this.save(rec);
    return rec;
  }

  setExecutionPolicy(id: string, policy: ExecutionPolicy): SessionRecord | null {
    const rec = this.load(id);
    if (!rec) return null;
    rec.execution_policy = normalizeExecutionPolicy(policy);
    rec.updated_at = new Date().toISOString();
    this.save(rec);
    return rec;
  }

  responsesState(
    id: string,
    providerId: string,
    modelId: string,
    mode: ResponsesStateMode,
    lane = 'chat',
  ): ResponsesContinuationState {
    const rec = this.load(id);
    const current = rec?.responses_states?.[lane] ?? (lane === 'chat' ? rec?.responses_state : undefined);
    if (
      current?.version === 1
      && current.provider_id === providerId
      && current.model_id === modelId
      && current.mode === mode
    ) {
      return structuredClone(current);
    }
    return {
      version: 1,
      mode,
      provider_id: providerId,
      model_id: modelId,
      next_message_index: 0,
      updated_at: new Date().toISOString(),
    };
  }

  saveResponsesState(id: string, state: ResponsesContinuationState, lane = 'chat'): void {
    const rec = this.ensure(id);
    rec.responses_states = rec.responses_states ?? {};
    rec.responses_states[lane] = structuredClone(state);
    if (lane === 'chat') rec.responses_state = structuredClone(state);
    rec.updated_at = new Date().toISOString();
    this.save(rec);
  }

  clearResponsesState(id: string, lane?: string): void {
    const rec = this.load(id);
    if (!rec) return;
    if (lane) {
      if (rec.responses_states) delete rec.responses_states[lane];
      if (lane === 'chat') delete rec.responses_state;
    } else {
      delete rec.responses_state;
      delete rec.responses_states;
    }
    rec.updated_at = new Date().toISOString();
    this.save(rec);
  }

  /** Public API projection: provider continuation/reasoning items stay inside Core. */
  publicRecord(rec: SessionRecord): Omit<SessionRecord, 'responses_state' | 'responses_states'> {
    const {
      responses_state: _privateResponsesState,
      responses_states: _privateResponsesStates,
      ...publicRecord
    } = rec;
    return publicRecord;
  }

  popLastTurn(id: string): { userText?: string; removed: number } | null {
    const rec = this.load(id);
    if (!rec?.messages.length) return null;
    let removed = 0;
    let userText: string | undefined;
    const last = rec.messages[rec.messages.length - 1];
    if (last.role === 'assistant') {
      rec.messages.pop();
      removed += 1;
    }
    const trailing = rec.messages[rec.messages.length - 1];
    if (trailing?.role === 'user') {
      userText = trailing.content;
      rec.messages.pop();
      removed += 1;
      const prevUser = [...rec.messages].reverse().find((m) => m.role === 'user');
      rec.title = prevUser?.content.trim().slice(0, 48) || '새 대화';
    }
    if (!removed) return null;
    // Undo creates a branch. A provider-side response chain cannot be rewound safely.
    delete rec.responses_state;
    delete rec.responses_states;
    rec.updated_at = new Date().toISOString();
    this.save(rec);
    return { userText, removed };
  }

  private toSummary(rec: SessionRecord): SessionSummary {
    const summary: SessionSummary = {
      id: rec.id,
      title: rec.title,
      updated_at: rec.updated_at,
      message_count: rec.messages.length,
      project_id: rec.project_id ?? null,
      preferred_model: rec.preferred_model,
    };
    return withLegacyWorkspaceAlias(summary);
  }

  private save(rec: SessionRecord): void {
    const fp = this.filePath(rec.id);
    assertWritablePath(fp, this.cqrRoot);
    const { workspace_project_id: _legacyWorkspaceProjectId, ...persisted } = rec;
    writeFileSync(fp, JSON.stringify(persisted, null, 2) + '\n', 'utf8');
  }

  private filePath(id: string): string {
    return path.join(this.sessionsDir, `${id}.json`);
  }
}

function withLegacyWorkspaceAlias<T extends { project_id?: string | null; workspace_project_id?: string | null }>(record: T): T {
  // Keep direct in-process reads working during the compatibility window without
  // exposing the retired field through JSON/API output or durable storage.
  Object.defineProperty(record, 'workspace_project_id', {
    configurable: true,
    enumerable: false,
    get: () => record.project_id ?? null,
  });
  return record;
}

function sanitizeId(id: string): string | null {
  const s = id.trim().slice(0, 64);
  if (!/^[a-zA-Z0-9_-]+$/.test(s)) return null;
  return s;
}
