export type ConfirmDialogOptions = {
  signal?: AbortSignal;
  title?: string;
  message: string;
  /** Red-styled confirm (deletes) */
  danger?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Click outside overlay dismisses as cancel. Default true. */
  allowBackdropDismiss?: boolean;
  /** Escape dismisses as cancel. Default true. */
  allowEscapeDismiss?: boolean;
  /** Enter key confirms. Default true. Set false for irreversible tool approvals. */
  allowEnterConfirm?: boolean;
  /** Autofocus primary confirm button. Default true. */
  autoFocusConfirm?: boolean;
  /** Dense tool/command details rendered in a high-contrast scrollable panel. */
  presentation?: 'default' | 'approval';
  /** Short origin line shown above the message (e.g. which conversation asked). */
  context?: string;
};

export type PromptDialogOptions = {
  title?: string;
  message: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  allowBackdropDismiss?: boolean;
  allowEscapeDismiss?: boolean;
  allowEnterConfirm?: boolean;
};

export type ChoiceDialogOption = {
  id: string;
  label: string;
  danger?: boolean;
};

export type ChoiceDialogOptions = {
  title?: string;
  message: string;
  options: ChoiceDialogOption[];
  allowBackdropDismiss?: boolean;
  allowEscapeDismiss?: boolean;
};

type PendingConfirm = ConfirmDialogOptions & {
  kind: 'confirm';
  rowId: number;
  resolve: (ok: boolean) => void;
};

type PendingPrompt = PromptDialogOptions & {
  kind: 'prompt';
  rowId: number;
  resolve: (value: string | null) => void;
};

type PendingChoice = ChoiceDialogOptions & {
  kind: 'choice';
  rowId: number;
  resolve: (value: string | null) => void;
};

export type ConfirmDialogPending = PendingConfirm | PendingPrompt | PendingChoice;

/** Dialog currently on screen. */
let pending: ConfirmDialogPending | null = null;
/**
 * Dialogs waiting their turn. A new dialog never settles an older one:
 * tool approvals line up FIFO; user-initiated dialogs (delete confirm, prompts…)
 * are shown immediately and the displaced dialog resumes afterwards, unanswered.
 */
const waiting: ConfirmDialogPending[] = [];
let nextRowId = 1;
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

function isApprovalRow(row: ConfirmDialogPending): boolean {
  return row.kind === 'confirm' && row.presentation === 'approval';
}

function enqueue(row: ConfirmDialogPending) {
  if (!pending) {
    pending = row;
  } else if (isApprovalRow(row)) {
    waiting.push(row);
  } else {
    // User-initiated dialog: show now, put the current one back at the front.
    waiting.unshift(pending);
    pending = row;
  }
  notify();
}

function showNext() {
  pending = waiting.shift() ?? null;
  notify();
}

/** Remove a dialog without answering it on the user's behalf (abort / timeout). */
function withdraw(row: ConfirmDialogPending) {
  if (pending === row) {
    showNext();
    return;
  }
  const idx = waiting.indexOf(row);
  if (idx >= 0) {
    waiting.splice(idx, 1);
    notify();
  }
}

/** App-themed confirm — replaces window.confirm for workspace UI. */
export function confirmDialog(input: string | ConfirmDialogOptions): Promise<boolean> {
  const opts: ConfirmDialogOptions =
    typeof input === 'string' ? { message: input, danger: true } : input;
  return new Promise((resolve) => {
    if (opts.signal?.aborted) { resolve(false); return; }
    const finish = (ok: boolean) => {
      opts.signal?.removeEventListener('abort', abort);
      resolve(ok && !opts.signal?.aborted);
    };
    const row: PendingConfirm = {
      kind: 'confirm',
      rowId: nextRowId++,
      title: opts.title ?? '확인',
      message: opts.message,
      context: opts.context,
      danger: opts.danger ?? true,
      confirmLabel: opts.confirmLabel ?? '확인',
      cancelLabel: opts.cancelLabel ?? '취소',
      allowBackdropDismiss: opts.allowBackdropDismiss !== false,
      allowEscapeDismiss: opts.allowEscapeDismiss !== false,
      allowEnterConfirm: opts.allowEnterConfirm !== false,
      autoFocusConfirm: opts.autoFocusConfirm !== false,
      presentation: opts.presentation ?? 'default',
      resolve: finish,
    };
    const abort = () => {
      withdraw(row);
      finish(false);
    };
    opts.signal?.addEventListener('abort', abort, { once: true });
    enqueue(row);
  });
}

/** App-themed text prompt — replaces window.prompt for workspace UI. */
export function promptDialog(input: string | PromptDialogOptions): Promise<string | null> {
  const opts: PromptDialogOptions =
    typeof input === 'string' ? { message: input, defaultValue: '' } : input;
  return new Promise((resolve) => {
    enqueue({
      kind: 'prompt',
      rowId: nextRowId++,
      title: opts.title ?? '입력',
      message: opts.message,
      defaultValue: opts.defaultValue ?? '',
      placeholder: opts.placeholder,
      confirmLabel: opts.confirmLabel ?? '확인',
      cancelLabel: opts.cancelLabel ?? '취소',
      allowBackdropDismiss: opts.allowBackdropDismiss !== false,
      allowEscapeDismiss: opts.allowEscapeDismiss !== false,
      allowEnterConfirm: opts.allowEnterConfirm !== false,
      resolve,
    });
  });
}

/** App-themed action chooser for workflows with more than confirm/cancel. */
export function choiceDialog(input: ChoiceDialogOptions): Promise<string | null> {
  return new Promise((resolve) => {
    enqueue({
      kind: 'choice',
      rowId: nextRowId++,
      title: input.title ?? '확인',
      message: input.message,
      options: input.options,
      allowBackdropDismiss: input.allowBackdropDismiss !== false,
      allowEscapeDismiss: input.allowEscapeDismiss !== false,
      resolve,
    });
  });
}

export function getConfirmDialogPending(): ConfirmDialogPending | null {
  return pending;
}

/** Number of dialogs waiting behind the one on screen. */
export function getConfirmDialogWaitingCount(): number {
  return waiting.length;
}

/**
 * Answer the dialog on screen. Pass rowId from the rendered view so a click on a
 * dialog that was just replaced cannot answer the new one.
 */
export function settleConfirmDialog(result: boolean | string, inputValue?: string, rowId?: number) {
  const cur = pending;
  if (!cur) return;
  if (rowId !== undefined && cur.rowId !== rowId) return;
  showNext();
  if (cur.kind === 'prompt') {
    cur.resolve(result === true ? String(inputValue ?? '') : null);
    return;
  }
  if (cur.kind === 'choice') {
    cur.resolve(typeof result === 'string' ? result : null);
    return;
  }
  cur.resolve(result === true);
}

export function subscribeConfirmDialog(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
