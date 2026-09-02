export type ConfirmDialogOptions = {
  title?: string;
  message: string;
  danger?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
};

type PendingConfirm = ConfirmDialogOptions & {
  kind: 'confirm';
  resolve: (ok: boolean) => void;
};

export type ConfirmDialogPending = PendingConfirm;

let pending: ConfirmDialogPending | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

export function confirmDialog(input: string | ConfirmDialogOptions): Promise<boolean> {
  const opts: ConfirmDialogOptions =
    typeof input === 'string' ? { message: input, danger: true } : input;
  return new Promise((resolve) => {
    if (pending) {
      pending.resolve(false);
    }
    pending = {
      kind: 'confirm',
      title: opts.title ?? '확인',
      message: opts.message,
      danger: opts.danger ?? false,
      confirmLabel: opts.confirmLabel ?? '확인',
      cancelLabel: opts.cancelLabel ?? '취소',
      resolve,
    };
    notify();
  });
}

export function getConfirmDialogPending(): ConfirmDialogPending | null {
  return pending;
}

export function settleConfirmDialog(result: boolean) {
  const cur = pending;
  pending = null;
  notify();
  cur?.resolve(result === true);
}

export function subscribeConfirmDialog(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
