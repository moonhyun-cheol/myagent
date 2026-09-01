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

export function shouldUseSessionContinuity(opts: {
  userMessage: string;
  readPaths: string[];
  mutatedPaths: string[];
}): boolean {
  if (!opts.readPaths.length && !opts.mutatedPaths.length) return false;
  return /^(?:이어서|계속(?:해서)?|계속해(?:요|줘|주세요)?|마저(?:\s*해)?)\s*[.!。]*$/i.test(
    String(opts.userMessage || '').trim(),
  );
}

export function formatSessionContinuitySystemNote(opts: {
  readPaths: string[];
  mutatedPaths: string[];
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
