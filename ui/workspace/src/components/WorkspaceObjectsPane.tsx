import Editor from '@monaco-editor/react';
import {
  ArrowSquareOut,
  CaretDown,
  CaretUp,
  Check,
  Code,
  DownloadSimple,
  FileText,
  FloppyDisk,
  Folder,
  Image as ImageIcon,
  LinkSimple,
  X,
} from '@phosphor-icons/react';
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { openWorkspacePathInExplorer } from '../api/myAgentClient';
import { isAllowedDocumentPath } from '../lib/documentFile';
import { navigateTabs } from '../lib/tabNavigation';
import { useTheme } from '../lib/theme';
import { openWorkspaceFileWithConfiguredApp } from '../lib/applicationAssociations';
import type { WorkspaceAsset } from '../types';
import { useWorkspaceStore } from '../store/workspaceStore';
import { AssetExplorer } from './AssetExplorer';
import {
  WORKSPACE_OBJECT_TABS,
  type WorkspaceObjectTabId,
} from './workspaceObjectTabs';

export interface TodoProgressItem {
  id: string;
  label: string;
  status: 'pending' | 'active' | 'done' | 'blocked';
  authoredBy?: 'model';
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
  return <div className="m-3 px-3 py-4 text-center text-xs text-muted">{children}</div>;
}

function RecentAsset({ asset, showDownloadAction }: { asset: WorkspaceAsset; showDownloadAction: boolean }) {
  const downloadAsset = useWorkspaceStore((state) => state.downloadAsset);
  const openImagePreview = useWorkspaceStore((state) => state.openImagePreview);
  const openDocumentPath = useWorkspaceStore((state) => state.openDocumentPath);
  const openFile = useWorkspaceStore((state) => state.openFile);
  const openAsset = () => {
    if (asset.kind === 'image' && asset.imageUrl) {
      openImagePreview({ src: asset.imageUrl, title: asset.title, prompt: asset.prompt || '' });
    } else if (asset.sourcePath && isAllowedDocumentPath(asset.sourcePath)) {
      void openDocumentPath(asset.sourcePath);
    } else if (asset.sourcePath) {
      void openFile(asset.sourcePath);
    } else {
      useWorkspaceStore.getState().openAssetInEditor(asset.id);
    }
  };

  const docAvailable = Boolean(asset.sourcePath && isAllowedDocumentPath(asset.sourcePath));

  return (
    <article className="group flex min-w-0 items-center gap-2 border-b border-line/70 px-3 py-2 last:border-b-0 hover:bg-ink/60">
      {asset.kind === 'image' && asset.imageUrl ? (
        <img src={asset.imageUrl} alt="" className="h-8 w-8 shrink-0 rounded-md object-cover" />
      ) : (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-ink">
          <AssetIcon asset={asset} />
        </span>
      )}
      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        onClick={openAsset}
        title={`${asset.kind === 'image' && asset.imageUrl ? '이미지 미리보기' : docAvailable ? '문서 탭에서 열기' : '앱 내 뷰어에서 열기'} · ${asset.sourcePath || asset.title}`}
      >
        <span className="block truncate text-xs font-medium text-text">{asset.title}</span>
        <span className="block truncate text-[11px] text-muted">
          {asset.sourcePath || (asset.kind === 'image' ? '생성 이미지' : asset.language || '결과물')}
        </span>
        <span className="mt-0.5 block text-[10px] text-accent">
          {asset.modificationCount ? `변경 기록 ${asset.modificationCount}회` : asset.imageUrl ? '이미지 결과' : '등록된 작업물'}
        </span>
      </button>
      {showDownloadAction ? (
        <button
          type="button"
          title="다운로드"
          aria-label={`${asset.title} 다운로드`}
          className="rounded-md border border-line p-1.5 text-muted opacity-0 transition-opacity hover:border-accent/60 hover:text-text focus:opacity-100 group-hover:opacity-100"
          onClick={() => downloadAsset(asset.id)}
        >
          <DownloadSimple size={13} />
        </button>
      ) : null}
      {asset.sourcePath && (
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={openAsset}
            title={docAvailable ? '문서 탭에서 열기' : '앱 내 코드 뷰어에서 열기'}
            className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[10px] text-text hover:border-accent/60"
          >
            {docAvailable ? '문서' : '뷰어'}
          </button>
          <button
            type="button"
            aria-label={`${asset.title} 외부 앱으로 열기`}
            title="Windows 연결 프로그램으로 열기"
            className="ui-secondary !min-h-[26px] !px-1.5 !py-1"
            onClick={() => void openWorkspaceFileWithConfiguredApp(asset.sourcePath!, asset.title)}
          >
            <ArrowSquareOut size={13} />
          </button>
        </div>
      )}
    </article>
  );
}

