import type { ChatMessage } from '../providers/openai-compatible.js';
import { chatContentToText } from '../providers/openai-compatible.js';
import { resolveContextBudgets } from '../providers/model-context-limits.js';
import type { AgentEvidenceStore } from './agent-evidence-store.js';
import { formatEvidenceEnvelope } from './agent-evidence-store.js';
import type { EvidenceRecord } from './agent-evidence-types.js';
import { evidenceProjectionForm, formatTodoLifecycleSystemNote } from './agent-todo-ledger.js';
import type { RetainHint, TodoLedger } from './agent-todo-types.js';

export type AgentContextPhase = 'plan' | 'work' | 'retry' | 'final';
export type AgentContextAction = 'unchanged' | 'selective_rebuild' | 'full_rebuild';

export interface AgentContextAssemblyInput {
  phase: AgentContextPhase;
  messages: ChatMessage[];
  userMessage: string;
  todoLedger?: TodoLedger | null;
  evidenceStore: AgentEvidenceStore;
  modelId?: string | null;
  recentRoundTrips?: number;
  /** Resume and other lifecycle boundaries rebuild even when the raw payload is small. */
  forceRebuild?: boolean;
}

export interface AgentContextAssemblyResult {
  messages: ChatMessage[];
  action: AgentContextAction;
  usedChars: number;
  budgetChars: number;
  utilization: number;
  projectedEvidenceIds: string[];
}

const TODO_NOTE_PREFIX = '## TODO · Evidence lifecycle';
const CONTEXT_VIEW_PREFIX = '## Runtime context view';
const CHARS_PER_TOKEN_ESTIMATE = 4;

function payloadChars(messages: ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += chatContentToText(message.content).length;
    for (const call of message.tool_calls ?? []) {
      total += call.function.name.length + call.function.arguments.length;
    }
  }
  return total;
}

function refreshTodoSystemNote(messages: ChatMessage[], ledger?: TodoLedger | null): ChatMessage[] {
  const next = messages.filter((message) => !(
    message.role === 'system'
    && chatContentToText(message.content).startsWith(TODO_NOTE_PREFIX)
  ));
  const insertAt = Math.min(1, next.length);
  next.splice(insertAt, 0, { role: 'system', content: formatTodoLifecycleSystemNote(ledger) });
  return next;
}

function evidenceReference(record: EvidenceRecord, note?: string): string {
  return [
    `[evidence reference id=${record.evidenceId} tool=${record.tool} ok=${record.ok} complete=${record.complete}]`,
    record.source?.path ? `source=${record.source.path}` : '',
    `bytes=${record.bytes} sha256=${record.fingerprint}`,
    record.coverage?.returnedRanges?.length
      ? `returnedRanges=${JSON.stringify(record.coverage.returnedRanges)}`
      : '',
    note ?? 'Exact body remains in Evidence Store; call evidence_read when exact text is needed.',
  ].filter(Boolean).join('\n');
}

function matchingRetainHint(record: EvidenceRecord, ledger?: TodoLedger | null): RetainHint | undefined {
  return ledger?.retainEvidence.find((hint) => hint.evidenceId === record.evidenceId);
}

function runtimeMustRetain(record: EvidenceRecord): boolean {
  return !record.ok
    || /^(?:write_file|edit_file|apply_patch|delete_file|rename_file|run_tests|run_diagnostics|browser_)/.test(record.tool);
}

