import { CheckCircle, NotePencil, X } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { fetchAgentHealth } from '../api/myAgentClient';
import patchNotesDocument from '../data/developer-patch-notes.json';

const PATCH_NOTE_STATUS_LABEL = {
  development: '개발 중',
  released: '배포됨',
} as const;

export function DeveloperPatchNotesMenu({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || version) return;
    let cancelled = false;
    void fetchAgentHealth()
      .then((health) => {
        if (!cancelled) setVersion(health.version);
      })
      .catch(() => {
        if (!cancelled) setVersion('개발 빌드');
      });
    return () => {
      cancelled = true;
    };
  }, [open, version]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={
          compact
            ? 'rounded-lg p-1.5 text-muted transition hover:bg-ink hover:text-text'
            : 'inline-flex items-center gap-1.5 rounded-lg border border-line bg-ink px-2.5 py-1.5 text-[11px] font-medium text-muted transition hover:border-accent/40 hover:text-text'
        }
        title="개발자 패치노트"
        aria-label="개발자 패치노트"
        aria-expanded={open}
      >
        <NotePencil size={compact ? 16 : 15} weight="bold" />
        {compact ? null : '패치노트'}
      </button>

      {open ? (
        <div
          className={`absolute z-50 w-[360px] overflow-hidden rounded-xl border border-line bg-panel-2 shadow-xl shadow-black/40 ${
            compact ? 'bottom-[calc(100%+8px)] left-0' : 'right-0 top-[calc(100%+8px)]'
          }`}
        >
          <div className="flex items-start justify-between border-b border-line px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-text">개발자 패치노트</p>
              <p className="mt-0.5 text-[11px] text-muted">
                {version && version !== '개발 빌드' ? `현재 설치 v${version} 이후 개발 변경` : '현재 개발 빌드 변경'}
              </p>
            </div>
            <button
              type="button"
              className="rounded-md p-1 text-muted hover:bg-ink hover:text-text"
              onClick={() => setOpen(false)}
              aria-label="닫기"
            >
              <X size={14} />
            </button>
          </div>

          <div className="max-h-[360px] space-y-3 overflow-y-auto px-4 py-3">
            {patchNotesDocument.notes.map((note) => (
              <article key={note.id} className="flex gap-2.5">
                <CheckCircle size={16} weight="fill" className="mt-0.5 shrink-0 text-accent" />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-xs font-semibold text-text">{note.title}</h3>
                    <span className="rounded-full border border-line px-1.5 py-0.5 text-[9px] text-muted">
                      {note.status === 'released' && note.release.version
                        ? `v${note.release.version} · update ${note.release.update_sequence}`
                        : PATCH_NOTE_STATUS_LABEL.development}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] leading-5 text-muted">{note.detail}</p>
                </div>
              </article>
            ))}
          </div>

          <p className="border-t border-line px-4 py-2.5 text-[10px] leading-4 text-muted">
            개발 중인 변경을 요약한 내용이며, 실제 배포 여부는 업데이트 상태에서 확인하세요.
          </p>
        </div>
      ) : null}
    </div>
  );
}
