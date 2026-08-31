import { useCallback, useEffect, useState } from 'react';
import { fetchCheckpointPreview } from '../api/myAgentClient';
import { useWorkspaceStore } from '../store/workspaceStore';
import { ResizableSplit } from './ResizableSplit';

type DiffPreview = {
  before: string | null;
  after: string | null;
  before_bytes?: number;
  after_bytes?: number;
  is_new?: boolean;
  diff_lines?: string[];
  diff_added?: number;
  diff_removed?: number;
};

type DiffMode = 'unified' | 'split';

function fileLabel(path: string): string {
  return path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
}

function DiffLine({ line }: { line: string }) {
  const cls = line.startsWith('+')
    ? 'bg-emerald-500/10 text-emerald-200/90'
    : line.startsWith('-')
      ? 'bg-red-500/10 text-red-200/90'
      : 'text-text/75';
  return (
    <div className={`whitespace-pre-wrap break-all px-2 py-px ${cls}`}>
      {line}
    </div>
  );
}

export function MutateReviewPane() {
  const pendingMutateReview = useWorkspaceStore((s) => s.pendingMutateReview);
  const acceptMutateReview = useWorkspaceStore((s) => s.acceptMutateReview);
  const rejectMutateReview = useWorkspaceStore((s) => s.rejectMutateReview);
  const [reviewSelected, setReviewSelected] = useState<string[]>([]);
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [diffPreview, setDiffPreview] = useState<DiffPreview | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffMode, setDiffMode] = useState<DiffMode>('unified');

  useEffect(() => {
    if (!pendingMutateReview) {
      setReviewSelected([]);
      setDiffPath(null);
      setDiffPreview(null);
      return;
    }
    setReviewSelected(pendingMutateReview.paths);
    setDiffPath((cur) =>
      cur && pendingMutateReview.paths.includes(cur)
        ? cur
        : (pendingMutateReview.paths[0] ?? null),
    );
  }, [pendingMutateReview]);

  const loadDiff = useCallback(
    async (path: string) => {
      if (!pendingMutateReview) return;
      setDiffPath(path);
      setDiffLoading(true);
      try {
        const doc = await fetchCheckpointPreview({
          checkpointId: pendingMutateReview.checkpointId,
          path,
          sessionId: pendingMutateReview.sessionId,
        });
        if (!doc.ok) {
          setDiffPreview({ before: null, after: doc.error || 'preview failed' });
        } else {
          setDiffPreview({
            before: doc.before ?? null,
            after: doc.after ?? null,
            before_bytes: doc.before_bytes,
            after_bytes: doc.after_bytes,
            is_new: doc.is_new,
            diff_lines: doc.diff_lines,
            diff_added: doc.diff_added,
            diff_removed: doc.diff_removed,
          });
        }
      } catch (e: unknown) {
        setDiffPreview({
          before: null,
          after: e instanceof Error ? e.message : String(e),
        });
      } finally {
        setDiffLoading(false);
      }
    },
    [pendingMutateReview],
  );

  useEffect(() => {
    if (!diffPath || !pendingMutateReview) return;
    void loadDiff(diffPath);
  }, [diffPath, pendingMutateReview, loadDiff]);

  if (!pendingMutateReview) return null;

  const paths = pendingMutateReview.paths;
  const stats =
    diffPreview?.diff_added != null
      ? `+${diffPreview.diff_added}/-${diffPreview.diff_removed ?? 0}`
      : null;

  return (
    <section className="flex h-full min-h-0 flex-col bg-ink" data-testid="mutate-review-bar">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <p className="min-w-0 flex-1 text-[12px] text-muted">
          변경 {paths.length}개 · 선택 {reviewSelected.length}개
        </p>
        <div className="flex gap-0.5 rounded-md border border-line bg-panel p-0.5">
          <button
            type="button"
            onClick={() => setDiffMode('unified')}
            className={`rounded px-2 py-1 text-[11px] font-medium ${
              diffMode === 'unified' ? 'bg-accent text-ink' : 'text-muted hover:text-text'
            }`}
          >
            Unified
          </button>
          <button
            type="button"
            onClick={() => setDiffMode('split')}
            className={`rounded px-2 py-1 text-[11px] font-medium ${
              diffMode === 'split' ? 'bg-accent text-ink' : 'text-muted hover:text-text'
            }`}
          >
            Split
          </button>
        </div>
        <button
          type="button"
          onClick={() => acceptMutateReview()}
          data-testid="mutate-review-accept"
          className="rounded-md border border-line bg-panel-2 px-2.5 py-1 text-[11px] font-semibold text-text hover:border-accent/50"
        >
          Accept
        </button>
        <button
          type="button"
          disabled={!reviewSelected.length}
          onClick={() => void rejectMutateReview(reviewSelected)}
          data-testid="mutate-review-reject-selected"
          className="rounded-md border border-amber-400/40 bg-amber-950/20 px-2.5 py-1 text-[11px] font-semibold text-amber-100 hover:border-amber-400/70 disabled:opacity-40"
        >
          Reject 선택
        </button>
        <button
          type="button"
          onClick={() => void rejectMutateReview()}
          data-testid="mutate-review-reject"
          className="rounded-md border border-red-400/40 bg-red-950/20 px-2.5 py-1 text-[11px] font-semibold text-red-200 hover:border-red-400/70"
        >
          Reject 전부
        </button>
      </div>

      <ResizableSplit
        className="min-h-0 flex-1"
        axis="horizontal"
        initial={220}
        min={140}
        max={420}
        first={
          <ul className="h-full overflow-y-auto border-r border-line py-1">
            {paths.slice(0, 40).map((p) => {
              const checked = reviewSelected.includes(p);
              const active = diffPath === p;
              return (
                <li key={p} className="px-1.5 py-0.5">
                  <div
                    className={`flex items-center gap-1.5 rounded-md px-1.5 py-1 ${
                      active ? 'bg-line/70' : 'hover:bg-panel'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setReviewSelected((cur) =>
                          cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p],
                        )
                      }
                      className="shrink-0"
                      aria-label={`선택 ${p}`}
                    />
                    <button
                      type="button"
                      title={p}
                      className="min-w-0 flex-1 truncate text-left text-[12px] text-text"
                      onClick={() => setDiffPath(p)}
                    >
                      {fileLabel(p)}
                    </button>
                    <button
                      type="button"
                      className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-amber-200/80 hover:bg-amber-500/10"
                      onClick={() => void rejectMutateReview([p])}
                    >
                      복원
                    </button>
                  </div>
                </li>
              );
            })}
            {paths.length > 40 ? (
              <li className="px-3 py-1 text-[10px] text-muted">+{paths.length - 40} more</li>
            ) : null}
          </ul>
        }
        second={
          <div className="flex h-full min-h-0 flex-col">
            <div className="shrink-0 border-b border-line px-3 py-1.5 text-[11px] text-muted">
              {diffPath ?? '파일을 선택하세요'}
              {stats ? ` · ${stats}` : ''}
              {diffPreview?.is_new ? ' · 신규 · Reject 시 삭제' : ''}
            </div>
            <div className="min-h-0 flex-1 overflow-auto font-mono text-[12px] leading-relaxed">
              {diffLoading ? (
                <p className="px-3 py-4 text-[12px] text-muted">로딩…</p>
              ) : diffMode === 'split' ? (
                <div className="grid h-full min-h-0 grid-cols-2 gap-px bg-line">
                  <pre className="min-h-0 overflow-auto bg-ink p-3 text-text/80">
                    {diffPreview?.before ?? '(스냅샷 없음)'}
                  </pre>
                  <pre className="min-h-0 overflow-auto bg-ink p-3 text-text/80">
                    {diffPreview?.after ?? '(현재 없음)'}
                  </pre>
                </div>
              ) : diffPreview?.diff_lines?.length ? (
                <pre className="p-1">
                  {diffPreview.diff_lines.map((line, i) => (
                    <DiffLine key={`${i}-${line.slice(0, 24)}`} line={line} />
                  ))}
                </pre>
              ) : (
                <pre className="p-3 text-text/80">{diffPreview?.after ?? diffPreview?.before ?? 'diff 없음'}</pre>
              )}
            </div>
          </div>
        }
      />
    </section>
  );
}
