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
/**
 * Per-turn dynamic context (query-dependent workspace snapshot, active task, TODO
 * ledger, topic manifest, continuity). Lives as one user-role message right before
 * the current request so the system prefix stays byte-identical across turns/steps
 * and provider prompt caches keep hitting.
 */
export const TURN_CONTEXT_PREFIX = '## Turn context';
/** Question-independent workspace overview, sent once before history (cache-stable). */
export const WORKSPACE_CONTEXT_PREFIX = '## Workspace context';

export function formatWorkspaceContextMessage(body: string): string {
  return [
    `${WORKSPACE_CONTEXT_PREFIX} (runtime-provided, stable across this conversation; discovery only — read concrete files before file-content claims)`,
    body.trim(),
  ].join('\n\n');
}

export function isWorkspaceContextMessage(message: ChatMessage): boolean {
  return message.role === 'user'
    && typeof message.content === 'string'
    && message.content.startsWith(WORKSPACE_CONTEXT_PREFIX);
}

export function isTurnContextMessage(message: ChatMessage): boolean {
  return message.role === 'user'
    && typeof message.content === 'string'
    && message.content.startsWith(TURN_CONTEXT_PREFIX);
}

/** The current request's turn context is the last one; earlier ones are replayed history. */
export function lastTurnContextIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (isTurnContextMessage(messages[i])) return i;
  }
  return -1;
}

export function formatTurnContextMessage(sections: string[]): ChatMessage | null {
  const body = sections.map((section) => section.trim()).filter(Boolean);
  if (!body.length) return null;
  return {
    role: 'user',
    content: [
      `${TURN_CONTEXT_PREFIX} (runtime-provided for this request; not written by the user)`,
      ...body,
    ].join('\n\n'),
  };
}

/** Append a section to the turn context message; create it before the last user message if absent. */
export function appendTurnContext(messages: ChatMessage[], section: string): void {
  const text = section.trim();
  if (!text) return;
  // Last one: earlier turns' contexts are replayed verbatim in history for prompt caching.
  const existing = lastTurnContextIndex(messages);
  if (existing >= 0) {
    const current = messages[existing];
    messages[existing] = { ...current, content: `${String(current.content)}\n\n${text}` };
    return;
  }
  const created = formatTurnContextMessage([text]);
  if (!created) return;
  let at = messages.length;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') {
      at = i;
      break;
    }
  }
  messages.splice(at, 0, created);
}
const CHARS_PER_TOKEN_ESTIMATE = 4;
/** Raw payload share that triggers a rebuild. */
const REBUILD_TRIGGER = 0.60;
const FULL_REBUILD_AT = 0.75;
/**
 * Share the whole rebuilt request may occupy. It must stay well below REBUILD_TRIGGER:
 * a view that lands above the trigger is rebuilt again on the very next step, which
 * rewrites the request tail every step and voids the provider prompt cache.
 */
const REBUILD_TARGET = 0.45;
const RETRY_REBUILD_TARGET = 0.40;
/** Evidence references are bounded too: long runs accumulate hundreds of records. */
const REFERENCE_SHARE = 0.08;
const COMPACT_REFERENCE_SHARE = 0.04;

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

