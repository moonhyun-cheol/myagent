import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  getConfirmDialogPending,
  settleConfirmDialog,
  subscribeConfirmDialog,
  type ConfirmDialogPending,
} from '../lib/confirmDialog';

type View = ConfirmDialogPending & { open: boolean };

function allowsBackdropDismiss(view: View): boolean {
  return view.allowBackdropDismiss !== false;
}

function allowsEscapeDismiss(view: View): boolean {
  return view.allowEscapeDismiss !== false;
}

function allowsEnterConfirm(view: View): boolean {
  // choice dialogs have no primary Enter confirm; only confirm/prompt expose the flag
  if (view.kind === 'choice') return false;
  return view.allowEnterConfirm !== false;
}

function shouldAutoFocusConfirm(view: View): boolean {
  if (view.kind !== 'confirm') return false;
  return view.autoFocusConfirm !== false;
}

export function ConfirmModal() {
  const [view, setView] = useState<View | null>(null);
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const inputValueRef = useRef('');
  const inputId = useId();

  useEffect(() => {
    inputValueRef.current = inputValue;
  }, [inputValue]);

  useEffect(() => {
    const sync = () => {
      const p = getConfirmDialogPending();
      if (p) {
        setView({ ...p, open: true });
        const initial = p.kind === 'prompt' ? (p.defaultValue ?? '') : '';
        setInputValue(initial);
        inputValueRef.current = initial;
      } else {
        setView(null);
      }
    };
    sync();
    return subscribeConfirmDialog(sync);
  }, []);

  useEffect(() => {
    if (!view?.open) return;
    if (view.kind === 'prompt') {
      const t = window.setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
      return () => window.clearTimeout(t);
    }
  }, [view?.open, view?.kind]);

  useEffect(() => {
    if (!view?.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!allowsEscapeDismiss(view)) {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        settleConfirmDialog(false);
        return;
      }
      if (e.key === 'Enter') {
        if (view.kind === 'choice' || e.target instanceof HTMLTextAreaElement) return;
        if (!allowsEnterConfirm(view)) return;
        e.preventDefault();
        settleConfirmDialog(true, inputValueRef.current);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view]);

  if (!view?.open) return null;

  const isPrompt = view.kind === 'prompt';
  const isChoice = view.kind === 'choice';
  const isDanger = view.kind === 'confirm' && Boolean(view.danger);
  const isApproval = view.kind === 'confirm' && view.presentation === 'approval';
  const backdropDismiss = allowsBackdropDismiss(view);

  return createPortal(
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center bg-slate-950/45 p-5 backdrop-blur-sm"
      role={isPrompt ? 'dialog' : 'alertdialog'}
      aria-modal="true"
      aria-labelledby="my-agent-confirm-title"
      aria-describedby="my-agent-confirm-message"
      onClick={() => {
        if (backdropDismiss) settleConfirmDialog(false);
      }}
    >
      <div
        className={`w-full overflow-hidden rounded-2xl border bg-panel shadow-[0_20px_60px_rgba(0,0,0,0.55)] ${
          isPrompt
            ? 'max-w-[448px] border-accent/25'
            : isApproval
              ? 'max-w-[680px] border-red-700/25'
              : 'max-w-[480px] border-line/90'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`h-1 w-full ${isDanger ? 'bg-red-600' : 'bg-accent'}`} aria-hidden />
        <div className={isApproval ? 'p-7' : 'p-6'}>
          {isPrompt ? (
            <div className="mb-5 flex items-start gap-3">
              <div
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-accent/25 bg-accent/10 text-accent"
                aria-hidden="true"
              >
                <span className="text-lg leading-none">＋</span>
              </div>
              <div className="min-w-0">
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-accent/80">
                  새 항목 만들기
                </p>
                <h2 id="my-agent-confirm-title" className="m-0 text-[17px] font-semibold tracking-tight text-text">
                  {view.title ?? '이름 입력'}
                </h2>
              </div>
            </div>
          ) : (
            <h2
              id="my-agent-confirm-title"
              className={`m-0 font-semibold tracking-tight text-text ${isApproval ? 'text-[19px]' : 'text-[15px]'}`}
            >
              {view.title ?? '확인'}
            </h2>
          )}
          {isApproval ? (
            <div className="mt-5">
              <p className="mb-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-red-700">
                실행 요청 내용
              </p>
              <pre
                id="my-agent-confirm-message"
                className="m-0 max-h-[55vh] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-slate-300 bg-white px-5 py-4 font-mono text-[14px] font-medium leading-6 text-slate-900 shadow-inner"
              >
                {view.message}
              </pre>
            </div>
          ) : (
            <p
              id="my-agent-confirm-message"
              className={`${isPrompt ? 'mt-0' : 'mt-2.5'} whitespace-pre-wrap text-[14px] leading-6 text-text`}
            >
              {view.message}
            </p>
          )}
          {!backdropDismiss && !isPrompt ? (
            <p className="mt-3 text-[12px] font-semibold leading-snug text-amber-700">
              안전을 위해 아래 버튼으로만 선택할 수 있습니다.
            </p>
          ) : null}

          {isPrompt ? (
            <div className="mt-5 rounded-xl border border-line/90 bg-ink/45 p-1.5 transition-colors focus-within:border-accent/50 focus-within:bg-ink/70">
              <label htmlFor={inputId} className="sr-only">
                {view.message}
              </label>
              <input
                ref={inputRef}
                id={inputId}
                type="text"
                value={inputValue}
                placeholder={view.placeholder}
                onChange={(e) => setInputValue(e.target.value)}
                className="w-full rounded-lg border-0 bg-transparent px-3 py-2.5 text-sm text-text outline-none placeholder:text-muted/50"
              />
            </div>
          ) : null}

          <div className="mt-7 flex flex-wrap justify-end gap-3">
            {isChoice ? (
              view.options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={
                    option.danger
                      ? 'min-w-[80px] rounded-xl border border-red-400/35 bg-red-950/40 px-3.5 py-2.5 text-xs font-semibold text-red-100 transition-colors hover:bg-red-950/65'
                      : option.id === 'save'
                        ? 'min-w-[80px] rounded-xl bg-accent px-3.5 py-2.5 text-xs font-semibold text-ink shadow-[0_0_0_1px_rgba(45,212,191,0.2)] transition-colors hover:bg-accent/90'
                        : 'min-w-[80px] rounded-xl border border-line bg-panel-2/80 px-3.5 py-2.5 text-xs font-medium text-muted transition-colors hover:border-accent/50 hover:bg-panel-2 hover:text-text'
                  }
                  onClick={() => settleConfirmDialog(option.id)}
                >
                  {option.label}
                </button>
              ))
            ) : (
              <>
                <button
                  type="button"
                  className="min-w-[96px] rounded-xl border border-slate-400 bg-white px-5 py-3 text-sm font-semibold text-slate-800 transition-colors hover:border-slate-600 hover:bg-slate-100"
                  onClick={() => settleConfirmDialog(false)}
                >
                  {view.cancelLabel ?? '취소'}
                </button>
                <button
                  type="button"
                  autoFocus={shouldAutoFocusConfirm(view)}
                  className={
                    isDanger
                      ? 'min-w-[96px] rounded-xl border border-red-700 bg-red-600 px-5 py-3 text-sm font-bold text-white shadow-sm transition-colors hover:bg-red-700'
                      : 'min-w-[80px] rounded-xl bg-accent px-3.5 py-2.5 text-xs font-semibold text-ink shadow-[0_0_0_1px_rgba(45,212,191,0.2)] transition-colors hover:bg-accent/90'
                  }
                  onClick={() => settleConfirmDialog(true, inputValue)}
                >
                  {view.confirmLabel ?? '확인'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
