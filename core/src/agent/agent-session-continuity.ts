/**
 * Session continuity — seed readGate / skip cold-start re-diagnosis on resumed runs.
 * The user's wording is never classified here: a host retry resumes automatically, and
 * otherwise the model decides via active_task resume_run / discard_run.
 */
import {
  appendSessionMutatedPaths,
  appendSessionReadPaths,
  loadAgentRunMeta,
  type AgentRunMeta,
} from './agent-run-meta.js';
import { WorkspaceReadGate } from './tool-read-gate.js';
import {
  formatAgentProgressResumeNote,
  type AgentProgressCheckpoint,
} from './agent-progress-checkpoint.js';
import type { AgentRunMeta as PendingMeta } from './agent-run-meta.js';
import {
  formatAgentContinuationResumeNote,
  type AgentContinuationSnapshot,
} from './agent-continuation-snapshot.js';

/**
 * Automatic resume at run start is host-owned only (infra retry of the same turn).
 * A user turn never auto-resumes from its wording; stored state stays pending and the
 * model chooses resume_run / discard_run.
 */
export function shouldUseSessionContinuity(opts: {
  readPaths: string[];
  mutatedPaths: string[];
  hasProgressCheckpoint?: boolean;
  hasContinuationSnapshot?: boolean;
  /**
   * Host-owned resume (infra retry / auto-resume of the same turn). Independent of wording.
   */
  force?: boolean;
}): boolean {
  if (
    !opts.readPaths.length
    && !opts.mutatedPaths.length
    && !opts.hasProgressCheckpoint
    && !opts.hasContinuationSnapshot
  ) return false;
  return opts.force === true;
}

/** Pending resume state older than this is dropped at run start (default 24h). */
export const DEFAULT_CONTINUATION_TTL_HOURS = 24;

export function continuationTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseFloat(String(env.MY_AGENT_CONTINUATION_TTL_HOURS ?? ''));
  const hours = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CONTINUATION_TTL_HOURS;
  return hours * 3_600_000;
}

export function isContinuationExpired(
  at: string | undefined,
  nowMs: number = Date.now(),
  ttlMs: number = continuationTtlMs(),
): boolean {
  const t = Date.parse(String(at || ''));
  if (!Number.isFinite(t)) return false;
  return nowMs - t > ttlMs;
}

export interface PendingContinuation {
  snapshot?: AgentContinuationSnapshot;
  checkpoint?: AgentProgressCheckpoint;
}

/** Unexpired stored resume state of this session, or null. */
export function selectPendingContinuation(
  meta: Pick<PendingMeta, 'continuationSnapshot' | 'lastProgressCheckpoint'>,
  nowMs: number = Date.now(),
  ttlMs: number = continuationTtlMs(),
): PendingContinuation | null {
  const snapshot = meta.continuationSnapshot;
  const checkpoint = snapshot ? undefined : meta.lastProgressCheckpoint;
  if (!snapshot && !checkpoint) return null;
  if (isContinuationExpired(snapshot?.at ?? checkpoint?.at, nowMs, ttlMs)) return null;
  return snapshot ? { snapshot } : { checkpoint };
}

/**
 * Turn-context note for a stored, not-yet-resumed run. The model decides from the
 * conversation whether the latest request continues it; the runtime does not.
 */
export function formatPendingContinuationTurnNote(
  pending: PendingContinuation,
  max: number = maxContinuationResumes(),
): string {
  const snap = pending.snapshot;
  const cp = pending.checkpoint;
  const used = snap?.resumeCount ?? 0;
  const todos = snap?.todoLedger?.todos
    .filter((todo) => todo.status !== 'done')
    .slice(0, 8)
    .map((todo) => `- [${todo.status}] ${todo.id}: ${todo.text}`) ?? [];
  return [
    '## Unfinished previous run (stored, not resumed)',
    `saved_at=${snap?.at ?? cp?.at ?? 'unknown'} step=${snap?.step ?? cp?.step ?? 0} resumes_used=${used}/${max}${snap?.model ? ` model=${snap.model}` : ''}`,
    snap?.mutatedPaths.length ? `mutated=${snap.mutatedPaths.slice(0, 12).join(', ')}` : '',
    snap?.unresolvedFailures.length ? `unresolved_failures=${snap.unresolvedFailures.slice(0, 4).join(' | ')}` : '',
    cp?.resumeFrom ? `resume_from=${cp.resumeFrom}` : '',
    todos.length ? 'Unfinished TODO:' : '',
    ...todos,
    'Decide from the conversation whether the latest request continues this run:',
    '- Continue it: call active_task action=resume_run before other work. It restores the run state and lists files unchanged since then (read_before_write satisfied) vs. files to re-read.',
    '- Clearly obsolete: call active_task action=discard_run.',
    '- Unrelated question: answer it; the stored run stays pending. Mutating files without resume_run starts a new run and replaces the stored state.',
  ].filter(Boolean).join('\n');
}

/** Default cap on user 「이어서」 resumes of one continuation chain (each gets a fresh step budget). */
export const DEFAULT_MAX_CONTINUATION_RESUMES = 5;

export function maxContinuationResumes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(String(env.MY_AGENT_MAX_CONTINUATION_RESUMES ?? ''), 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MAX_CONTINUATION_RESUMES;
}

/**
 * Resume accounting for one run. A user 「이어서」 from a stored snapshot counts as a resume;
 * a host retry of the same turn does not (it re-runs the attempt that failed).
 */
