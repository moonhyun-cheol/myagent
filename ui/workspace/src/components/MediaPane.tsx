import {
  ArrowSquareOut,
  ArrowsOutSimple,
  DownloadSimple,
  FilmStrip,
  Image as ImageIcon,
} from '@phosphor-icons/react';
import { useCallback, useMemo, useState } from 'react';
import { useWorkspaceStore } from '../store/workspaceStore';
import type { WorkspaceAsset } from '../types';
import { openWorkspaceFileWithDefaultApp } from '../lib/applicationAssociations';

function mediaFileName(asset: WorkspaceAsset): string {
  const path = asset.sourcePath?.trim();
  if (path) return path.split(/[\\/]/).pop() || asset.title;
  return asset.title;
}

export function MediaPane() {
  const allAssets = useWorkspaceStore((state) => state.assets);
  const openImagePreview = useWorkspaceStore((state) => state.openImagePreview);
  const downloadAsset = useWorkspaceStore((state) => state.downloadAsset);
  const assets = useMemo(() => allAssets.filter((asset) => asset.kind === 'image'), [allAssets]);
  const [hint, setHint] = useState<string | null>(null);

  const openExternal = useCallback(async (asset: WorkspaceAsset) => {
    if (!asset.sourcePath) {
      setHint('이 미디어에는 로컬 파일 경로가 없습니다.');
      return;
    }
    setHint(null);
    try {
      await openWorkspaceFileWithDefaultApp(asset.sourcePath);
    } catch (error) {
      setHint(error instanceof Error ? error.message : 'Windows 기본 앱을 실행하지 못했습니다.');
    }
  }, []);

  const handlePrimaryClick = useCallback(
    (asset: WorkspaceAsset) => {
      setHint(null);
      if (asset.imageUrl) {
        openImagePreview({
          src: asset.imageUrl,
          title: mediaFileName(asset),
          prompt: asset.prompt || '',
        });
        return;
      }
      if (asset.sourcePath) {
        void openExternal(asset);
        return;
      }
      setHint('미리보기할 이미지 주소나 로컬 파일 경로가 없습니다.');
    },
    [openExternal, openImagePreview],
  );

  if (!assets.length) {
    return (
      <div className="flex h-full overflow-auto bg-panel">
        <div className="ui-empty">
          <FilmStrip size={36} className="text-accent" aria-hidden="true" />
          <h2>아직 이미지가 없습니다</h2>
          <p>이 대화에서 생성하거나 작업 결과로 등록된 이미지를 모아 보여줍니다.</p>
          <p>대화에서 이미지 생성을 요청하거나 작업 패널의 파일 목록을 확인하세요.</p>
          <button type="button" className="ui-secondary" onClick={() => useWorkspaceStore.getState().setMode('objects')}>작업 내역 보기</button>
        </div>
      </div>
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-panel" aria-label="미디어 갤러리">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-line bg-panel px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <ImageIcon size={16} className="shrink-0 text-accent" weight="duotone" />
          <h2 className="truncate text-xs font-semibold text-text">미디어</h2>
          <span className="rounded bg-ink px-1.5 py-0.5 text-[10px] text-muted">{assets.length}</span>
        </div>
        <span className="truncate text-[11px] text-muted">클릭하여 확대 미리보기</span>
      </header>
      {hint ? (
        <p role="status" className="shrink-0 border-b border-line bg-panel-2/50 px-3 py-1.5 text-[11px] text-accent">
          {hint}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {assets.map((asset) => {
            const name = mediaFileName(asset);
            const canOpen = Boolean(asset.imageUrl || asset.sourcePath);
            return (
              <article
                key={asset.id}
                className="group flex flex-col overflow-hidden rounded-lg border border-line bg-ink transition hover:border-accent/50"
              >
                <button
                  type="button"
                  onClick={() => handlePrimaryClick(asset)}
                  disabled={!canOpen}
                  title={asset.imageUrl ? `${name} 확대 미리보기` : asset.sourcePath ? `${asset.sourcePath} 열기` : '열 수 없는 미디어'}
                  className="relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden bg-panel-2 text-left disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {asset.imageUrl ? (
                    <img
                      src={asset.imageUrl}
                      alt={name}
                      loading="lazy"
                      className="h-full w-full object-cover transition duration-200 group-hover:scale-[1.02]"
                    />
                  ) : (
                    <div className="flex flex-col items-center gap-1.5 text-muted">
                      <ImageIcon size={28} weight="duotone" className="text-accent/80" />
                      <span className="text-[11px]">로컬 이미지 파일</span>
                    </div>
                  )}
                  {asset.imageUrl ? (
                    <span className=" absolute right-2 top-2 inline-flex items-center gap-1 rounded bg-panel/85 px-1.5 py-0.5 text-[10px] text-text opacity-0 shadow backdrop-blur-sm transition-opacity group-hover:opacity-100">
                      <ArrowsOutSimple size={11} />
                      확대
                    </span>
                  ) : null}
                </button>
                <div className="flex items-center justify-between gap-2 border-t border-line/70 px-2.5 py-2">
                  <button
                    type="button"
                    onClick={() => handlePrimaryClick(asset)}
                    disabled={!canOpen}
                    className="min-w-0 flex-1 text-left"
                    title={asset.sourcePath || name}
                  >
                    <span className="block truncate text-xs font-medium text-text">{name}</span>
                    <span className="block truncate text-[10px] text-muted">
                      {asset.sourcePath || (asset.prompt ? `프롬프트 · ${asset.prompt}` : '생성된 이미지')}
                    </span>
                  </button>
                  <div className="flex shrink-0 items-center gap-1">
                    {asset.imageUrl ? (
                      <button
                        type="button"
                        title="이미지 다운로드"
                        aria-label={`${name} 다운로드`}
                        onClick={() => downloadAsset(asset.id)}
                        className="rounded border border-line p-1.5 text-muted hover:border-accent/60 hover:text-text"
                      >
                        <DownloadSimple size={13} />
                      </button>
                    ) : null}
                    {asset.sourcePath ? (
                      <button
                        type="button"
                        title="Windows 기본 앱으로 열기"
                        aria-label={`${name} 기본 앱으로 열기`}
                        onClick={() => void openExternal(asset)}
                        className="rounded border border-line p-1.5 text-muted hover:border-accent/60 hover:text-text"
                      >
                        <ArrowSquareOut size={13} />
                      </button>
                    ) : null}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
