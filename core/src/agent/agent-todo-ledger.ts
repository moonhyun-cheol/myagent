import type { EvidenceRecord } from './agent-evidence-types.js';
import type {
  RetainHint,
  TodoItem,
  TodoLedger,
  TodoLedgerUpdate,
  TodoStatus,
  TodoWorkingNote,
} from './agent-todo-types.js';

const TODO_STATUSES = new Set<TodoStatus>(['pending', 'doing', 'done', 'blocked']);

function text(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeTodo(raw: Partial<TodoItem>): TodoItem | null {
  const id = text(raw.id, 80);
  const body = text(raw.text, 500);
  if (!id || !body) return null;
  const status = TODO_STATUSES.has(raw.status as TodoStatus) ? raw.status as TodoStatus : 'pending';
  const evidenceRefs = Array.isArray(raw.evidenceRefs)
    ? [...new Set(raw.evidenceRefs.map((ref) => text(ref, 200)).filter(Boolean))].slice(0, 24)
    : [];
  const acceptance = text(raw.acceptance, 500);
  const nextAction = text(raw.nextAction, 500);
  return {
    id,
    text: body,
    status,
    evidenceRefs,
    ...(acceptance ? { acceptance } : {}),
    ...(nextAction ? { nextAction } : {}),
  };
}

function normalizeRetain(raw: Partial<RetainHint>, evidenceIds?: Set<string>): RetainHint | null {
  const evidenceId = text(raw.evidenceId, 160);
  if (!evidenceId || (evidenceIds && !evidenceIds.has(evidenceId))) return null;
  const form = raw.form === 'exact' || raw.form === 'digest' || raw.form === 'reference'
    ? raw.form
    : 'reference';
  const todoId = text(raw.todoId, 80);
  const reason = text(raw.reason, 300);
  const lines = raw.selector?.lines
    ?.map((range) => ({ start: Math.max(1, Math.trunc(range.start)), end: Math.max(1, Math.trunc(range.end)) }))
    .filter((range) => range.end >= range.start)
    .slice(0, 12);
  const keys = raw.selector?.keys?.map((key) => text(key, 120)).filter(Boolean).slice(0, 24);
  return {
    evidenceId,
    form,
    ...(todoId ? { todoId } : {}),
    ...(lines?.length || keys?.length ? { selector: { ...(lines?.length ? { lines } : {}), ...(keys?.length ? { keys } : {}) } } : {}),
    ...(reason ? { reason } : {}),
  };
}

function normalizeNote(raw: Partial<TodoWorkingNote>): TodoWorkingNote | null {
  const body = text(raw.text, 1_000);
  if (!body) return null;
  const todoId = text(raw.todoId, 80);
  const supports = Array.isArray(raw.supports)
    ? [...new Set(raw.supports.map((ref) => text(ref, 200)).filter(Boolean))].slice(0, 24)
    : [];
  return { text: body, supports, ...(todoId ? { todoId } : {}) };
}

export function normalizeTodoLedger(raw: Partial<TodoLedger> | null | undefined): TodoLedger | null {
  if (!raw || typeof raw !== 'object') return null;
  const todos = Array.isArray(raw.todos) ? raw.todos.map(normalizeTodo).filter((item): item is TodoItem => Boolean(item)) : [];
  if (!todos.length) return null;
  const retainEvidence = Array.isArray(raw.retainEvidence)
    ? raw.retainEvidence.map((hint) => normalizeRetain(hint)).filter((hint): hint is RetainHint => Boolean(hint))
    : [];
  const workingNotes = Array.isArray(raw.workingNotes)
    ? raw.workingNotes.map(normalizeNote).filter((note): note is TodoWorkingNote => Boolean(note))
    : [];
  const taskId = text(raw.taskId, 120);
  return {
    version: 1,
    todos: todos.slice(0, 80),
    retainEvidence: retainEvidence.slice(0, 120),
    workingNotes: workingNotes.slice(0, 120),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
    ...(taskId ? { taskId } : {}),
  };
}

/** Omitted TODOs survive updates; omitted evidence is only demoted to reference, never deleted. */
export function mergeTodoLedgerUpdate(
  current: TodoLedger | null | undefined,
  update: TodoLedgerUpdate,
  evidenceRecords: EvidenceRecord[],
): TodoLedger {
  const byId = new Map((current?.todos ?? []).map((todo) => [todo.id, todo]));
  for (const candidate of update.todos ?? []) {
    const todo = normalizeTodo(candidate);
    if (todo) byId.set(todo.id, todo);
  }
  const evidenceIds = new Set(evidenceRecords.map((record) => record.evidenceId));
  const retainEvidence = (update.retainEvidence ?? [])
    .map((hint) => normalizeRetain(hint, evidenceIds))
    .filter((hint): hint is RetainHint => Boolean(hint));
  const workingNotes = (update.workingNotes ?? [])
    .map(normalizeNote)
    .filter((note): note is TodoWorkingNote => Boolean(note));
  return {
    version: 1,
    ...(current?.taskId ? { taskId: current.taskId } : {}),
    todos: [...byId.values()].slice(0, 80),
    retainEvidence: retainEvidence.slice(0, 120),
    workingNotes: workingNotes.slice(0, 120),
    updatedAt: new Date().toISOString(),
  };
}

export function evidenceProjectionForm(
  record: EvidenceRecord,
  ledger: TodoLedger | null | undefined,
): 'exact' | 'digest' | 'reference' {
  if (!record.observedByModel) return 'exact';
  return ledger?.retainEvidence.find((hint) => hint.evidenceId === record.evidenceId)?.form ?? 'reference';
}

export function formatTodoLifecycleSystemNote(ledger?: TodoLedger | null): string {
  const guidance = [
    '## TODO · Evidence lifecycle',
    'For multi-step work, update todo_update after first large evidence, before changing exploration to mutation, on TODO/conflict changes, and before interruption/resume.',
    'Declare only retainEvidence (exact/digest/reference). You cannot delete evidence; unspecified observed evidence remains retrievable by evidence_read reference.',
  ];
  if (!ledger) return guidance.join('\n');
  return [...guidance, JSON.stringify(ledger)].join('\n');
}