/** Ensure the static TODO guidance exists. Idempotent so the system prefix never moves. */
function refreshTodoSystemNote(messages: ChatMessage[]): ChatMessage[] {
  const isTodoNote = (message: ChatMessage) => message.role === 'system'
    && chatContentToText(message.content).startsWith(TODO_NOTE_PREFIX);
  if (messages.some(isTodoNote)) return messages;
  const next = [...messages];
  next.splice(Math.min(1, next.length), 0, { role: 'system', content: formatTodoLifecycleSystemNote() });
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

function compactEvidenceReference(record: EvidenceRecord): string {
  return `[evidence reference id=${record.evidenceId} tool=${record.tool} ok=${record.ok}${record.source?.path ? ` source=${record.source.path}` : ''}]`;
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
        && !text.startsWith(CONTEXT_VIEW_PREFIX)
        && !text.startsWith(TURN_CONTEXT_PREFIX)
        && !text.startsWith(WORKSPACE_CONTEXT_PREFIX);
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
  const refreshed = refreshTodoSystemNote(input.messages);
  const budgets = resolveContextBudgets(input.modelId);
  const budgetChars = Math.max(4_096, budgets.effectiveContextLength * CHARS_PER_TOKEN_ESTIMATE);
  const usedChars = payloadChars(refreshed);
  const utilization = usedChars / budgetChars;
  const forceRebuild = input.forceRebuild === true || input.phase === 'retry' || input.phase === 'final';
  if (!forceRebuild && utilization < REBUILD_TRIGGER) {
    return {
      messages: refreshed,
      action: 'unchanged',
      usedChars,
      budgetChars,
      utilization,
      projectedEvidenceIds: [],
    };
  }

  const action: AgentContextAction = forceRebuild || utilization >= FULL_REBUILD_AT
    ? 'full_rebuild'
    : 'selective_rebuild';
  const systemMessages = refreshed.filter((message) => message.role === 'system');
  const turnContextAt = lastTurnContextIndex(refreshed);
  const turnContext = turnContextAt >= 0 ? refreshed[turnContextAt] : undefined;
  const workspaceContext = refreshed.find(isWorkspaceContextMessage);
  const recent = recentPlainMessages(refreshed, input.recentRoundTrips ?? 3)
    .filter((message) => chatContentToText(message.content).trim() !== input.userMessage.trim());
  const records = input.evidenceStore.list();
  const newestRequiredIds = new Set(
    records.filter(runtimeMustRetain).slice(-12).map((record) => record.evidenceId),
  );
  const todoView = formatTodoView(input.todoLedger, input.phase);
  const targetChars = Math.floor(
    budgetChars * (input.phase === 'retry' ? RETRY_REBUILD_TARGET : REBUILD_TARGET),
  );
  // Everything the rebuilt request carries counts, not only the evidence bodies.
  let projectedChars = payloadChars(systemMessages)
    + (workspaceContext ? payloadChars([workspaceContext]) : 0)
    + (turnContext ? payloadChars([turnContext]) : 0)
    + input.userMessage.length
    + payloadChars(recent)
    + todoView.length;

  const blockById = new Map<string, string>();
  const exactCandidates: EvidenceRecord[] = [];
  const referenceCandidates: Array<{ record: EvidenceRecord; text: string }> = [];
  for (const record of records) {
    const requestedForm = evidenceProjectionForm(record, input.todoLedger);
    const exactRequired = !record.observedByModel
      || requestedForm === 'exact'
      || newestRequiredIds.has(record.evidenceId);
    if (exactRequired) {
      exactCandidates.push(record);
    } else if (requestedForm === 'digest') {
      const notes = input.todoLedger?.workingNotes
        .filter((note) => note.supports.some((support) => support.includes(record.evidenceId)))
        .map((note) => note.text) ?? [];
      referenceCandidates.push({
        record,
        text: evidenceReference(
          record,
          notes.length ? `Model-authored digest: ${notes.join(' | ')}` : 'Digest requested; use linked working notes or evidence_read before a source-sensitive decision.',
        ),
      });
    } else {
      referenceCandidates.push({ record, text: evidenceReference(record) });
    }
  }

  // References: newest keep the full form, older ones degrade to one line, the
  // oldest are only counted. Ids stay valid for evidence_read either way.
  const referenceBudget = Math.floor(budgetChars * REFERENCE_SHARE);
  const compactBudget = Math.floor(budgetChars * COMPACT_REFERENCE_SHARE);
  let referenceChars = 0;
  let compactChars = 0;
  let referenceTier: 'full' | 'compact' | 'omitted' = 'full';
  let omittedReferences = 0;
  for (let i = referenceCandidates.length - 1; i >= 0; i -= 1) {
    const { record, text } = referenceCandidates[i];
    if (referenceTier === 'full') {
      if (referenceChars + text.length <= referenceBudget) {
        blockById.set(record.evidenceId, text);
        referenceChars += text.length;
        continue;
      }
      referenceTier = 'compact';
    }
    if (referenceTier === 'compact') {
      const compact = compactEvidenceReference(record);
      if (compactChars + compact.length <= compactBudget) {
        blockById.set(record.evidenceId, compact);
        compactChars += compact.length;
        continue;
      }
      referenceTier = 'omitted';
    }
    omittedReferences += 1;
  }
  projectedChars += referenceChars + compactChars;

  // Exact bodies: results the model has not seen yet come first, then newest first,
  // so a long run keeps its latest failures/mutations instead of its oldest ones.
  const unseen = exactCandidates.filter((record) => !record.observedByModel);
  const seenNewestFirst = exactCandidates.filter((record) => record.observedByModel).reverse();
  for (const record of [...unseen, ...seenNewestFirst]) {
    const hint = matchingRetainHint(record, input.todoLedger);
    const exact = formatEvidenceEnvelope(record, selectedEvidenceBody(record, input.evidenceStore, hint));
    if (projectedChars + exact.length <= targetChars) {
      blockById.set(record.evidenceId, exact);
      projectedChars += exact.length;
    } else {
      blockById.set(record.evidenceId, evidenceReference(
        record,
        'selection_required: exact evidence exceeds this request admission budget; call evidence_read with a selector.',
      ));
    }
  }

  // Emit in record order so consecutive views share as long a prefix as possible.
  const evidenceBlocks: string[] = [];
  const projectedEvidenceIds: string[] = [];
  for (const record of records) {
    const block = blockById.get(record.evidenceId);
    if (!block) continue;
    evidenceBlocks.push(block);
    projectedEvidenceIds.push(record.evidenceId);
  }

  // No utilization figure here: it changed on every rebuild (cache break) and read
  // like a spending budget to the model. The UI status line reports it instead.
  const contextView = [
    CONTEXT_VIEW_PREFIX,
    `phase=${input.phase} action=${action}`,
    'This view is rebuilt from durable TODO and Evidence records. References are not deletions.',
    todoView,
    evidenceBlocks.length ? 'Evidence projection:' : 'Evidence projection: none',
    ...(omittedReferences
      ? [`${omittedReferences} older evidence record(s) are not listed in this view; their ids remain valid for evidence_read.`]
      : []),
    ...evidenceBlocks,
  ].join('\n\n');
  const messages: ChatMessage[] = [
    ...systemMessages,
    ...(workspaceContext ? [workspaceContext] : []),
    ...(turnContext ? [turnContext] : []),
    { role: 'user', content: input.userMessage },
    ...recent,
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
