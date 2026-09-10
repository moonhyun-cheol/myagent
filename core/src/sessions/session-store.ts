import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { assertChatRunWritable, currentChatRun, type ChatRun } from '../chat/chat-runs.js';
import { SessionSqliteStore, type MessagePage } from './session-sqlite-store.js';
import { DEFAULT_EXECUTION_POLICY, normalizeExecutionPolicy, type ExecutionPolicy } from '../execution-policy.js';
import type {
  ResponsesContinuationState,
  ResponsesStateMode,
  SessionMessage,
  SessionRecord,
  SessionSummary,
} from './types.js';
import { gcDeletedSessionTemp } from './session-temp-gc.js';

const MAX_ASSISTANT_THOUGHT_CHARS = 200_000;
const TRUNCATED_THOUGHT_PREFIX = '[이전 작업 로그 일부 생략]\n';

const MAX_SESSION_TITLE_LENGTH = 80;

export function normalizeSessionTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim().slice(0, MAX_SESSION_TITLE_LENGTH);
}

export class SessionStore {
  private readonly database: SessionSqliteStore;
  /** Work-log deltas collected before the matching assistant message is persisted. */
  private readonly pendingAssistantThought = new Map<string, string>();
  private readonly pendingToolActivity = new Map<string, Map<string, import('../agent/tool-activity.js').ToolActivity>>();

  constructor(
    private readonly sessionsDir: string,
    private readonly cqrRoot: string,
    private readonly onProjectActivity?: (projectId: string) => void,
    private readonly resolveWorkspaceRoot?: (rec: SessionRecord) => string | null,
  ) {
    this.database = new SessionSqliteStore(sessionsDir, cqrRoot);
  }

  list(): SessionSummary[] {
    return this.database.list();
  }

  /** Live (non-archived) sessions shown in the workspace tree. */
  listActive(): SessionSummary[] {
    return this.list().filter((s) => !s.archived);
  }

  /** Archived sessions, surfaced only in the 보관함 view (newest first). */
  listArchived(): SessionSummary[] {
    return this.list().filter((s) => s.archived);
  }

  /** Set/clear the archive flag. Reviving (unarchive) bumps recency so auto-archive keeps it visible. */
  setArchived(id: string, archived: boolean): SessionSummary | null {
    const rec = this.load(id);
    if (!rec) return null;
    if (Boolean(rec.archived) === archived) return this.getSummary(rec);
    rec.archived = archived;
    // Archiving preserves ordering; unarchiving revives the session to the top of its group.
    if (!archived) rec.updated_at = new Date().toISOString();
    this.save(rec);
    if (rec.project_id) this.onProjectActivity?.(rec.project_id);
    return this.getSummary(rec);
  }

  /**
   * Auto-archive overflow per group (project_id; null = standalone). Once a group's
   * visible sessions exceed previewLimit + hiddenMax, the oldest overflow is archived
   * so the tree never grows unbounded. Idempotent: no writes once each group fits.
   */
  autoArchive(previewLimit = 5, hiddenMax = 10): number {
    const keep = previewLimit + hiddenMax;
    const groups = new Map<string, SessionSummary[]>();
    for (const summary of this.listActive()) {
      const key = summary.project_id ?? '';
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(summary);
    }
    let archived = 0;
    for (const list of groups.values()) {
      if (list.length <= keep) continue;
      const overflow = [...list]
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(keep);
      for (const summary of overflow) {
        if (this.setArchived(summary.id, true)) archived++;
      }
    }
    return archived;
  }

