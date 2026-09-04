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
  now?: string;
}

const unique = (values: string[], cap: number): string[] =>
  [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))].slice(0, cap);

/** Durable resume state. It is persisted after steps but never injected as a chat checkpoint. */
export function buildAgentContinuationSnapshot(
  input: AgentContinuationSnapshotInput,
): AgentContinuationSnapshot {
  const model = String(input.model || '').trim().slice(0, 200);
  const lastModelOutput = String(input.lastModelOutput || '').trim().slice(-6_000);
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
  };
}

export function formatAgentContinuationResumeNote(snapshot: AgentContinuationSnapshot): string {
  const todoLines = snapshot.todoLedger?.todos
    .filter((todo) => todo.status !== 'done')
    .map((todo) => `- [${todo.status}] ${todo.id}: ${todo.text}${todo.nextAction ? ` · next=${todo.nextAction}` : ''}`) ?? [];
  return [
    '## Continuation Snapshot',
    `step=${snapshot.step} elapsedMs=${snapshot.elapsedMs} payloadChars=${snapshot.payloadChars}`,
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
