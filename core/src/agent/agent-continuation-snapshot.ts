import { statSync } from 'node:fs';
import path from 'node:path';
import type { VerifyWitness } from './agent-claim-gates.js';
import type { TodoLedger } from './agent-todo-types.js';

export interface AgentContinuationSnapshot {
  version: 1;
  at: string;
  step: number;
  elapsedMs: number;
  payloadChars: number;
  model?: string;
  todoLedger?: TodoLedger;
  evidenceRefs: string[];
  readPaths: string[];
  mutatedPaths: string[];
  unresolvedFailures: string[];
  verifyWitness?: VerifyWitness | null;
  lastModelOutput?: string;
  /** User 「이어서」 resumes already spent on this chain (host retries excluded). */
  resumeCount?: number;
  /**
   * Disk fingerprint (`size:mtimeMs`) of read/mutated paths when the snapshot was taken.
   * A resume seeds read_before_write only for paths whose fingerprint still matches.
   */
  pathFingerprints?: Record<string, string>;
}

export interface AgentContinuationSnapshotInput {
  step: number;
  elapsedMs: number;
  payloadChars: number;
  model?: string;
  todoLedger?: TodoLedger | null;
  evidenceRefs: string[];
  readPaths: string[];
  mutatedPaths: string[];
  unresolvedFailures?: string[];
  verifyWitness?: VerifyWitness | null;
  lastModelOutput?: string;
  resumeCount?: number;
  pathFingerprints?: Record<string, string>;
  now?: string;
}

const unique = (values: string[], cap: number): string[] =>
  [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))].slice(0, cap);

const MAX_FINGERPRINTS = 80;

function statFingerprint(workspaceRoot: string, rel: string): string | null {
  try {
    const st = statSync(path.resolve(workspaceRoot, rel));
    if (!st.isFile()) return null;
    return `${st.size}:${Math.trunc(st.mtimeMs)}`;
  } catch {
    return null;
  }
}

/** Current disk fingerprints for workspace paths (missing/unreadable paths are omitted). */
export function fingerprintWorkspacePaths(
  workspaceRoot: string,
  paths: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!workspaceRoot) return out;
  for (const rel of unique(paths, MAX_FINGERPRINTS)) {
    const fp = statFingerprint(workspaceRoot, rel);
    if (fp) out[rel] = fp;
  }
  return out;
}

/**
 * Split resume candidates into paths unchanged on disk since the snapshot (safe to treat as
 * already read) and paths that changed, vanished, or were never fingerprinted (must re-read).
 */
export function partitionPathsByFingerprint(
  workspaceRoot: string,
  paths: string[],
  fingerprints: Record<string, string> | undefined,
): { unchanged: string[]; changed: string[] } {
  const unchanged: string[] = [];
  const changed: string[] = [];
  for (const rel of unique(paths, MAX_FINGERPRINTS)) {
    const prev = fingerprints?.[rel];
    const now = prev ? statFingerprint(workspaceRoot, rel) : null;
    if (prev && now === prev) unchanged.push(rel);
    else changed.push(rel);
  }
  return { unchanged, changed };
}

export function normalizePathFingerprints(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, MAX_FINGERPRINTS)) {
    const k = String(key || '').replace(/\\/g, '/').trim();
    if (k && typeof value === 'string' && /^\d+:\d+$/.test(value)) out[k] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Durable resume state. It is persisted after steps but never injected as a chat checkpoint. */
export function buildAgentContinuationSnapshot(
  input: AgentContinuationSnapshotInput,
): AgentContinuationSnapshot {
  const model = String(input.model || '').trim().slice(0, 200);
  const lastModelOutput = String(input.lastModelOutput || '').trim().slice(-6_000);
  const resumeCount = Math.max(0, Math.trunc(Number(input.resumeCount) || 0));
  const pathFingerprints = normalizePathFingerprints(input.pathFingerprints);
  return {
    version: 1,
    at: input.now ?? new Date().toISOString(),
    step: Math.max(0, Math.trunc(input.step)),
    elapsedMs: Math.max(0, Math.trunc(input.elapsedMs)),
    payloadChars: Math.max(0, Math.trunc(input.payloadChars)),
    ...(model ? { model } : {}),
    ...(input.todoLedger ? { todoLedger: input.todoLedger } : {}),
    evidenceRefs: unique(input.evidenceRefs, 240),
    readPaths: unique(input.readPaths, 40),
    mutatedPaths: unique(input.mutatedPaths, 40),
    unresolvedFailures: unique(input.unresolvedFailures ?? [], 12),
    ...(input.verifyWitness !== undefined ? { verifyWitness: input.verifyWitness } : {}),
    ...(lastModelOutput ? { lastModelOutput } : {}),
    ...(resumeCount ? { resumeCount } : {}),
    ...(pathFingerprints ? { pathFingerprints } : {}),
  };
}

export function formatAgentContinuationResumeNote(snapshot: AgentContinuationSnapshot): string {
  const todoLines = snapshot.todoLedger?.todos
    .filter((todo) => todo.status !== 'done')
    .map((todo) => `- [${todo.status}] ${todo.id}: ${todo.text}${todo.nextAction ? ` · next=${todo.nextAction}` : ''}`) ?? [];
  return [
    '## Continuation Snapshot',
    `step=${snapshot.step} elapsedMs=${snapshot.elapsedMs} payloadChars=${snapshot.payloadChars}${snapshot.resumeCount ? ` resumes=${snapshot.resumeCount}` : ''}`,
    snapshot.model ? `model=${snapshot.model}` : '',
    snapshot.mutatedPaths.length ? `mutated=${snapshot.mutatedPaths.join(', ')}` : '',
    snapshot.readPaths.length ? `read=${snapshot.readPaths.join(', ')}` : '',
    todoLines.length ? 'Unfinished TODO:' : '',
    ...todoLines,
    snapshot.unresolvedFailures.length ? `Unresolved failures: ${snapshot.unresolvedFailures.join(' | ')}` : '',
    snapshot.evidenceRefs.length ? `Evidence refs: ${snapshot.evidenceRefs.join(', ')}` : '',
    'Rebuild the next Context View from this TODO/Evidence state; do not replay completed discovery.',
  ].filter(Boolean).join('\n');
}
