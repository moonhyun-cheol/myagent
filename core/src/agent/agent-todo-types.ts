import type { EvidenceProjectionForm, EvidenceSelector } from './agent-evidence-types.js';

export type TodoStatus = 'pending' | 'doing' | 'done' | 'blocked';

export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
  acceptance?: string;
  evidenceRefs: string[];
  nextAction?: string;
}

/** The model can only request retention; deletion/discard is intentionally not expressible. */
export interface RetainHint {
  evidenceId: string;
  todoId?: string;
  selector?: Omit<EvidenceSelector, 'evidenceId'>;
  form: EvidenceProjectionForm;
  reason?: string;
}

export interface TodoWorkingNote {
  todoId?: string;
  text: string;
  supports: string[];
}

export interface TodoLedger {
  version: 1;
  taskId?: string;
  todos: TodoItem[];
  retainEvidence: RetainHint[];
  workingNotes: TodoWorkingNote[];
  updatedAt: string;
}

export interface TodoLedgerUpdate {
  todos: TodoItem[];
  retainEvidence: RetainHint[];
  workingNotes: TodoWorkingNote[];
}