  /** Import the portable cqr-pa conversation export as a new local session. */
  importPortable(raw: unknown, projectId: string | null = null, workspaceProjectId: string | null = null): SessionRecord {
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
        ...(typeof item.model === 'string' && item.model.trim() ? { model: item.model } : {}),
        ...(() => {
          const rawReasoning = item.reasoning && typeof item.reasoning === 'object'
            ? item.reasoning as Record<string, unknown>
            : null;
          const content = typeof rawReasoning?.content === 'string' && rawReasoning.content.trim()
            ? rawReasoning.content
            : typeof item.thought === 'string' && item.thought.trim()
              ? item.thought
              : '';
          if (!content) return {};
          const reasoningModel = typeof rawReasoning?.model === 'string' && rawReasoning.model.trim()
            ? rawReasoning.model
            : typeof item.model === 'string' && item.model.trim()
              ? item.model
              : undefined;
          return {
            reasoning: {
              version: 1 as const,
              format: 'public_summary' as const,
              content,
              ...(reasoningModel ? { model: reasoningModel } : {}),
            },
          };
        })(),
      }))
      .filter((item) => item.content.trim());
    const title = normalizeSessionTitle(
      typeof conversation.title === 'string' && conversation.title.trim()
        ? conversation.title
        : messages.find((message) => message.role === 'user')?.content ?? '가져온 세션',
    ) || '가져온 세션';
    const now = new Date().toISOString();
    const rec: SessionRecord = {
      id: randomUUID(), title, created_at: now, updated_at: now, messages,
      project_id: projectId, workspace_project_id: workspaceProjectId,
    };
    this.save(rec);
    return rec;
  }

  loadAll(): SessionRecord[] {
    return this.list().map((summary) => this.load(summary.id)).filter((rec): rec is SessionRecord => rec !== null);
  }

  listStandalone(): SessionSummary[] {
    return this.listActive().filter((s) => !s.project_id);
  }

  listByProject(projectId: string): SessionSummary[] {
    const safe = sanitizeId(projectId);
    if (!safe) return [];
    return this.listActive().filter((s) => s.project_id === safe);
  }

  load(id: string): SessionRecord | null {
    const safe = sanitizeId(id);
    if (!safe) return null;
    const rec = this.database.load(safe);
    if (!rec) return null;
    if (rec.project_id === undefined) rec.project_id = null;
    if (rec.workspace_project_id === undefined) rec.workspace_project_id = null;
    rec.execution_policy = normalizeExecutionPolicy(rec.execution_policy);
    return rec;
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
    return rec;
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
    assertChatRunWritable(id);
    const safe = sanitizeId(id);
    if (!safe) return;
    this.pendingAssistantThought.delete(safe);
    this.pendingToolActivity.delete(safe);
  }

  /** Bounded display snapshots, attached even when an infra/cancel reply is saved. */
  appendToolActivity(id: string, row: import('../agent/tool-activity.js').ToolActivity): void {
    assertChatRunWritable(id);
    const safe = sanitizeId(id);
    if (!safe) return;
    const rows = this.pendingToolActivity.get(safe) ?? new Map();
    rows.set(row.id, { ...row });
    if (rows.size > 40) rows.delete(rows.keys().next().value!);
    this.pendingToolActivity.set(safe, rows);
    currentChatRun()?.checkpoint?.(true);
  }

  /** Append an SSE `thought` delta without feeding it back into future model context. */
  appendAssistantThought(id: string, delta: string): void {
    if (currentChatRun()?.controller.signal.aborted) return;
    assertChatRunWritable(id);
    const safe = sanitizeId(id);
    if (!safe || !delta) return;
    const combined = `${this.pendingAssistantThought.get(safe) ?? ''}${delta}`;
    const bounded = combined.length <= MAX_ASSISTANT_THOUGHT_CHARS
      ? combined
      : `${TRUNCATED_THOUGHT_PREFIX}${combined.slice(-(MAX_ASSISTANT_THOUGHT_CHARS - TRUNCATED_THOUGHT_PREFIX.length))}`;
    this.pendingAssistantThought.set(safe, bounded);
    currentChatRun()?.checkpoint?.();
  }

  private trackAssistantDraft(run: ChatRun, user: SessionMessage): void {
    let lastSaved = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let checkpointFailure: unknown;
    run.checkpoint = (force = false) => {
      if (checkpointFailure) throw checkpointFailure;
      const now = Date.now();
      if (!force && now - lastSaved < 1000) {
        if (!timer) {
          timer = setTimeout(() => {
            timer = undefined;
            if (run.controller.signal.aborted) return;
            try { run.checkpoint?.(true); }
            catch (error) {
              checkpointFailure = error;
              console.error('SESSION_DRAFT_CHECKPOINT_FAILED', error);
            }
          }, 1000 - (now - lastSaved));
          timer.unref();
        }
        return;
      }
      if (timer) { clearTimeout(timer); timer = undefined; }
      const thought = this.pendingAssistantThought.get(run.sessionId);
      const activities = this.pendingToolActivity.get(run.sessionId);
      this.database.checkpointDraft(run.sessionId, run.runId, {
        role: 'assistant', content: run.partial, at: new Date(now).toISOString(),
        run_id: run.runId, reply_to_run_id: run.runId, mode: user.mode,
        ...(thought ? { reasoning: { version: 1, format: 'public_summary', content: thought } } : {}),
        ...(activities?.size ? { tool_activity: [...activities.values()] } : {}),
      });
      lastSaved = now;
    };
    run.finalizePersistence = () => {
      if (timer) { clearTimeout(timer); timer = undefined; }
      try {
        run.checkpoint?.(true);
        this.database.finishDraft(run.sessionId, run.runId);
      } finally {
        this.pendingAssistantThought.delete(run.sessionId);
        this.pendingToolActivity.delete(run.sessionId);
      }
    };
  }

  append(id: string, message: SessionMessage): SessionRecord {
    assertChatRunWritable(id);
    const run = currentChatRun();
    if (run) {
      message = {
        ...message,
        run_id: run.runId,
        ...(message.role === 'assistant' ? { reply_to_run_id: run.runId, status: 'completed' as const } : {}),
      };
    }
    const rec = this.ensure(id);
    let storedMessage = message;
    if (message.role === 'assistant') {
      const pendingThought = this.pendingAssistantThought.get(rec.id);
      const reasoningContent = message.reasoning?.content || message.thought || pendingThought;
      const { thought: _legacyThought, ...normalizedMessage } = message;
      const activities = this.pendingToolActivity.get(rec.id);
      if (activities?.size) normalizedMessage.tool_activity = [...activities.values()];
      storedMessage = reasoningContent?.trim()
        ? {
            ...normalizedMessage,
            reasoning: {
              version: 1,
              format: 'public_summary',
              content: reasoningContent,
              ...(message.model ? { model: message.model } : message.reasoning?.model ? { model: message.reasoning.model } : {}),
            },
          }
        : normalizedMessage;
    }
    rec.messages.push(storedMessage);
    if (storedMessage.role === 'user' && rec.title === '새 대화') {
      rec.title = storedMessage.content.trim().slice(0, 48) || '새 대화';
    }
    rec.updated_at = new Date().toISOString();
    this.database.append(rec, storedMessage);
    if (storedMessage.role === 'assistant') {
      this.pendingAssistantThought.delete(rec.id);
      this.pendingToolActivity.delete(rec.id);
    }
    if (run && storedMessage.role === 'user') this.trackAssistantDraft(run, storedMessage);
    if (rec.project_id) this.onProjectActivity?.(rec.project_id);
    return rec;
  }

  updateMessageContent(id: string, index: number, content: string): SessionRecord | null {
    assertChatRunWritable(id);
    const rec = this.load(id);
    if (!rec) return null;
    if (!Number.isInteger(index) || index < 0 || index >= rec.messages.length) return null;
    const next = content.trim();
    if (!next) return null;
    rec.messages[index] = {
      ...rec.messages[index],
      content: next,
      at: new Date().toISOString(),
    };
    rec.updated_at = new Date().toISOString();
    this.save(rec);
    if (rec.project_id) this.onProjectActivity?.(rec.project_id);
    return rec;
  }

  finalizeStoppedRun(run: ChatRun): void {
    assertChatRunWritable(run.sessionId);
    const rec = this.load(run.sessionId);
    if (!rec || !rec.messages.some((m) => m.role === 'user' && m.run_id === run.runId)) return;
    const replies = rec.messages.filter((m) => m.role === 'assistant' && m.run_id === run.runId);
    if (replies.length) {
      for (const message of replies) { message.status = 'stopped'; message.model_exclude = true; }
    } else {
      const activities = this.pendingToolActivity.get(rec.id);
      rec.messages.push({
        role: 'assistant',
        content: run.partial.trim() || '(중지됨)',
        at: new Date().toISOString(),
        run_id: run.runId,
        reply_to_run_id: run.runId,
        status: 'stopped',
        model_exclude: true,
        thought: this.pendingAssistantThought.get(rec.id),
        ...(activities?.size ? { tool_activity: [...activities.values()] } : {}),
      });
    }
    delete rec.responses_state;
    delete rec.responses_states;
    rec.updated_at = new Date().toISOString();
    this.save(rec);
    this.pendingAssistantThought.delete(rec.id);
    this.pendingToolActivity.delete(rec.id);
  }

  delete(id: string): boolean {
    const safe = sanitizeId(id);
    if (!safe) return false;
    const rec = this.load(safe);
    if (!this.database.delete(safe)) return false;
    this.pendingAssistantThought.delete(safe);
    this.pendingToolActivity.delete(safe);
    try {
      const workspaceRoot = rec ? this.resolveWorkspaceRoot?.(rec) ?? null : null;
      gcDeletedSessionTemp(this.cqrRoot, safe, this.loadAll(), workspaceRoot);
    } catch {
      /* session transaction already committed */
    }
    return true;
  }

  recentMessages(id: string, limit = 20): SessionMessage[] {
    const safe = sanitizeId(id);
    return safe ? this.database.recent(safe, limit) : [];
  }

  messagePage(id: string, limit = 50, before?: number): MessagePage | null {
    const safe = sanitizeId(id);
    return safe ? this.database.page(safe, limit, before) : null;
  }

  setWorkspaceProject(id: string, workspaceProjectId: string | null): SessionRecord | null {
    const rec = this.load(id);
    if (!rec) return null;
    rec.workspace_project_id = workspaceProjectId ? sanitizeId(workspaceProjectId) : null;
    rec.updated_at = new Date().toISOString();
    this.save(rec);
    return rec;
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

  setScopeSettings(
    id: string,
    patch: { preferred_model?: string | null; allowed_paths?: string[] },
  ): SessionRecord | null {
    const rec = this.load(id);
    if (!rec) return null;
    if (patch.preferred_model !== undefined) {
      const model = patch.preferred_model?.trim();
      if (model) rec.preferred_model = model.slice(0, 240);
      else delete rec.preferred_model;
    }
    if (patch.allowed_paths !== undefined) {
      const roots = [...new Set(
        patch.allowed_paths
          .map((entry) => String(entry ?? '').trim())
          .filter((entry) => entry && path.isAbsolute(entry))
          .map((entry) => path.resolve(entry)),
      )];
      if (roots.length) rec.allowed_paths = roots;
      else delete rec.allowed_paths;
    }
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

  /** Compact public projection used by workspace trees and settings responses. */
  getSummary(rec: SessionRecord): SessionSummary {
    return {
      id: rec.id,
      title: rec.title,
      updated_at: rec.updated_at,
      message_count: rec.messages.length,
      project_id: rec.project_id ?? null,
      workspace_project_id: rec.workspace_project_id ?? null,
      preferred_model: rec.preferred_model,
      allowed_paths: rec.allowed_paths ?? [],
      archived: rec.archived === true,
    };
  }

  private save(rec: SessionRecord): void {
    assertChatRunWritable(rec.id);
    this.database.save(rec);
  }
}

function sanitizeId(id: string): string | null {
  const s = id.trim().slice(0, 64);
  if (!/^[a-zA-Z0-9_-]+$/.test(s)) return null;
  return s;
}
