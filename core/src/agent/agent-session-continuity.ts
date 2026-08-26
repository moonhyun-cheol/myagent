/**
 * Session continuity — seed readGate / skip cold-start re-diagnosis on continue turns.
 * Complements openGate (Exit Gate) without adding more prose claim gates.
 */
import type { SessionOpenGate } from './agent-open-gate.js';
import { openGateBlocksDoneClaim } from './agent-open-gate.js';
import {
  appendSessionMutatedPaths,
  appendSessionReadPaths,
  loadAgentRunMeta,
  setSessionOpenGate,
  type AgentRunMeta,
} from './agent-run-meta.js';
import { WorkspaceReadGate } from './tool-read-gate.js';

/** Interrupt / resume Exit Gate (infra stop) — not Critic 「다음 수정」. */
export function isInterruptOpenGate(gate: SessionOpenGate | null | undefined): boolean {
  if (!openGateBlocksDoneClaim(gate)) return false;
  return gate?.source === 'outcome' && gate.evidence?.kind === 'mutate';
}

export function shouldUseSessionContinuity(opts: {
  userMessage: string;
  openGate: SessionOpenGate | null | undefined;
  readPaths: string[];
  mutatedPaths: string[];
}): boolean {
  void opts.userMessage;
  void opts.readPaths;
  void opts.mutatedPaths;
  return openGateBlocksDoneClaim(opts.openGate);
}

export function formatSessionContinuitySystemNote(opts: {
  readPaths: string[];
  mutatedPaths: string[];
  openGate: SessionOpenGate | null | undefined;
}): string {
  const known = [...new Set([...opts.readPaths, ...opts.mutatedPaths])].slice(0, 16);
  const interrupt =
    openGateBlocksDoneClaim(opts.openGate)
    && /중단|복구|resume|interrupt/i.test(opts.openGate!.gate);
  const lines = [
    '## Session continuity (readGate seeded)',
    'This run reuses paths inspected/mutated earlier in the session. Do NOT re-list the whole repo or re-read every file from scratch.',
    'If edit_file fails (stale snippet), then read_file that one path and retry — not a full diagnosis.',
  ];
  if (interrupt) {
    lines.push(
      'Prior run was interrupted (infra/stop). Disk may already have partial edits — verify known paths before claiming 완료; do not re-apply the same patch blindly.',
    );
  }
  if (known.length) {
    lines.push(`Known paths (read_before_write already satisfied): ${known.join(', ')}`);
  }
  if (openGateBlocksDoneClaim(opts.openGate)) {
    lines.push(`Open Exit Gate only: ${opts.openGate!.gate}`);
    lines.push('Close that gate with mutate/verify evidence. No Understanding Card reset.');
  } else {
    lines.push('Mutate now on the known paths. Skip query_repo_map unless the target path is unknown.');
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

/** Thin Exit Gate so the next 「이어서」 has a single resume target after infra/stop. */
export function buildInterruptResumeOpenGate(opts: {
  mutatedPaths: string[];
  readPaths: string[];
  userMessage?: string;
}): SessionOpenGate {
  const path = [...opts.mutatedPaths, ...opts.readPaths]
    .map((p) => String(p || '').replace(/\\/g, '/').trim())
    .find(Boolean);
  // Keep gate short — embedding a full greenfield brief poisons later turns.
  const goal = String(opts.userMessage || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const gate = !goal
    ? '중단된 코드 작업을 이어서 완료 (디스크 변경 확인·검증)'
    : path
      ? `중단 복구: ${path} · ${goal}`
      : `중단 복구: ${goal}`;
  const out: SessionOpenGate = {
    updatedAt: new Date().toISOString(),
    status: 'open',
    gate,
    source: 'outcome',
  };
  if (path) out.evidence = { kind: 'mutate', path };
  return out;
}

/**
 * Flush live mutate/read paths + open a resume Exit Gate when a run dies
 * before `finish()` (504 / abort / throw). Safe to call multiple times.
 */
export function persistInterruptedAgentProgress(opts: {
  cqrRoot: string;
  sessionId: string | undefined;
  mutatedPaths: string[];
  readPaths: string[];
  userMessage?: string;
  /** When true, always refresh interrupt openGate (unless a non-interrupt gate is already open). */
  setOpenGate?: boolean;
}): AgentRunMeta {
  if (opts.mutatedPaths.length) {
    appendSessionMutatedPaths(opts.cqrRoot, opts.sessionId, opts.mutatedPaths);
  }
  if (opts.readPaths.length) {
    appendSessionReadPaths(opts.cqrRoot, opts.sessionId, opts.readPaths);
  }
  let meta = loadAgentRunMeta(opts.cqrRoot, opts.sessionId);
  const mutated =
    opts.mutatedPaths.length > 0 ? opts.mutatedPaths : meta.mutatedPaths ?? [];
  const reads =
    opts.readPaths.length > 0 ? opts.readPaths : meta.readPaths ?? [];
  // No disk breadcrumbs → skip interrupt gate (empty gate + auto-resume = HTTP 500 thrash).
  const hasBreadcrumbs = mutated.length > 0 || reads.length > 0;
  if (
    opts.setOpenGate !== false
    && hasBreadcrumbs
    && !openGateBlocksDoneClaim(meta.openGate)
  ) {
    meta = setSessionOpenGate(
      opts.cqrRoot,
      opts.sessionId,
      buildInterruptResumeOpenGate({
        mutatedPaths: mutated,
        readPaths: reads,
        userMessage: opts.userMessage,
      }),
    );
  }
  return meta;
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