export function WorkspaceObjectsPane({ showDownloadActions = false, todoItems = [], todoError = null }: { showDownloadActions?: boolean; todoItems?: TodoProgressItem[]; todoError?: string | null }) {
  const tabId = useId();
  const { resolved: theme } = useTheme();
  const [activeTab, setActiveTab] = useState<WorkspaceObjectTabId>('recent');
  const [viewerCollapsed, setViewerCollapsed] = useState(false);
  const [instructionDraft, setInstructionDraft] = useState('');
  const [pinnedInstructions, setPinnedInstructions] = useState<string[]>(loadPinnedInstructions);
  const assets = useWorkspaceStore((state) => state.assets);
  const browserHistory = useWorkspaceStore((state) => state.browserHistory);
  const browserLoadedUrl = useWorkspaceStore((state) => state.browserLoadedUrl);
  const filesRoot = useWorkspaceStore((state) => state.filesRoot);
  const openTabs = useWorkspaceStore((state) => state.openTabs);
  const activeTabId = useWorkspaceStore((state) => state.activeTabId);
  const setActiveEditorTab = useWorkspaceStore((state) => state.setActiveTab);
  const closeEditorTab = useWorkspaceStore((state) => state.closeEditorTab);
  const setEditorContent = useWorkspaceStore((state) => state.setEditorContent);
  const saveActiveFile = useWorkspaceStore((state) => state.saveActiveFile);
  const editorSaving = useWorkspaceStore((state) => state.editorSaving);
  const editorSaveStatus = useWorkspaceStore((state) => state.editorSaveStatus);
  const setMode = useWorkspaceStore((state) => state.setMode);
  const navigateBrowser = useWorkspaceStore((state) => state.navigateBrowser);
  const refreshExplorer = useWorkspaceStore((state) => state.refreshExplorer);
  const workAssets = useMemo(() => assets.filter((asset) => Boolean(asset.sourcePath || asset.imageUrl)), [assets]);
  const references = useMemo(() => browserHistory.slice().reverse().slice(0, 6), [browserHistory]);
  const activeEditorTab = useMemo(
    () => openTabs.find((tab) => tab.id === activeTabId) ?? null,
    [openTabs, activeTabId],
  );
  const activeEditorFilePath = activeEditorTab?.id.startsWith('file:')
    ? activeEditorTab.id.slice('file:'.length)
    : null;

  useEffect(() => { void refreshExplorer(); }, [refreshExplorer]);
  useEffect(() => {
    if (activeEditorTab) setViewerCollapsed(false);
  }, [activeEditorTab?.id]);
  useEffect(() => {
    if (!activeEditorTab) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveActiveFile();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeEditorTab, saveActiveFile]);

  const savePinnedInstructions = (next: string[]) => {
    setPinnedInstructions(next);
    localStorage.setItem(PINNED_INSTRUCTIONS_KEY, JSON.stringify(next));
  };
  const openBrowserReference = (url: string) => { navigateBrowser(url); setMode('browser'); };

  return (
    <section className="workspace-results flex h-full min-h-0 flex-col bg-panel" aria-label="작업 내역">
      <header className="workspace-folder-card">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <Folder size={15} weight="duotone" className="shrink-0 text-accent" />
            <h2 className="workspace-folder-name" title={filesRoot || '폴더 미연결'}>
              {filesRoot?.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '현재 대화'}
            </h2>
          </div>
          {filesRoot ? (
            <span className="min-w-0 max-w-[55%] truncate font-mono text-[10px] text-muted" title={filesRoot}>
              {filesRoot}
            </span>
          ) : (
            <span className="shrink-0 text-[10px] text-muted">폴더 미연결</span>
          )}
        </div>
      </header>

      <nav className="workspace-subnav" aria-label="작업 내역 보기" role="tablist" onKeyDown={navigateTabs}>
        {WORKSPACE_OBJECT_TABS.map(({ id, label, icon: Icon }) => {
          const selected = id === activeTab;
          const count = id === 'recent' ? workAssets.length : id === 'todo' ? todoItems.length : undefined;
          return <button key={id} id={`${tabId}-${id}`} aria-controls={`${tabId}-body`} tabIndex={selected ? 0 : -1} type="button" aria-selected={selected} role="tab" onClick={() => setActiveTab(id)} className="ui-tab"><Icon size={14} weight={selected ? 'fill' : 'regular'} />{label}{count !== undefined && count > 0 ? <span>{count}</span> : null}</button>;
        })}
      </nav>

      {activeEditorTab ? (
        <div
          className={`flex shrink-0 flex-col border-b border-line bg-ink ${
            viewerCollapsed ? 'h-auto' : 'h-[48%] min-h-[200px]'
          }`}
          data-testid="inline-code-viewer"
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line bg-panel px-2.5 py-1">
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist" aria-label="열린 코드 파일">
              {openTabs.map((tab) => {
                const isActive = tab.id === activeEditorTab.id;
                const label = tab.id.startsWith('file:') ? tab.id.slice('file:'.length).split(/[\\/]/).pop() || tab.title : tab.title;
                return (
                  <div
                    key={tab.id}
                    className={`flex shrink-0 items-center rounded border text-[11px] ${
                      isActive ? 'border-accent/60 bg-selected text-text' : 'border-line/70 text-muted hover:text-text'
                    }`}
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      onClick={() => {
                        setActiveEditorTab(tab.id);
                        setViewerCollapsed(false);
                      }}
                      className="max-w-36 truncate px-2 py-0.5 font-medium"
                      title={tab.id.startsWith('file:') ? tab.id.slice('file:'.length) : tab.title}
                    >
                      {label}{tab.dirty ? ' ●' : ''}
                    </button>
                    <button
                      type="button"
                      onClick={() => closeEditorTab(tab.id)}
                      aria-label={`${label} 닫기`}
                      className="px-1 py-0.5 text-muted hover:text-text"
                    >
                      <X size={11} weight="bold" />
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {editorSaveStatus ? (
                <span className="text-[10px] text-muted">{editorSaveStatus}</span>
              ) : null}
              {activeEditorFilePath ? (
                <>
                  <button
                    type="button"
                    disabled={editorSaving || !activeEditorTab.dirty}
                    onClick={() => void saveActiveFile()}
                    title="파일 저장 (Ctrl+S)"
                    className="inline-flex items-center gap-1 rounded border border-line px-2 py-0.5 text-[10px] text-text hover:border-accent/60 disabled:opacity-40"
                  >
                    <FloppyDisk size={12} />
                    저장
                  </button>
                  <button
                    type="button"
                    onClick={() => void openWorkspacePathInExplorer(activeEditorFilePath)}
                    title="탐색기에서 위치 열기"
                    className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[10px] text-muted hover:border-accent/60 hover:text-text"
                  >
                    <ArrowSquareOut size={12} />
                  </button>
                </>
              ) : null}
              <button
                type="button"
                onClick={() => setViewerCollapsed((v) => !v)}
                title={viewerCollapsed ? '코드 뷰어 펼치기' : '코드 뷰어 접기'}
                aria-label={viewerCollapsed ? '코드 뷰어 펼치기' : '코드 뷰어 접기'}
                className="inline-flex items-center rounded border border-line p-1 text-muted hover:border-accent/60 hover:text-text"
              >
                {viewerCollapsed ? <CaretDown size={12} /> : <CaretUp size={12} />}
              </button>
            </div>
          </div>
          {!viewerCollapsed ? (
            <div className="min-h-0 flex-1">
              <Editor
                height="100%"
                language={activeEditorTab.language || 'plaintext'}
                theme={theme === 'dark' ? 'vs-dark' : 'vs'}
                value={activeEditorTab.content}
                onChange={(val) => setEditorContent(val ?? '')}
                options={{
                  minimap: { enabled: false },
                  fontSize: 12,
                  wordWrap: 'on',
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                }}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      <div id={`${tabId}-body`} className="min-h-0 flex-1 overflow-auto" role="tabpanel" aria-labelledby={`${tabId}-${activeTab}`}>
        {activeTab === 'recent' && references.length === 0 && !browserLoadedUrl && workAssets.length === 0 ? <EmptyState>참조 링크와 생성·변경 파일이 여기에 표시됩니다.</EmptyState> : activeTab === 'recent' ? <>
          {references.length > 0 || browserLoadedUrl ? (
            <section className="border-b border-line">
              <div className="flex items-center justify-between px-3 py-2"><div className="flex items-center gap-1.5"><LinkSimple size={14} className="text-accent" /><h3 className="text-xs font-semibold text-text">참조 링크</h3></div><span className="text-[10px] text-muted">{browserHistory.length}</span></div>
              {references.map((url) => <button key={url} type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-ink" onClick={() => openBrowserReference(url)} title={url}><LinkSimple size={14} className="shrink-0 text-muted" /><span className="min-w-0 flex-1 truncate text-[11px] text-muted">{displayUrl(url)}</span><ArrowSquareOut size={13} className="shrink-0 text-muted" /></button>)}
              {browserLoadedUrl && !references.includes(browserLoadedUrl) ? <button type="button" className="flex w-full items-center gap-2 border-t border-line/70 px-3 py-2 text-left text-[11px] text-accent hover:bg-ink" onClick={() => openBrowserReference(browserLoadedUrl)} title={browserLoadedUrl}><LinkSimple size={14} className="shrink-0" /><span className="min-w-0 flex-1 truncate">현재 웹 페이지 · {displayUrl(browserLoadedUrl)}</span><ArrowSquareOut size={13} className="shrink-0" /></button> : null}
            </section>
          ) : (
            <div className="flex items-center justify-between border-b border-line px-3 py-1.5 text-[11px] text-muted">
              <span className="inline-flex items-center gap-1.5"><LinkSimple size={13} className="text-muted" />참조 링크 없음</span>
              <span className="text-[10px]">0</span>
            </div>
          )}
          <section><div className="flex items-center justify-between px-3 py-2"><div className="flex items-center gap-1.5"><ImageIcon size={14} className="text-accent" /><h3 className="text-xs font-semibold text-text">변경·생성 파일</h3></div><span className="text-[10px] text-muted">{workAssets.length}</span></div>{workAssets.length === 0 ? <EmptyState>아직 이 세션의 결과물이 없습니다.</EmptyState> : workAssets.map((asset) => <RecentAsset key={asset.id} asset={asset} showDownloadAction={showDownloadActions} />)}</section>
        </> : null}

        {activeTab === 'files' ? (filesRoot ? <AssetExplorer /> : <EmptyState>파일을 보려면 작업 폴더를 연결하세요.</EmptyState>) : null}

        {activeTab === 'todo' ? <div className="p-3">
          <p className="mb-2 text-[10px] text-muted">모델이 등록한 작업과 상태를 표시합니다.</p>
          {todoError ? <p role="status" className="mb-2 text-[11px] text-red-300">{todoError}</p> : null}
          <div className="flex items-center justify-between gap-2"><h3 className="text-xs font-semibold text-text">현재 작업 할 일</h3>{todoItems.length ? <span className="text-[10px] text-muted">{todoItems.filter((item) => item.status === 'done').length}/{todoItems.length}</span> : null}</div>
          {todoItems.length ? <ol className="mt-2 space-y-2" aria-label="현재 작업 할 일 진행 상황">{todoItems.map((item, index) => <li key={item.id} className="flex items-start gap-2 rounded-lg border border-line bg-ink px-3 py-2 text-[11px]"><span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[9px] ${item.status === 'done' ? 'border-accent bg-accent text-ink' : item.status === 'blocked' ? 'border-red-400 text-red-300' : item.status === 'active' ? 'border-accent text-accent' : 'border-line text-muted'}`} aria-label={item.status === 'done' ? '완료' : item.status === 'blocked' ? '차단' : item.status === 'active' ? '진행 중' : '대기'}>{item.status === 'done' ? <Check size={10} weight="bold" /> : index + 1}</span><span className="min-w-0 flex-1"><span className={item.status === 'done' ? 'text-muted line-through' : item.status === 'pending' ? 'text-muted' : 'text-text'}>{item.label}</span>{item.authoredBy === 'model' ? <span className="mt-0.5 block text-[10px] text-muted">작성: 모델 (todo_update)</span> : null}</span></li>)}</ol> : <EmptyState>{todoError ? '조회가 복구되면 모델 TODO를 표시합니다.' : '모델이 등록한 작업이 없습니다.'}</EmptyState>}
          <div className="mt-5 flex items-center justify-between">
            <h3 className="text-xs font-semibold text-text">고정 지침</h3>
            <span className="text-[10px] text-muted">대화 전송 시 자동 반영</span>
          </div>
          <div className="mt-2 flex gap-1"><input value={instructionDraft} onChange={(event) => setInstructionDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && instructionDraft.trim()) { event.preventDefault(); savePinnedInstructions([...pinnedInstructions, instructionDraft.trim()]); setInstructionDraft(''); } }} placeholder="현재 작업 동안 기억할 지침 입력 후 Enter" className="min-w-0 flex-1 rounded-md border border-line bg-ink px-2 py-1.5 text-[11px] text-text outline-none focus:border-accent" /><button type="button" className="rounded-md bg-accent px-2.5 text-[11px] font-semibold text-ink disabled:opacity-40" disabled={!instructionDraft.trim()} onClick={() => { savePinnedInstructions([...pinnedInstructions, instructionDraft.trim()]); setInstructionDraft(''); }}>고정</button></div>
          {pinnedInstructions.map((instruction, index) => <div key={`${instruction}-${index}`} className="mt-2 flex items-start gap-2 rounded-md border border-line bg-ink/50 px-2.5 py-2 text-[11px] text-text"><span className="min-w-0 flex-1">{instruction}</span><button type="button" className="text-muted hover:text-red-300" onClick={() => savePinnedInstructions(pinnedInstructions.filter((_, itemIndex) => itemIndex !== index))}>삭제</button></div>)}
        </div> : null}
      </div>
    </section>
  );
}
