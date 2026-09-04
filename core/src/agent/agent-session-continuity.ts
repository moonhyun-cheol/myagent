/**
 * Session continuity — seed readGate / skip cold-start re-diagnosis on continue turns.
 * Applies only to an explicit short continue request.
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
import {
  formatAgentContinuationResumeNote,
  type AgentContinuationSnapshot,
} from './agent-continuation-snapshot.js';

export function shouldUseSessionContinuity(opts: {
  userMessage: string;
  readPaths: string[];
  mutatedPaths: string[];
  hasProgressCheckpoint?: boolean;
  hasContinuationSnapshot?: boolean;
}): boolean {
  if (
    !opts.readPaths.length
    && !opts.mutatedPaths.length
    && !opts.hasProgressCheckpoint
    && !opts.hasContinuationSnapshot
  ) return false;
  return /^(?:(?:이어서|계속(?:해서)?|마저)(?:\s*(?:진행|작업))?(?:\s*(?:하자|해|해줘|해주세요))?|계속해(?:요|줘|주세요)?)\s*[.!。]*$/i.test(
    String(opts.userMessage || '').trim(),
  );
}

export function formatSessionContinuitySystemNote(opts: {
  readPaths: string[];
  mutatedPaths: string[];
  progressCheckpoint?: AgentProgressCheckpoint;
  continuationSnapshot?: AgentContinuationSnapshot;
}): string {
  const known = [...new Set([...opts.readPaths, ...opts.mutatedPaths])].slice(0, 16);
  const lines = [
    '## Session continuity (readGate seeded)',
    'This run reuses paths inspected/mutated earlier in the session. Do NOT re-list the whole repo or re-read every file from scratch.',
    'If edit_file fails (stale snippet), then read_file that one path and retry — not a full diagnosis.',
  ];
  if (known.length) {
    lines.push(`Known paths (read_before_write already satisfied): ${known.join(', ')}`);
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
