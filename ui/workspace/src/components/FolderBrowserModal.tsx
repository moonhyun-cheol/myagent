import { CaretLeft, FolderOpen, X } from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { browseFs, type FsBrowseResult } from '../api/myAgentClient';

interface FolderBrowserModalProps {
  open: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
}

/** Normalize Explorer / PowerShell pasted paths: quotes, file://, trailing slashes. */
function normalizePastedPath(raw: string): string {
  let s = raw.trim();
  if (!s) return '';
  // file:///C:/foo or file://C:/foo
  if (/^file:\/\//i.test(s)) {
    try {
      s = decodeURIComponent(s.replace(/^file:\/\//i, ''));
      if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1);
    } catch {
      s = s.replace(/^file:\/\//i, '');
    }
  }
  // "C:\foo" or 'C:\foo'
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  // Collapse accidental wrapping newlines from multi-line paste
  s = s.replace(/[\r\n]+/g, '').trim();
  return s;
}

export function FolderBrowserModal({ open, onClose, onSelect }: FolderBrowserModalProps) {
  const [data, setData] = useState<FsBrowseResult | null>(null);
  const [pathDraft, setPathDraft] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const pathInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (path?: string) => {
    setLoading(true);
    setError('');
    try {
      const result = await browseFs(path);
      setData(result);
      if (result.path) setPathDraft(result.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : '폴더 열기 실패');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setPathDraft('');
    setData(null);
    setError('');
    void load();
    const t = window.setTimeout(() => pathInputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open, load]);

  if (!open) return null;

  const goToDraft = () => {
    const next = normalizePastedPath(pathDraft);
    if (!next) {
      setError('경로를 입력하세요');
      return;
    }
    setPathDraft(next);
    void load(next);
  };

  const useDraftOrCurrent = () => {
    const next = normalizePastedPath(pathDraft) || data?.path?.trim() || '';
    if (!next) {
      setError('폴더를 선택하세요');
      return;
    }
    onSelect(next);
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 p-4">
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-2xl border border-line bg-panel shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold">폴더 추가</p>
            <p className="mt-0.5 text-[11px] text-muted">경로 붙여넣기 또는 선택</p>
          </div>
          <button
            type="button"
            className="rounded-md p-1.5 text-muted hover:bg-ink hover:text-text"
            onClick={onClose}
            aria-label="닫기"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-2 border-b border-line px-3 py-2.5">
          <label className="block text-[10px] font-medium uppercase tracking-[0.12em] text-muted">
            폴더 경로
          </label>
          <div className="flex gap-2">
            <input
              ref={pathInputRef}
              type="text"
              value={pathDraft}
              spellCheck={false}
              autoComplete="off"
              placeholder="C:\경로"
              onChange={(e) => setPathDraft(e.target.value)}
              onPaste={(e) => {
                const text = e.clipboardData.getData('text');
                if (!text) return;
                e.preventDefault();
                const next = normalizePastedPath(text);
                setPathDraft(next);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  goToDraft();
                }
              }}
              className="min-w-0 flex-1 rounded-lg border border-line bg-ink/80 px-3 py-2 font-mono text-[12px] text-text outline-none placeholder:text-muted/45 focus:border-accent/60"
            />
            <button
              type="button"
              disabled={loading || !pathDraft.trim()}
              onClick={goToDraft}
              className="shrink-0 rounded-lg border border-line px-2.5 py-2 text-[11px] text-muted enabled:hover:border-accent/50 enabled:hover:text-text disabled:opacity-40"
            >
              이동
            </button>
          </div>
        </div>

        <div className="flex gap-2 border-b border-line px-3 py-2">
          <button
            type="button"
            disabled={!data?.parent || loading}
            onClick={() => void load(data?.parent ?? undefined)}
            className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-[11px] text-muted enabled:hover:text-text disabled:opacity-40"
          >
            <CaretLeft size={12} />
            위로
          </button>
          <button
            type="button"
            disabled={loading || (!normalizePastedPath(pathDraft) && !data?.path)}
            onClick={useDraftOrCurrent}
            className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-accent px-2.5 py-1.5 text-[11px] font-semibold text-ink disabled:opacity-40"
          >
            <FolderOpen size={13} weight="bold" />
            이 폴더 사용
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {error ? <p className="px-2 py-3 text-xs text-red-400">{error}</p> : null}
          {loading && !data ? <p className="px-2 py-3 text-xs text-muted">불러오는 중…</p> : null}
          {data?.entries?.map((e) => (
            <button
              key={e.path}
              type="button"
              onClick={() => void load(e.path)}
              className="mb-0.5 flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-[13px] text-muted hover:bg-ink hover:text-text"
            >
              <FolderOpen size={16} className="shrink-0 text-accent" />
              <span className="truncate">{e.name}</span>
            </button>
          ))}
          {data && !loading && (data.entries?.length ?? 0) === 0 ? (
            <p className="px-2 py-3 text-xs text-muted">빈 폴더 · 「이 폴더 사용」</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
