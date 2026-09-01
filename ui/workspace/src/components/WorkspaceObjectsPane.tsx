import {
  ArrowSquareOut,
  Check,
  Code,
  DownloadSimple,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  LinkSimple,
} from '@phosphor-icons/react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { openWorkspaceRootInExplorer } from '../api/myAgentClient';
import { openWorkspaceFileWithConfiguredApp } from '../lib/applicationAssociations';
import type { WorkspaceAsset } from '../types';
import { useWorkspaceStore } from '../store/workspaceStore';
import { AssetExplorer } from './AssetExplorer';
import {
  getWorkspaceObjectTab,
  WORKSPACE_OBJECT_TABS,
  type WorkspaceObjectTabId,
} from './workspaceObjectTabs';

export interface TodoProgressItem {
  id: string;
  label: string;
  status: 'pending' | 'active' | 'done' | 'blocked';
}

const PINNED_INSTRUCTIONS_KEY = 'my-agent-pinned-instructions-v1';

function loadPinnedInstructions(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(PINNED_INSTRUCTIONS_KEY) ?? '[]');
    return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

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

function EmptyState({ children }: { children: ReactNode }) {
  return <div className="m-3 rounded-lg border border-dashed border-line bg-ink/50 px-3 py-4 text-center text-[11px] text-muted">{children}</div>;
}

