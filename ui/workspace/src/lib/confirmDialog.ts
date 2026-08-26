export type ConfirmDialogOptions = {
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
  resolve: (ok: boolean) => void;
};

type PendingPrompt = PromptDialogOptions & {
  kind: 'prompt';
  resolve: (value: string | null) => void;
};

type PendingChoice = ChoiceDialogOptions & {
  kind: 'choice';
  resolve: (value: string | null) => void;
};

export type ConfirmDialogPending = PendingConfirm | PendingPrompt | PendingChoice;

let pending: ConfirmDialogPending | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

function enqueue(run: () => void) {
  if (pending) {
    const prev = pending;
    pending = null;
    if (prev.kind === 'confirm') prev.resolve(false);
    else prev.resolve(null);
    queueMicrotask(run);
    return;
  }
  run();
}

/** App-themed confirm — replaces window.confirm for workspace UI. */
export function confirmDialog(input: string | ConfirmDialogOptions): Promise<boolean> {
  const opts: ConfirmDialogOptions =
    typeof input === 'string' ? { message: input, danger: true } : input;
  return new Promise((resolve) => {
    enqueue(() => {
      pending = {
        kind: 'confirm',
        title: opts.title ?? '확인',
        message: opts.message,
        danger: opts.danger ?? true,
        confirmLabel: opts.confirmLabel ?? '확인',
        cancelLabel: opts.cancelLabel ?? '취소',
        allowBackdropDismiss: opts.allowBackdropDismiss !== false,
        allowEscapeDismiss: opts.allowEscapeDismiss !== false,
        allowEnterConfirm: opts.allowEnterConfirm !== false,
        autoFocusConfirm: opts.autoFocusConfirm !== false,
        presentation: opts.presentation ?? 'default',
        resolve,
      };
      notify();
    });
  });
}

/** App-themed text prompt — replaces window.prompt for workspace UI. */
export function promptDialog(input: string | PromptDialogOptions): Promise<string | null> {
  const opts: PromptDialogOptions =
    typeof input === 'string' ? { message: input, defaultValue: '' } : input;
  return new Promise((resolve) => {
    enqueue(() => {
      pending = {
        kind: 'prompt',
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
      };
      notify();
    });
  });
}

/** App-themed action chooser for workflows with more than confirm/cancel. */
export function choiceDialog(input: ChoiceDialogOptions): Promise<string | null> {
  return new Promise((resolve) => {
    enqueue(() => {
      pending = {
        kind: 'choice',
        title: input.title ?? '확인',
        message: input.message,
        options: input.options,
        allowBackdropDismiss: input.allowBackdropDismiss !== false,
        allowEscapeDismiss: input.allowEscapeDismiss !== false,
        resolve,
      };
      notify();
    });
  });
}

export function getConfirmDialogPending(): ConfirmDialogPending | null {
  return pending;
}

export function settleConfirmDialog(result: boolean | string, inputValue?: string) {
  const cur = pending;
  pending = null;
  notify();
  if (!cur) return;
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
