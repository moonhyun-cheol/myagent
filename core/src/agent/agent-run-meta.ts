/**
 * Session-scoped agent run metadata (mutated paths across turns).
 * Stored under data/agent-run-meta/<sessionId>.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentPerfSnapshot } from './agent-perf-metrics.js';

/** Per-role contribution under a Supervisor parent run (ADR-005 MAR). */
export interface AgentRoleContribution {
  agentId: string;
  parentRunId: string;
  role: string;
  mutatedPaths: string[];
  at: string;
}

export type ActiveTaskStatus = 'active' | 'blocked' | 'done' | 'cancelled';

/**
 * One model-authored unit of unfinished work. The runtime persists and reinjects
 * this record but never infers it from user prose.
 */
export interface SessionActiveTask {
  updatedAt: string;
  status: ActiveTaskStatus;
  objective: string;
  acceptance: string;
  blocker?: string;
  relatedPaths?: string[];
  closeReason?: string;
}

export interface AgentRunMeta {
  updatedAt: string;
  mutatedPaths: string[];
  /**
   * Paths successfully read_file'd this session (newest first, capped).
   * Seeds WorkspaceReadGate on later turns so continue/mutate skips cold re-read.
   */
  readPaths?: string[];
  /** Last completed run performance snapshot (P2). */
  lastPerf?: AgentPerfSnapshot;
  /** Supervisor parent run id for the latest MAR turn (if any). */
  parentRunId?: string;
  /** Last specialist agent id that wrote to this session meta. */
  agentId?: string;
  /** Recent role contributions (newest first, capped). */
  roleContributions?: AgentRoleContribution[];
  /** Single model-authored task that may survive a blocked/deferred turn. */
  activeTask?: SessionActiveTask | null;
  /**
   * Short durable facts that must survive history compress
   * (paths, product names, numeric decisions). Newest-first, capped.
   */
  pinnedFacts?: string[];
  /** Absolute child folder locked for this session (bag-of-projects parent). */
  lockedTargetRoot?: string | null;
  /** Last compress / context budget snapshot for UX + diagnostics. */
  lastContextBudget?: {
    at: string;
    usedChars: number;
    budgetChars: number;
    /** Model's full advertised context window, in tokens. */
    contextLength?: number;
    /** Context window after output/reasoning reserve, in tokens. */
    effectiveContextLength?: number;
    compressed: boolean;
    fallback128k: boolean;
    foldedTurns?: number;
    modelId?: string | null;
    mismatch?: string | null;
  };
}

function sanitizeSessionKey(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'default';
}

function metaDir(cqrRoot: string): string {
  return path.join(cqrRoot, 'data', 'agent-run-meta');
}

export function agentRunMetaPath(cqrRoot: string, sessionId: string): string {
  return path.join(metaDir(cqrRoot), `${sanitizeSessionKey(sessionId)}.json`);
}

function normalizePathList(raw: unknown, cap: number): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((p) => String(p).replace(/\\/g, '/').trim()).filter(Boolean))].slice(
    0,
    cap,
  );
}

function normalizeActiveTask(
  raw: Partial<SessionActiveTask> | null | undefined,
): SessionActiveTask | null {
  if (!raw || typeof raw !== 'object') return null;
  const objective = String(raw.objective || '').trim().slice(0, 500);
  const acceptance = String(raw.acceptance || '').trim().slice(0, 500);
  if (!objective || !acceptance) return null;
  const allowed: ActiveTaskStatus[] = ['active', 'blocked', 'done', 'cancelled'];
  const status = allowed.includes(raw.status as ActiveTaskStatus)
    ? raw.status as ActiveTaskStatus
    : 'active';
  const out: SessionActiveTask = {
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
    status,
    objective,
    acceptance,
  };
  const blocker = String(raw.blocker || '').trim().slice(0, 500);
  if (blocker) out.blocker = blocker;
  const relatedPaths = normalizePathList(raw.relatedPaths, 12);
  if (relatedPaths.length) out.relatedPaths = relatedPaths;
  const closeReason = String(raw.closeReason || '').trim().slice(0, 300);
  if (closeReason) out.closeReason = closeReason;
  return out;
}

function normalizeMeta(raw: Partial<AgentRunMeta> | null | undefined): AgentRunMeta {
  const paths = normalizePathList(raw?.mutatedPaths, 40);
  const readPaths = normalizePathList(raw?.readPaths, 40);
  const contributions = Array.isArray(raw?.roleContributions)
    ? (raw!.roleContributions as AgentRoleContribution[])
        .filter((c) => c && typeof c.agentId === 'string' && typeof c.parentRunId === 'string')
        .slice(0, 20)
    : undefined;
  const out: AgentRunMeta = {
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
    mutatedPaths: paths,
  };
  if (readPaths.length) out.readPaths = readPaths;
  if (raw?.lastPerf && typeof raw.lastPerf === 'object') {
    out.lastPerf = raw.lastPerf as AgentPerfSnapshot;
  }
  if (typeof raw?.parentRunId === 'string' && raw.parentRunId.trim()) {
    out.parentRunId = raw.parentRunId.trim();
  }
  if (typeof raw?.agentId === 'string' && raw.agentId.trim()) {
    out.agentId = raw.agentId.trim();
  }
  if (contributions?.length) out.roleContributions = contributions;
  const activeTask = normalizeActiveTask(raw?.activeTask ?? null);
  if (activeTask) out.activeTask = activeTask;
  const pins = Array.isArray(raw?.pinnedFacts)
    ? [...new Set(raw!.pinnedFacts.map((f) => String(f || '').trim()).filter(Boolean))].slice(0, 24)
    : [];
  if (pins.length) out.pinnedFacts = pins;
  if (raw?.lastContextBudget && typeof raw.lastContextBudget === 'object') {
    out.lastContextBudget = raw.lastContextBudget as AgentRunMeta['lastContextBudget'];
  }
  const locked = String(raw?.lockedTargetRoot || '').trim();
  if (locked) out.lockedTargetRoot = locked;
  return out;
}