function selectedEvidenceBody(
  record: EvidenceRecord,
  store: AgentEvidenceStore,
  hint?: RetainHint,
): string {
  try {
    return store.read({
      evidenceId: record.evidenceId,
      ...(hint?.selector?.lines?.length ? { lines: hint.selector.lines } : {}),
      ...(hint?.selector?.keys?.length ? { keys: hint.selector.keys } : {}),
    }).content;
  } catch (error) {
    return evidenceReference(record, `Evidence body unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function formatTodoView(ledger: TodoLedger | null | undefined, phase: AgentContextPhase): string {
  if (!ledger) return 'TODO Ledger: no model-authored TODO has been recorded yet.';
  const todos = phase === 'final'
    ? ledger.todos
    : ledger.todos.filter((todo) => todo.status !== 'done');
  return [
    'TODO Ledger:',
    ...todos.map((todo) => [
      `- [${todo.status}] ${todo.id}: ${todo.text}`,
      todo.acceptance ? `  acceptance: ${todo.acceptance}` : '',
      todo.nextAction ? `  next: ${todo.nextAction}` : '',
      todo.evidenceRefs.length ? `  evidence: ${todo.evidenceRefs.join(', ')}` : '',
    ].filter(Boolean).join('\n')),
    ledger.workingNotes.length ? 'Working notes:' : '',
    ...ledger.workingNotes.map((note) => `- ${note.todoId ? `${note.todoId}: ` : ''}${note.text}${note.supports.length ? ` [${note.supports.join(', ')}]` : ''}`),
  ].filter(Boolean).join('\n');
}

function recentPlainMessages(messages: ChatMessage[], limit: number): ChatMessage[] {
  return messages
    .filter((message) => {
      if (message.role !== 'assistant' && message.role !== 'user') return false;
      if (message.tool_calls?.length) return false;
      const text = chatContentToText(message.content).trim();
      // Large transcript prose is not durable evidence. Rebuilt views recover
      // meaning from TODO/workingNotes/Evidence instead of copying the blob.
      return Boolean(text)
        && text.length <= 20_000
        && !text.startsWith(CONTEXT_VIEW_PREFIX);
    })
    .slice(-Math.max(2, limit * 2))
    .map((message) => ({ role: message.role as 'assistant' | 'user', content: message.content }));
}

/**
 * Single pre-request context gate. Length only decides when to rebuild; TODO and
 * retainEvidence decide what the rebuilt view contains. Evidence bodies remain on disk.
 */
export function prepareAgentContextForRequest(
  input: AgentContextAssemblyInput,
): AgentContextAssemblyResult {
  const refreshed = refreshTodoSystemNote(input.messages, input.todoLedger);
  const budgets = resolveContextBudgets(input.modelId);
  const budgetChars = Math.max(4_096, budgets.effectiveContextLength * CHARS_PER_TOKEN_ESTIMATE);
  const usedChars = payloadChars(refreshed);
  const utilization = usedChars / budgetChars;
  const forceRebuild = input.forceRebuild === true || input.phase === 'retry' || input.phase === 'final';
  if (!forceRebuild && utilization < 0.60) {
    return {
      messages: refreshed,
      action: 'unchanged',
      usedChars,
      budgetChars,
      utilization,
      projectedEvidenceIds: [],
    };
  }

  const action: AgentContextAction = forceRebuild || utilization >= 0.75
    ? 'full_rebuild'
    : 'selective_rebuild';
  const systemMessages = refreshed.filter((message) => message.role === 'system');
  const recent = recentPlainMessages(refreshed, input.recentRoundTrips ?? 3);
  const records = input.evidenceStore.list();
  const newestRequiredIds = new Set(
    records.filter(runtimeMustRetain).slice(-12).map((record) => record.evidenceId),
  );
  const evidenceBlocks: string[] = [];
  const projectedEvidenceIds: string[] = [];
  let projectedChars = payloadChars(systemMessages) + input.userMessage.length;
  const projectionCeiling = Math.floor(budgetChars * (input.phase === 'retry' ? 0.55 : 0.70));

  for (const record of records) {
    const hint = matchingRetainHint(record, input.todoLedger);
    const requestedForm = evidenceProjectionForm(record, input.todoLedger);
    const exactRequired = !record.observedByModel
      || requestedForm === 'exact'
      || newestRequiredIds.has(record.evidenceId);
    if (exactRequired) {
      const body = selectedEvidenceBody(record, input.evidenceStore, hint);
      const exact = formatEvidenceEnvelope(record, body);
      if (projectedChars + exact.length <= projectionCeiling) {
        evidenceBlocks.push(exact);
        projectedChars += exact.length;
      } else {
        evidenceBlocks.push(evidenceReference(
          record,
          'selection_required: exact evidence exceeds this request admission budget; call evidence_read with a selector.',
        ));
      }
    } else if (requestedForm === 'digest') {
      const notes = input.todoLedger?.workingNotes
        .filter((note) => note.supports.some((support) => support.includes(record.evidenceId)))
        .map((note) => note.text) ?? [];
      evidenceBlocks.push(evidenceReference(
        record,
        notes.length ? `Model-authored digest: ${notes.join(' | ')}` : 'Digest requested; use linked working notes or evidence_read before a source-sensitive decision.',
      ));
    } else {
      evidenceBlocks.push(evidenceReference(record));
    }
    projectedEvidenceIds.push(record.evidenceId);
  }

  const contextView = [
    CONTEXT_VIEW_PREFIX,
    `phase=${input.phase} action=${action} priorUtilization=${utilization.toFixed(3)}`,
    'This view is rebuilt from durable TODO and Evidence records. References are not deletions.',
    formatTodoView(input.todoLedger, input.phase),
    evidenceBlocks.length ? 'Evidence projection:' : 'Evidence projection: none',
    ...evidenceBlocks,
  ].join('\n\n');
  const messages: ChatMessage[] = [
    ...systemMessages,
    { role: 'user', content: input.userMessage },
    ...recent.filter((message) => chatContentToText(message.content).trim() !== input.userMessage.trim()),
    { role: 'user', content: contextView },
  ];
  return {
    messages,
    action,
    usedChars: payloadChars(messages),
    budgetChars,
    utilization,
    projectedEvidenceIds,
  };
}