export function resolveContinuationResume(opts: {
  hasSnapshot: boolean;
  snapshotResumeCount?: number;
  retry: boolean;
  max?: number;
}): { resumeCount: number; exhausted: boolean; max: number } {
  const max = opts.max ?? maxContinuationResumes();
  const base = Math.max(0, Math.trunc(Number(opts.snapshotResumeCount) || 0));
  const resumeCount = opts.hasSnapshot && !opts.retry ? base + 1 : base;
  return { resumeCount, exhausted: resumeCount > max, max };
}

export function formatSessionContinuitySystemNote(opts: {
  readPaths: string[];
  mutatedPaths: string[];
  progressCheckpoint?: AgentProgressCheckpoint;
  continuationSnapshot?: AgentContinuationSnapshot;
  /**
   * Paths actually seeded into read_before_write (unchanged on disk since the snapshot).
   * When provided, only these are announced as known.
   */
  seededPaths?: string[];
  /** Chain paths that changed on disk (or lack a fingerprint) — must be re-read. */
  stalePaths?: string[];
}): string {
  const known = (opts.seededPaths
    ? [...new Set(opts.seededPaths)]
    : [...new Set([...opts.readPaths, ...opts.mutatedPaths])]).slice(0, 16);
  const stale = [...new Set(opts.stalePaths ?? [])].slice(0, 16);
  const lines = [
    '## Session continuity (readGate seeded)',
    'This run resumes earlier work. Do NOT re-list the whole repo or redo completed discovery.',
    'If edit_file fails (stale snippet), then read_file that one path and retry — not a full diagnosis.',
  ];
  if (known.length) {
    lines.push(`Known paths (unchanged on disk; read_before_write already satisfied): ${known.join(', ')}`);
  }
  if (stale.length) {
    lines.push(`Changed on disk or not verified since the last run (read_file again before mutating): ${stale.join(', ')}`);
  }
  if (opts.seededPaths) {
    lines.push('Any path not listed as known must be read_file\'d before write/edit/delete.');
  }
  lines.push('Continue from the known paths. Skip query_repo_map unless the target path is unknown.');
  if (opts.continuationSnapshot) {
    lines.push(formatAgentContinuationResumeNote(opts.continuationSnapshot));
  } else if (opts.progressCheckpoint) {
    // Backward compatibility for sessions persisted before Continuation Snapshot.
    lines.push(formatAgentProgressResumeNote(opts.progressCheckpoint));
  }
  return lines.join('\n');
}

/** Mark session-known paths as already read for this run's WorkspaceReadGate. */
export function seedReadGateFromSession(
  gate: WorkspaceReadGate,
  paths: string[],
): string[] {
  const seeded: string[] = [];
  for (const raw of paths) {
    const p = String(raw || '').replace(/\\/g, '/').trim();
    if (!p) continue;
    gate.noteReadFile(p);
    seeded.push(WorkspaceReadGate.normalizeRel(p));
  }
  return [...new Set(seeded)];
}

/**
 * Flush live mutate/read paths when a run dies before `finish()`.
 */
export function persistInterruptedAgentProgress(opts: {
  cqrRoot: string;
  sessionId: string | undefined;
  mutatedPaths: string[];
  readPaths: string[];
  userMessage?: string;
}): AgentRunMeta {
  if (opts.mutatedPaths.length) {
    appendSessionMutatedPaths(opts.cqrRoot, opts.sessionId, opts.mutatedPaths);
  }
  if (opts.readPaths.length) {
    appendSessionReadPaths(opts.cqrRoot, opts.sessionId, opts.readPaths);
  }
  return loadAgentRunMeta(opts.cqrRoot, opts.sessionId);
}

/** Mid-run flush so 504 after tools still leaves accurate session meta. */
export function flushLiveSessionProgress(opts: {
  cqrRoot: string;
  sessionId: string | undefined;
  mutatedPaths: string[];
  readPaths: string[];
}): void {
  if (opts.mutatedPaths.length) {
    appendSessionMutatedPaths(opts.cqrRoot, opts.sessionId, opts.mutatedPaths);
  }
  if (opts.readPaths.length) {
    appendSessionReadPaths(opts.cqrRoot, opts.sessionId, opts.readPaths);
  }
}

/**
 * A text answer must not erase a stored run when this turn did no work.
 * active_task resume/discard is a decision, not work. Any other tool name counts as work.
 */
export function shouldKeepStoredContinuationOnTextComplete(opts: {
  toolNames: readonly string[];
  hadStoredContinuationAtStart: boolean;
}): boolean {
  if (!opts.hadStoredContinuationAtStart) return false;
  return opts.toolNames.every((name) => name === 'active_task');
}

/**
 * Replacing a pending run by mutating without resume_run must not reset the cap.
 * Carry the stored count; do not increment (increment is only for resume_run).
 */
export function carriedResumeCountOnReplace(
  current: number,
  pendingResumeCount: number | undefined,
): number {
  const carried = Math.max(0, Math.trunc(Number(pendingResumeCount) || 0));
  const now = Math.max(0, Math.trunc(Number(current) || 0));
  return Math.max(now, carried);
}

/** Shown when this run must not overwrite the stored resume state. */
export const CONTINUATION_UNSAVED_NOTICE =
  '이번 실행은 재개 상태를 저장하지 못했습니다. 이전 실행은 그대로입니다.';

export function continuationPersistStatus(saved: boolean, savedStatus: string): string {
  return saved ? savedStatus : '재개 상태 저장 안 함 · 이전 실행은 그대로';
}