function carryMeta(prev: AgentRunMeta): Pick<
  AgentRunMeta,
  | 'lastPerf'
  | 'parentRunId'
  | 'agentId'
  | 'roleContributions'
  | 'activeTask'
  | 'readPaths'
  | 'pinnedFacts'
  | 'lastContextBudget'
  | 'lockedTargetRoot'
> {
  const out: Pick<
    AgentRunMeta,
    | 'lastPerf'
    | 'parentRunId'
    | 'agentId'
    | 'roleContributions'
    | 'activeTask'
    | 'readPaths'
    | 'pinnedFacts'
    | 'lastContextBudget'
    | 'lockedTargetRoot'
  > = {};
  if (prev.lastPerf) out.lastPerf = prev.lastPerf;
  if (prev.parentRunId) out.parentRunId = prev.parentRunId;
  if (prev.agentId) out.agentId = prev.agentId;
  if (prev.roleContributions?.length) out.roleContributions = prev.roleContributions;
  if (prev.activeTask) out.activeTask = prev.activeTask;
  if (prev.readPaths?.length) out.readPaths = prev.readPaths;
  if (prev.pinnedFacts?.length) out.pinnedFacts = prev.pinnedFacts;
  if (prev.lastContextBudget) out.lastContextBudget = prev.lastContextBudget;
  if (prev.lockedTargetRoot) out.lockedTargetRoot = prev.lockedTargetRoot;
  return out;
}

export function loadAgentRunMeta(
  cqrRoot: string,
  sessionId: string | undefined,
): AgentRunMeta {
  if (!sessionId?.trim()) return normalizeMeta(null);
  const fp = agentRunMetaPath(cqrRoot, sessionId);
  if (!existsSync(fp)) return normalizeMeta(null);
  try {
    return normalizeMeta(JSON.parse(readFileSync(fp, 'utf8')) as AgentRunMeta);
  } catch {
    return normalizeMeta(null);
  }
}

export function saveAgentRunMeta(
  cqrRoot: string,
  sessionId: string | undefined,
  meta: AgentRunMeta,
): void {
  if (!sessionId?.trim()) return;
  mkdirSync(metaDir(cqrRoot), { recursive: true });
  const fp = agentRunMetaPath(cqrRoot, sessionId);
  writeFileSync(fp, `${JSON.stringify(normalizeMeta(meta), null, 2)}\n`, 'utf8');
}

/** Merge newly mutated paths into session meta (newest first). */
export function appendSessionMutatedPaths(
  cqrRoot: string,
  sessionId: string | undefined,
  paths: string[],
): AgentRunMeta {
  const prev = loadAgentRunMeta(cqrRoot, sessionId);
  const cleaned = paths.map((p) => p.replace(/\\/g, '/').trim()).filter(Boolean);
  const merged = [...cleaned, ...prev.mutatedPaths];
  // Mutate implies known for read_before_write on later turns.
  const readPaths = [...cleaned, ...(prev.readPaths ?? [])];
  const next = normalizeMeta({
    updatedAt: new Date().toISOString(),
    mutatedPaths: merged,
    ...carryMeta(prev),
    readPaths,
  });
  saveAgentRunMeta(cqrRoot, sessionId, next);
  return next;
}

/** Merge successfully read paths into session meta (newest first). */
export function appendSessionReadPaths(
  cqrRoot: string,
  sessionId: string | undefined,
  paths: string[],
): AgentRunMeta {
  const prev = loadAgentRunMeta(cqrRoot, sessionId);
  const cleaned = paths.map((p) => p.replace(/\\/g, '/').trim()).filter(Boolean);
  if (!cleaned.length) return prev;
  const next = normalizeMeta({
    updatedAt: new Date().toISOString(),
    mutatedPaths: prev.mutatedPaths,
    ...carryMeta(prev),
    readPaths: [...cleaned, ...(prev.readPaths ?? [])],
  });
  saveAgentRunMeta(cqrRoot, sessionId, next);
  return next;
}

