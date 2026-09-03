import {
  ArrowClockwise,
  CheckCircle,
  Clock,
  DownloadSimple,
  FileText,
  Robot,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  listAutomationFeed,
  type AutomationFeedAttachment,
  type AutomationFeedItem,
} from '../api/myAgentClient';

type FeedFilter = 'all' | 'result' | 'error';

function formatFeedTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function isDownloadable(attachment: AutomationFeedAttachment): attachment is AutomationFeedAttachment & { path: string } {
  return typeof attachment.path === 'string' && attachment.path.startsWith('/outputs/automations/');
}

export function AutomationFeedModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [items, setItems] = useState<AutomationFeedItem[]>([]);
  const [filter, setFilter] = useState<FeedFilter>('all');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      setItems(await listAutomationFeed(100));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '자동화 뉴스피드를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, open, refresh]);

  const filteredItems = useMemo(
    () => filter === 'all' ? items : items.filter((item) => item.kind === filter),
    [filter, items],
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[82] flex items-center justify-center bg-slate-950/45 p-5 backdrop-blur-sm" onMouseDown={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label="자동화 작업 뉴스피드"
        className="flex h-[min(820px,90vh)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-line bg-panel text-text shadow-[0_28px_90px_rgba(0,0,0,0.28)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-start justify-between gap-5 border-b border-line bg-white/80 px-6 py-5">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent text-white shadow-sm">
              <Robot size={21} weight="duotone" />
            </span>
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-accent">Automation feed</p>
              <h2 className="mt-1 text-xl font-bold">작업 뉴스피드</h2>
              <p className="mt-1 text-sm text-muted">실행 결과와 생성 자료를 넓은 화면에서 확인합니다. 작업 개선 제안도 이곳에서 검토하게 됩니다.</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-panel px-3 py-2 text-xs font-semibold text-muted transition hover:border-accent/40 hover:text-text disabled:cursor-wait disabled:opacity-50"
            >
              <ArrowClockwise size={14} className={loading ? 'animate-spin' : ''} />
              새로고침
            </button>
            <button type="button" onClick={onClose} className="rounded-lg p-2 text-muted transition hover:bg-ink hover:text-text" aria-label="작업 뉴스피드 닫기">
              <X size={18} weight="bold" />
            </button>
          </div>
        </header>

        <div className="flex shrink-0 items-center gap-2 border-b border-line px-6 py-3">
          {([
            ['all', '전체'],
            ['result', '실행 결과'],
            ['error', '실행 오류'],
          ] as Array<[FeedFilter, string]>).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setFilter(id)}
              aria-pressed={filter === id}
              className={`rounded-full border px-3 py-1.5 text-xs font-bold transition ${
                filter === id ? 'border-accent bg-accent text-white' : 'border-line bg-white/65 text-muted hover:text-text'
              }`}
            >
              {label}
            </button>
          ))}
          <span className="ml-auto text-xs text-muted">{filteredItems.length}개 항목</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {loadError ? (
            <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{loadError}</div>
          ) : loading && items.length === 0 ? (
            <p className="py-16 text-center text-sm text-muted">자동화 뉴스피드를 불러오는 중입니다.</p>
          ) : filteredItems.length === 0 ? (
            <div className="flex min-h-72 flex-col items-center justify-center rounded-2xl border border-dashed border-line bg-white/35 text-center">
              <Robot size={28} weight="duotone" className="text-accent" />
              <p className="mt-3 text-sm font-semibold">표시할 자동화 메시지가 없습니다</p>
              <p className="mt-1 text-xs text-muted">작업 실행 결과와 개선 제안이 생성되면 이곳에 표시됩니다.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredItems.map((item) => <AutomationFeedCard key={item.id} item={item} />)}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function AutomationFeedCard({ item }: { item: AutomationFeedItem }) {
  const error = item.kind === 'error';
  const status = item.kind === 'status';
  return (
    <article className={`rounded-2xl border bg-white/80 p-5 shadow-sm ${error ? 'border-red-200' : 'border-line'}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white ${error ? 'bg-red-600' : status ? 'bg-sky-600' : 'bg-emerald-600'}`}>
            {error ? <WarningCircle size={17} weight="fill" /> : status ? <Clock size={17} weight="bold" /> : <CheckCircle size={17} weight="fill" />}
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-bold text-text">{item.title}</h3>
              <span className={`rounded-full px-2 py-1 text-[10px] font-bold ${error ? 'bg-red-100 text-red-700' : status ? 'bg-sky-100 text-sky-700' : 'bg-emerald-100 text-emerald-700'}`}>
                {error ? '실행 오류' : status ? '진행 알림' : '실행 완료'}
              </span>
            </div>
            <time className="mt-1 block text-[11px] text-muted">{formatFeedTime(item.created_at)}</time>
          </div>
        </div>
      </div>
      <p className="mt-4 whitespace-pre-wrap text-sm leading-6 text-text/90">{item.message}</p>
      {item.attachments.filter(isDownloadable).length > 0 ? (
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {item.attachments.filter(isDownloadable).map((attachment) => (
            <a
              key={`${attachment.path}:${attachment.name}`}
              href={attachment.path}
              download={attachment.name}
              className="flex items-center gap-3 rounded-xl border border-accent/30 bg-accent/5 px-3 py-2.5 transition hover:border-accent hover:bg-accent/10"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent text-white"><FileText size={17} weight="bold" /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-bold text-text">{attachment.name}</span>
                <span className="mt-0.5 block text-[10px] text-muted">{attachment.mime ?? '파일'}{attachment.size ? ` · ${Math.max(1, Math.ceil(attachment.size / 1024))} KB` : ''}</span>
              </span>
              <DownloadSimple size={16} weight="bold" className="text-accent" />
            </a>
          ))}
        </div>
      ) : null}
    </article>
  );
}
