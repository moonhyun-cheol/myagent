import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  getConfirmDialogPending,
  settleConfirmDialog,
  subscribeConfirmDialog,
} from '../lib/confirmDialog';

export function ConfirmModal() {
  const [pending, setPending] = useState(getConfirmDialogPending());

  useEffect(() => subscribeConfirmDialog(() => setPending(getConfirmDialogPending())), []);

  if (!pending) return null;

  const isDanger = Boolean(pending.danger);

  return createPortal(
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center bg-slate-950/45 p-5 backdrop-blur-sm"
      role="alertdialog"
      aria-modal="true"
      onClick={() => settleConfirmDialog(false)}
    >
      <div
        className="w-full max-w-[480px] overflow-hidden rounded-2xl border border-line/90 bg-panel shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`h-1 w-full ${isDanger ? 'bg-red-600' : 'bg-accent'}`} />
        <div className="p-6">
          <h2 className="m-0 text-[15px] font-semibold text-text">{pending.title ?? '확인'}</h2>
          <p className="mt-2.5 whitespace-pre-wrap text-sm leading-6 text-text">{pending.message}</p>
          <div className="mt-7 flex justify-end gap-3">
            <button
              type="button"
              className="rounded-xl border border-line bg-white px-5 py-2.5 text-sm font-semibold text-text"
              onClick={() => settleConfirmDialog(false)}
            >
              {pending.cancelLabel ?? '취소'}
            </button>
            <button
              type="button"
              className={
                isDanger
                  ? 'rounded-xl bg-red-600 px-5 py-2.5 text-sm font-bold text-white'
                  : 'rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-white'
              }
              onClick={() => settleConfirmDialog(true)}
            >
              {pending.confirmLabel ?? '확인'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