/** Persist last-run perf onto session meta (and keep mutated paths). */
export function recordSessionPerf(
  cqrRoot: string,
  sessionId: string | undefined,
  lastPerf: AgentPerfSnapshot,
): AgentRunMeta {
  const prev = loadAgentRunMeta(cqrRoot, sessionId);
  const next = normalizeMeta({
    updatedAt: new Date().toISOString(),
    mutatedPaths: prev.mutatedPaths,
    ...carryMeta(prev),
    lastPerf,
  });
  saveAgentRunMeta(cqrRoot, sessionId, next);
  return next;
}

/** Record a MAR specialist contribution (paths merge into session ledger). */
export function appendRoleContribution(
  cqrRoot: string,
  sessionId: string | undefined,
  contribution: Omit<AgentRoleContribution, 'at'> & { at?: string },
): AgentRunMeta {
  const prev = loadAgentRunMeta(cqrRoot, sessionId);
  const paths = (contribution.mutatedPaths ?? []).map((p) => p.replace(/\\/g, '/').trim()).filter(Boolean);
  const entry: AgentRoleContribution = {
    agentId: contribution.agentId,
    parentRunId: contribution.parentRunId,
    role: contribution.role,
    mutatedPaths: paths,
    at: contribution.at ?? new Date().toISOString(),
  };
  const mergedPaths = [...paths, ...prev.mutatedPaths];
  const roleContributions = [entry, ...(prev.roleContributions ?? [])].slice(0, 20);
  const next = normalizeMeta({
    updatedAt: new Date().toISOString(),
    mutatedPaths: mergedPaths,
    ...carryMeta(prev),
    parentRunId: contribution.parentRunId,
    agentId: contribution.agentId,
    roleContributions,
  });
  saveAgentRunMeta(cqrRoot, sessionId, next);
  return next;
}

export function setSessionActiveTask(
  cqrRoot: string,
  sessionId: string | undefined,
  task: SessionActiveTask | null,
): AgentRunMeta {
  const prev = loadAgentRunMeta(cqrRoot, sessionId);
  const normalized = normalizeActiveTask(task);
  const next = normalizeMeta({
    updatedAt: new Date().toISOString(),
    mutatedPaths: prev.mutatedPaths,
    ...carryMeta(prev),
    activeTask: normalized,
  });
  if (!normalized) delete next.activeTask;
  saveAgentRunMeta(cqrRoot, sessionId, next);
  return next;
}

export function formatActiveTaskSystemNote(task: SessionActiveTask): string {
  return [
    '## Model-authored active task',
    `STATUS: ${task.status}`,
    `OBJECTIVE: ${task.objective}`,
    `ACCEPTANCE: ${task.acceptance}`,
    task.blocker ? `BLOCKER: ${task.blocker}` : '',
    task.relatedPaths?.length ? `RELATED_PATHS: ${task.relatedPaths.join(', ')}` : '',
    'Reconcile this task with the latest user request. The latest explicit correction wins.',
    'Use active_task to replace, block, complete, or cancel it. Do not silently forget it.',
    'Completion is accepted only after this run has disk mutation plus a successful model-requested Acceptance tool.',
    'Automatic TypeScript diagnostics are internal repair evidence and never complete this task.',
  ].filter(Boolean).join('\n');
}

/** Merge short durable facts that must survive history compress. */
export function appendSessionPinnedFacts(
  cqrRoot: string,
  sessionId: string | undefined,
  facts: string[],
): AgentRunMeta {
  const prev = loadAgentRunMeta(cqrRoot, sessionId);
  const cleaned = facts.map((f) => String(f || '').trim()).filter(Boolean);
  if (!cleaned.length) return prev;
  const next = normalizeMeta({
    updatedAt: new Date().toISOString(),
    mutatedPaths: prev.mutatedPaths,
    ...carryMeta(prev),
    pinnedFacts: [...cleaned, ...(prev.pinnedFacts ?? [])],
  });
  saveAgentRunMeta(cqrRoot, sessionId, next);
  return next;
}

/** Persist last context-budget / compress snapshot for UX + diagnostics. */
export function recordSessionContextBudget(
  cqrRoot: string,
  sessionId: string | undefined,
  snap: NonNullable<AgentRunMeta['lastContextBudget']>,
): AgentRunMeta {
  const prev = loadAgentRunMeta(cqrRoot, sessionId);
  const next = normalizeMeta({
    updatedAt: new Date().toISOString(),
    mutatedPaths: prev.mutatedPaths,
    ...carryMeta(prev),
    lastContextBudget: {
      ...snap,
      at: snap.at || new Date().toISOString(),
    },
  });
  saveAgentRunMeta(cqrRoot, sessionId, next);
  return next;
}

/** Persist or clear the session-bound child workspace lock. */
export function setSessionLockedTarget(
  cqrRoot: string,
  sessionId: string | undefined,
  lockedTargetRoot: string | null,
): AgentRunMeta {
  const prev = loadAgentRunMeta(cqrRoot, sessionId);
  const next = normalizeMeta({
    updatedAt: new Date().toISOString(),
    mutatedPaths: prev.mutatedPaths,
    ...carryMeta(prev),
    lockedTargetRoot: lockedTargetRoot?.trim() || undefined,
  });
  if (!lockedTargetRoot?.trim()) delete next.lockedTargetRoot;
  saveAgentRunMeta(cqrRoot, sessionId, next);
  return next;
}
