import { EnvelopeSimple, X } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { fetchErrorReportStatus, sendErrorReport } from '../api/myAgentClient';

export function ErrorReportMenu({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [status, setStatus] = useState('');
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [sending, setSending] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const st = await fetchErrorReportStatus();
        if (cancelled) return;
        setConfigured(st.configured);
        setStatus(st.configured ? `로컬 기록: ${st.log_path ?? 'data/logs/error-reports.jsonl'}` : '로컬 기록 사용 불가');
      } catch (err) {
        if (cancelled) return;
        setConfigured(false);
        setStatus(err instanceof Error ? err.message : '불러오기 실패');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const send = async () => {
    if (sending || configured === false) return;
    setSending(true);
    setStatus('오류 내용을 로컬 로그에 기록하는 중…');
    try {
      const result = await sendErrorReport(note);
      setStatus(result.message ?? (result.ok ? '전송되었습니다.' : '전송 실패'));
      if (result.ok) setNote('');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : '전송에 실패했습니다.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={
          compact
            ? 'rounded-lg p-1.5 text-muted transition hover:bg-ink hover:text-text'
            : 'inline-flex items-center gap-1.5 rounded-lg border border-line bg-ink px-2.5 py-1.5 text-[11px] font-medium text-muted transition hover:border-accent/40 hover:text-text'
        }
        title="로컬 오류 기록"
        aria-label="로컬 오류 기록"
      >
        <EnvelopeSimple size={compact ? 16 : 15} weight="bold" />
        {compact ? null : '오류 기록'}
      </button>

      {open ? (
        <div
          className={`absolute z-50 w-[320px] rounded-xl border border-line bg-panel-2 p-3 shadow-xl shadow-black/40 ${
            compact ? 'bottom-[calc(100%+8px)] left-0' : 'right-0 top-[calc(100%+8px)]'
          }`}
        >
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-semibold">로컬 오류 기록</p>
            <button
              type="button"
              className="rounded-md p-1 text-muted hover:bg-ink hover:text-text"
              onClick={() => setOpen(false)}
              aria-label="닫기"
            >
              <X size={14} />
            </button>
          </div>
          <p className="mb-2 text-[11px] text-muted">외부 전송 없이 data/logs/error-reports.jsonl에 저장합니다.</p>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            disabled={configured === false || sending}
            placeholder="재현 순서 · 기대 결과 · 실제 결과"
            className="mb-2 w-full resize-none rounded-lg border border-line bg-ink px-2.5 py-2 text-xs text-text outline-none placeholder:text-muted/50 focus:border-accent disabled:opacity-50"
          />
          <button
            type="button"
            disabled={configured === false || sending}
            onClick={() => void send()}
            className="mb-2 w-full rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-ink transition enabled:hover:brightness-110 disabled:opacity-40"
          >
            {sending ? '기록 중…' : '지금 기록'}
          </button>
          {status ? <p className="text-[11px] text-muted">{status}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
