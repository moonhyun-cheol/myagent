import { CheckCircle, NotePencil, X } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { fetchAgentHealth } from '../api/myAgentClient';

const PATCH_NOTES = [
  {
    title: '문서 공동편집 UI 복원',
    detail: '단일 문서 화면에서 렌더링 편집, 우클릭 AI 작업, 선택 구간 전달과 새 창 분리를 다시 사용할 수 있습니다.',
  },
  {
    title: '멀티윈도우 메뉴 배치 안정화',
    detail: '서로 다른 배율의 모니터에서도 우클릭·추가 메뉴를 현재 창 기준으로 재측정하고 화면 안에 배치합니다.',
  },
  {
    title: '핵심 UI 회귀 배포 차단',
    detail: '사용자 여정 레지스트리와 릴리스 사전 검사를 통해 통합·리팩터링 중 빠진 상호작용을 게시 전에 차단합니다.',
  },
  {
    title: '설치 안정성 개선',
    detail: '선택 런타임 실패는 코어 설치를 중단하지 않으며 Playwright 설치가 프로젝트 manifest를 변경하지 않습니다.',
  },
] as const;

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
            {PATCH_NOTES.map((note) => (
              <article key={note.title} className="flex gap-2.5">
                <CheckCircle size={16} weight="fill" className="mt-0.5 shrink-0 text-accent" />
                <div className="min-w-0">
                  <h3 className="text-xs font-semibold text-text">{note.title}</h3>
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