function RecentAsset({ asset, showDownloadAction }: { asset: WorkspaceAsset; showDownloadAction: boolean }) {
  const downloadAsset = useWorkspaceStore((state) => state.downloadAsset);
  const openImagePreview = useWorkspaceStore((state) => state.openImagePreview);
  const openAsset = () => {
    if (asset.kind === 'image' && asset.imageUrl) {
      openImagePreview({ src: asset.imageUrl, title: asset.title, prompt: asset.prompt || '' });
    } else if (asset.sourcePath) {
      void openWorkspaceFileWithConfiguredApp(asset.sourcePath, asset.title);
    } else {
      useWorkspaceStore.getState().openAssetInEditor(asset.id);
    }
  };

  return (
    <article className="group flex min-w-0 items-center gap-2 border-b border-line/70 px-3 py-2 last:border-b-0">
      {asset.kind === 'image' && asset.imageUrl ? <img src={asset.imageUrl} alt="" className="h-8 w-8 shrink-0 rounded-md object-cover" /> : <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-ink"><AssetIcon asset={asset} /></span>}
      <button type="button" className="min-w-0 flex-1 text-left" onClick={openAsset} title={asset.sourcePath || asset.title}>
        <span className="block truncate text-xs font-medium text-text">{asset.title}</span>
        <span className="block truncate text-[10px] text-muted">{asset.sourcePath || (asset.kind === 'image' ? '생성 이미지' : asset.language || '결과물')}{(asset.modificationCount ?? 0) > 1 ? ` · 수정 ${asset.modificationCount}회` : ''}</span>
      </button>
      {showDownloadAction ? <button type="button" title="다운로드" aria-label={`${asset.title} 다운로드`} className="rounded-md border border-line p-1.5 text-muted opacity-0 transition-opacity hover:border-accent/60 hover:text-text focus:opacity-100 group-hover:opacity-100" onClick={() => downloadAsset(asset.id)}><DownloadSimple size={13} /></button> : null}
      <button type="button" aria-label={`${asset.title} 열기`} className="rounded-md p-1.5 text-muted hover:bg-ink hover:text-text" onClick={openAsset}><ArrowSquareOut size={13} /></button>
    </article>
  );
}

export function WorkspaceObjectsPane({ showDownloadActions = false, todoItems = [] }: { showDownloadActions?: boolean; todoItems?: TodoProgressItem[] }) {
  const [activeTab, setActiveTab] = useState<WorkspaceObjectTabId>('recent');
  const [explorerMessage, setExplorerMessage] = useState<string | null>(null);
  const [instructionDraft, setInstructionDraft] = useState('');
  const [pinnedInstructions, setPinnedInstructions] = useState<string[]>(loadPinnedInstructions);
  const assets = useWorkspaceStore((state) => state.assets);
  const browserHistory = useWorkspaceStore((state) => state.browserHistory);
  const browserLoadedUrl = useWorkspaceStore((state) => state.browserLoadedUrl);
  const filesRoot = useWorkspaceStore((state) => state.filesRoot);
  const setMode = useWorkspaceStore((state) => state.setMode);
  const navigateBrowser = useWorkspaceStore((state) => state.navigateBrowser);
  const refreshExplorer = useWorkspaceStore((state) => state.refreshExplorer);
  const workAssets = useMemo(() => assets.filter((asset) => Boolean(asset.sourcePath || asset.imageUrl)), [assets]);
  const references = useMemo(() => browserHistory.slice().reverse().slice(0, 6), [browserHistory]);
  const activeDefinition = getWorkspaceObjectTab(activeTab);

  useEffect(() => { void refreshExplorer(); }, [refreshExplorer]);

  const savePinnedInstructions = (next: string[]) => {
    setPinnedInstructions(next);
    localStorage.setItem(PINNED_INSTRUCTIONS_KEY, JSON.stringify(next));
  };
  const openBrowserReference = (url: string) => { navigateBrowser(url); setMode('browser'); };
  const openExplorer = () => {
    setExplorerMessage(null);
    void openWorkspaceRootInExplorer().then(({ root }) => setExplorerMessage(`탐색기에서 열림 · ${root}`)).catch((error) => setExplorerMessage(error instanceof Error ? error.message : String(error)));
  };

  return (
    <section className="flex h-full min-h-0 flex-col bg-panel" aria-label="작업 오브젝트">
      <header className="shrink-0 border-b border-line px-3 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0"><p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">Workspace</p><h2 className="mt-1 text-sm font-semibold tracking-tight text-text">작업 오브젝트</h2><p className="mt-1 text-[10px] text-muted">{activeDefinition.description}</p></div>
          <button type="button" data-testid="open-workspace-explorer" disabled={!filesRoot} onClick={openExplorer} title={filesRoot ? `탐색기에서 열기 · ${filesRoot}` : '작업 폴더를 먼저 연결하세요.'} className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line bg-ink px-2 py-1.5 text-[10px] text-muted hover:border-accent/60 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"><FolderOpen size={13} weight="bold" />탐색기</button>
        </div>
        {explorerMessage ? <p className="mt-2 truncate text-[10px] text-muted" title={explorerMessage}>{explorerMessage}</p> : null}
        {filesRoot ? <p className="mt-2 truncate font-mono text-[10px] text-muted/80" title={filesRoot}>{filesRoot}</p> : null}
      </header>

      <nav className="flex shrink-0 gap-1 border-b border-line px-2 py-2" aria-label="작업 오브젝트 보기" role="tablist">
        {WORKSPACE_OBJECT_TABS.map(({ id, label, icon: Icon }) => {
          const selected = id === activeTab;
          const count = id === 'recent' ? workAssets.length : id === 'todo' ? todoItems.length : undefined;
          return <button key={id} type="button" aria-selected={selected} role="tab" onClick={() => setActiveTab(id)} className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium ${selected ? 'bg-accent/10 text-accent' : 'text-muted hover:bg-ink hover:text-text'}`}><Icon size={13} weight={selected ? 'fill' : 'regular'} />{label}{count !== undefined ? <span className="text-[10px] opacity-70">{count}</span> : null}</button>;
        })}
      </nav>

      <div className="min-h-0 flex-1 overflow-auto" role="tabpanel" aria-label={activeDefinition.label}>
        {activeTab === 'recent' ? <>
          <section className="border-b border-line">
            <div className="flex items-center justify-between px-3 py-2.5"><div className="flex items-center gap-1.5"><LinkSimple size={14} className="text-accent" /><h3 className="text-xs font-semibold text-text">참조 링크</h3></div><span className="text-[10px] text-muted">{browserHistory.length}</span></div>
            {references.length === 0 ? <EmptyState>이 세션에서 참조한 링크가 없습니다.</EmptyState> : references.map((url) => <button key={url} type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-ink" onClick={() => openBrowserReference(url)} title={url}><LinkSimple size={14} className="shrink-0 text-muted" /><span className="min-w-0 flex-1 truncate text-[11px] text-muted">{displayUrl(url)}</span><ArrowSquareOut size={13} className="shrink-0 text-muted" /></button>)}
            {browserLoadedUrl && !references.includes(browserLoadedUrl) ? <button type="button" className="flex w-full items-center gap-2 border-t border-line/70 px-3 py-2 text-left text-[11px] text-accent hover:bg-ink" onClick={() => openBrowserReference(browserLoadedUrl)} title={browserLoadedUrl}><LinkSimple size={14} className="shrink-0" /><span className="min-w-0 flex-1 truncate">현재 웹 페이지 · {displayUrl(browserLoadedUrl)}</span><ArrowSquareOut size={13} className="shrink-0" /></button> : null}
          </section>
          <section><div className="flex items-center justify-between px-3 py-2.5"><div className="flex items-center gap-1.5"><ImageIcon size={14} className="text-accent" /><h3 className="text-xs font-semibold text-text">변경·생성 파일</h3></div><span className="text-[10px] text-muted">{workAssets.length}</span></div>{workAssets.length === 0 ? <EmptyState>아직 이 세션의 결과물이 없습니다.</EmptyState> : workAssets.map((asset) => <RecentAsset key={asset.id} asset={asset} showDownloadAction={showDownloadActions} />)}</section>
        </> : null}

        {activeTab === 'files' ? (filesRoot ? <AssetExplorer /> : <EmptyState>파일을 보려면 작업 폴더를 연결하세요.</EmptyState>) : null}

        {activeTab === 'todo' ? <div className="p-3">
          <div className="flex items-center justify-between gap-2"><h3 className="text-xs font-semibold text-text">현재 작업 Todo</h3>{todoItems.length ? <span className="text-[10px] text-muted">{todoItems.filter((item) => item.status === 'done').length}/{todoItems.length}</span> : null}</div>
          {todoItems.length ? <ol className="mt-2 space-y-2" aria-label="현재 작업 Todo 진행 상황">{todoItems.map((item, index) => <li key={item.id} className="flex items-start gap-2 rounded-lg border border-line bg-ink px-3 py-2 text-[11px]"><span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[9px] ${item.status === 'done' ? 'border-accent bg-accent text-ink' : item.status === 'blocked' ? 'border-red-400 text-red-300' : item.status === 'active' ? 'border-accent text-accent' : 'border-line text-muted'}`} aria-label={item.status === 'done' ? '완료' : item.status === 'blocked' ? '차단' : item.status === 'active' ? '진행 중' : '대기'}>{item.status === 'done' ? <Check size={10} weight="bold" /> : index + 1}</span><span className={item.status === 'done' ? 'text-muted line-through' : item.status === 'pending' ? 'text-muted' : 'text-text'}>{item.label}</span></li>)}</ol> : <EmptyState>최근 답변에서 인식된 Todo가 없습니다.</EmptyState>}
          <h3 className="mt-5 text-xs font-semibold text-text">고정 지침</h3>
          <div className="mt-2 flex gap-1"><input value={instructionDraft} onChange={(event) => setInstructionDraft(event.target.value)} placeholder="현재 작업 동안 기억할 지침" className="min-w-0 flex-1 rounded-md border border-line bg-ink px-2 py-1.5 text-[11px] text-text outline-none focus:border-accent" /><button type="button" className="rounded-md bg-accent px-2 text-[11px] font-semibold text-ink disabled:opacity-40" disabled={!instructionDraft.trim()} onClick={() => { savePinnedInstructions([...pinnedInstructions, instructionDraft.trim()]); setInstructionDraft(''); }}>고정</button></div>
          {pinnedInstructions.map((instruction, index) => <div key={`${instruction}-${index}`} className="mt-2 flex items-start gap-2 rounded-md border border-line px-2 py-2 text-[11px] text-text"><span className="min-w-0 flex-1">{instruction}</span><button type="button" className="text-muted hover:text-red-300" onClick={() => savePinnedInstructions(pinnedInstructions.filter((_, itemIndex) => itemIndex !== index))}>삭제</button></div>)}
        </div> : null}
      </div>
    </section>
  );
}
