import {
  ArrowSquareOut,
  ClockCounterClockwise,
  Code,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  LinkSimple,
  SquaresFour,
} from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { openWorkspaceRootInExplorer } from '../api/myAgentClient';
import { openWorkspaceFileWithConfiguredApp } from '../lib/applicationAssociations';
import type { WorkspaceAsset } from '../types';
import { isCanvasAsset } from '../types';
import { useWorkspaceStore } from '../store/workspaceStore';
import { AssetExplorer } from './AssetExplorer';
import { AssetGallery } from './AssetGallery';

type ObjectView = 'recent' | 'all' | 'files';

function AssetIcon({ asset }: { asset: WorkspaceAsset }) {
  if (asset.kind === 'image') return <ImageIcon size={16} weight="duotone" className="text-accent" />;
  if (asset.kind === 'code') return <Code size={16} weight="duotone" className="text-accent" />;
  return <FileText size={16} weight="duotone" className="text-accent" />;
}

function displayUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function RecentAsset({ asset }: { asset: WorkspaceAsset }) {
  const openImagePreview = useWorkspaceStore((s) => s.openImagePreview);
  const placeAssetOnCanvas = useWorkspaceStore((s) => s.placeAssetOnCanvas);
  const setMode = useWorkspaceStore((s) => s.setMode);
  const canvasAvailable = isCanvasAsset(asset);

  return (
    <article className="flex min-w-0 items-center gap-2 border-b border-line/70 px-3 py-1.5 last:border-b-0">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {asset.kind === 'image' && asset.imageUrl ? (
          <img src={asset.imageUrl} alt="" className="h-8 w-8 shrink-0 rounded-md object-cover" />
        ) : (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-ink">
            <AssetIcon asset={asset} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-text" title={asset.title}>{asset.title}</p>
        <p className="hidden">
          {asset.kind === 'image' ? '이미지 · 캔버스' : isCanvasAsset(asset) ? '워크플로 · 캔버스' : `${asset.language || '텍스트'} · 에디터`}
        </p>
        </div>
      </div>
      <div className="flex shrink-0 gap-1">
        {asset.kind === 'image' && asset.imageUrl ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[10px] text-muted hover:border-accent/60 hover:text-text"
            onClick={() => openImagePreview({ src: asset.imageUrl!, title: asset.title, prompt: asset.prompt || '' })}
          >
            <ArrowSquareOut size={12} />
            미리보기
          </button>
        ) : (
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[10px] text-muted hover:border-accent/60 hover:text-text"
            onClick={() => void openWorkspaceFileWithConfiguredApp(asset.id, asset.title)}
          >
            <ArrowSquareOut size={12} />
            에디터
          </button>
        )}
        <button
          type="button"
          disabled={!canvasAvailable}
          title={canvasAvailable ? '캔버스에서 열기' : '이 파일 형식은 캔버스에서 열 수 없습니다'}
          className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[10px] text-muted hover:border-accent/60 hover:text-text disabled:cursor-not-allowed disabled:border-line/60 disabled:text-muted/40 disabled:hover:border-line/60 disabled:hover:text-muted/40"
          onClick={() => {
            if (!canvasAvailable) return;
            placeAssetOnCanvas(asset.id);
            setMode('canvas');
          }}
        >
          <SquaresFour size={12} />
          캔버스
        </button>
      </div>
    </article>
  );
}

export function WorkspaceObjectsPane() {
  const [view, setView] = useState<ObjectView>('recent');
  const [explorerMessage, setExplorerMessage] = useState<string | null>(null);
  const assets = useWorkspaceStore((s) => s.assets);
  const browserHistory = useWorkspaceStore((s) => s.browserHistory);
  const browserLoadedUrl = useWorkspaceStore((s) => s.browserLoadedUrl);
  const filesRoot = useWorkspaceStore((s) => s.filesRoot);
  const setMode = useWorkspaceStore((s) => s.setMode);
  const navigateBrowser = useWorkspaceStore((s) => s.navigateBrowser);
  const refreshExplorer = useWorkspaceStore((s) => s.refreshExplorer);

  useEffect(() => {
    void refreshExplorer();
  }, [refreshExplorer]);

  const openBrowserReference = (url: string) => {
    navigateBrowser(url);
    setMode('browser');
  };

  const openExplorer = () => {
    setExplorerMessage(null);
    void openWorkspaceRootInExplorer()
      .then(({ root }) => setExplorerMessage(`탐색기에서 열림 · ${root}`))
      .catch((error) => setExplorerMessage(error instanceof Error ? error.message : String(error)));
  };

  const recentAssets = assets.slice(0, 6);
  const references = browserHistory.slice().reverse().slice(0, 6);

  if (view === 'all') {
    return (
      <div className="flex h-full min-h-0 flex-col bg-panel">
        <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-2">
          <button
            type="button"
            className="rounded-md px-2 py-1 text-[11px] text-muted hover:bg-ink hover:text-text"
            onClick={() => setView('recent')}
          >
            작업
          </button>
          <span className="rounded-md bg-accent/10 px-2 py-1 text-[11px] font-medium text-accent">전체 결과물</span>
          <button
            type="button"
            className="rounded-md px-2 py-1 text-[11px] text-muted hover:bg-ink hover:text-text"
            onClick={() => setView('files')}
          >
            파일
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <AssetGallery />
        </div>
      </div>
    );
  }

  if (view === 'files') {
    return (
      <section className="flex h-full min-h-0 flex-col bg-panel" aria-label="작업 오브젝트">
        <header className="shrink-0 border-b border-line px-3 py-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">Workspace</p>
              <h2 className="mt-1 text-sm font-semibold tracking-tight text-text">작업 오브젝트</h2>
              <p className="mt-1 text-[10px] text-muted">대화에서 만든 결과와 참고 대상을 바로 이어서 엽니다.</p>
            </div>
            <button
              type="button"
              data-testid="open-workspace-explorer"
              disabled={!filesRoot}
              onClick={openExplorer}
              title={filesRoot ? `탐색기에서 열기 · ${filesRoot}` : '작업 폴더를 먼저 연결하세요'}
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line bg-ink px-2 py-1.5 text-[10px] text-muted hover:border-accent/60 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
            >
              <FolderOpen size={13} weight="bold" />
              탐색기
            </button>
          </div>
          {explorerMessage ? <p className="mt-2 truncate text-[10px] text-muted" title={explorerMessage}>{explorerMessage}</p> : null}
          {filesRoot ? <p className="mt-2 truncate font-mono text-[10px] text-muted/80" title={filesRoot}>{filesRoot}</p> : null}
        </header>

        <div className="flex shrink-0 gap-1 border-b border-line px-2 py-2">
          <button
            type="button"
            className="rounded-md px-2.5 py-1 text-[11px] text-muted hover:bg-ink hover:text-text"
            onClick={() => setView('recent')}
          >
            최근 작업물 <span className="ml-1 text-[10px] text-muted/70">{assets.length}</span>
          </button>
          <button
            type="button"
            className="rounded-md bg-accent/10 px-2.5 py-1 text-[11px] font-medium text-accent"
            onClick={() => setView('files')}
          >
            파일
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <AssetExplorer />
        </div>
      </section>
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-panel" aria-label="작업 오브젝트">
      <header className="shrink-0 border-b border-line px-3 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">Workspace</p>
            <h2 className="mt-1 text-sm font-semibold tracking-tight text-text">작업 오브젝트</h2>
            <p className="mt-1 text-[10px] text-muted">대화에서 만든 결과와 참고 대상을 바로 이어서 엽니다.</p>
          </div>
          <button
            type="button"
            data-testid="open-workspace-explorer"
            disabled={!filesRoot}
            onClick={openExplorer}
            title={filesRoot ? `탐색기에서 열기 · ${filesRoot}` : '작업 폴더를 먼저 연결하세요'}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line bg-ink px-2 py-1.5 text-[10px] text-muted hover:border-accent/60 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
          >
            <FolderOpen size={13} weight="bold" />
            탐색기
          </button>
        </div>
        {explorerMessage ? <p className="mt-2 truncate text-[10px] text-muted" title={explorerMessage}>{explorerMessage}</p> : null}
        {filesRoot ? <p className="mt-2 truncate font-mono text-[10px] text-muted/80" title={filesRoot}>{filesRoot}</p> : null}
      </header>

      <div className="flex shrink-0 gap-1 border-b border-line px-2 py-2">
        <button
          type="button"
          className="rounded-md bg-accent/10 px-2.5 py-1 text-[11px] font-medium text-accent"
          onClick={() => setView('recent')}
        >
          최근 작업물 <span className="ml-1 text-[10px] text-accent/70">{assets.length}</span>
        </button>
        <button
          type="button"
          className="rounded-md px-2.5 py-1 text-[11px] text-muted hover:bg-ink hover:text-text"
          onClick={() => setView('files')}
        >
          파일
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <section className="border-b border-line">
          <div className="flex items-center justify-between px-3 py-2.5">
            <div className="flex items-center gap-1.5">
              <LinkSimple size={14} className="text-accent" />
              <h3 className="text-xs font-semibold text-text">참조 링크</h3>
            </div>
            <span className="text-[10px] text-muted">{browserHistory.length}</span>
          </div>
          {references.length === 0 ? (
            <p className="px-3 pb-3 text-[11px] text-muted">웹 탭에서 연 링크가 여기에 남습니다.</p>
          ) : (
            <div className="pb-1">
              {references.map((url) => (
                <button
                  key={url}
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-ink"
                  onClick={() => openBrowserReference(url)}
                  title={url}
                >
                  <ClockCounterClockwise size={14} className="shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate text-[11px] text-muted">{displayUrl(url)}</span>
                  <ArrowSquareOut size={13} className="shrink-0 text-muted" />
                </button>
              ))}
            </div>
          )}
          {browserLoadedUrl && !references.includes(browserLoadedUrl) ? (
            <button
              type="button"
              className="flex w-full items-center gap-2 border-t border-line/70 px-3 py-2 text-left text-[11px] text-accent hover:bg-ink"
              onClick={() => openBrowserReference(browserLoadedUrl)}
              title={browserLoadedUrl}
            >
              <LinkSimple size={14} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">현재 웹 페이지 · {displayUrl(browserLoadedUrl)}</span>
              <ArrowSquareOut size={13} className="shrink-0" />
            </button>
          ) : null}
        </section>

        <section>
          <div className="flex items-center justify-between px-3 py-2.5">
            <div className="flex items-center gap-1.5">
              <ImageIcon size={14} className="text-accent" />
              <h3 className="text-xs font-semibold text-text">변경·생성 파일</h3>
            </div>
            <button type="button" className="text-[10px] text-muted hover:text-accent" onClick={() => setView('all')}>
              전체 보기
            </button>
          </div>
          {recentAssets.length === 0 ? (
            <p className="px-3 pb-4 text-[11px] text-muted">아직 이 세션의 결과물이 없습니다.</p>
          ) : (
            <div>{recentAssets.map((asset) => <RecentAsset key={asset.id} asset={asset} />)}</div>
          )}
          {assets.length > recentAssets.length ? (
            <button
              type="button"
              className="m-3 w-[calc(100%-24px)] rounded-md border border-dashed border-line px-2 py-2 text-[10px] text-muted hover:border-accent/60 hover:text-text"
              onClick={() => setView('all')}
            >
              결과물 {assets.length - recentAssets.length}개 더 보기
            </button>
          ) : null}
        </section>
      </div>
    </section>
  );
}