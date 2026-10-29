import Editor, { type OnMount } from '@monaco-editor/react';
import { ArrowSquareOut, FloppyDisk, X } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type FormEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { openWorkspacePathInExplorer, readWorkspaceFsFile } from '../api/myAgentClient';
import { useTheme } from '../lib/theme';
import { usePointOverlay } from '../lib/useAnchoredOverlay';
import { ASSET_MIME, useWorkspaceStore } from '../store/workspaceStore';

interface ViewerContextMenuState {
  x: number;
  y: number;
  tabId: string;
  path?: string;
  renameValue?: string;
}

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function filePathFromTabId(tabId: string): string | null {
  return tabId.startsWith('file:') ? tabId.slice('file:'.length) : null;
}

function tabLabel(tab: { id: string; title: string }): string {
  const path = filePathFromTabId(tab.id);
  if (path) return fileNameFromPath(path);
  return tab.title === 'Generated code' ? 'code.ts' : tab.title;
}

/** The single in-app code viewer/editor for the 작업 panel (tabs, save, rename, context menu). */
export function InlineCodeViewer() {
  const { resolved: theme } = useTheme();
  const openTabs = useWorkspaceStore((s) => s.openTabs);
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);
  const setActiveTab = useWorkspaceStore((s) => s.setActiveTab);
  const closeEditorTab = useWorkspaceStore((s) => s.closeEditorTab);
  const setEditorContent = useWorkspaceStore((s) => s.setEditorContent);
  const saveActiveFile = useWorkspaceStore((s) => s.saveActiveFile);
  const renameWorkspaceFile = useWorkspaceStore((s) => s.renameWorkspaceFile);
  const openAssetInEditor = useWorkspaceStore((s) => s.openAssetInEditor);
  const appendToDocument = useWorkspaceStore((s) => s.appendToDocument);
  const addContextPath = useWorkspaceStore((s) => s.addContextPath);
  const editorSaving = useWorkspaceStore((s) => s.editorSaving);
  const editorSaveStatus = useWorkspaceStore((s) => s.editorSaveStatus);
  const [contextMenu, setContextMenu] = useState<ViewerContextMenuState | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const contextMenuPosition = usePointOverlay(Boolean(contextMenu), contextMenu?.x ?? 0, contextMenu?.y ?? 0, contextMenuRef);
  const activeTab = openTabs.find((tab) => tab.id === activeTabId) ?? null;
  const activeFilePath = activeTab ? filePathFromTabId(activeTab.id) : null;

  useEffect(() => {
    if (!contextMenu) return undefined;
    const closeMenu = () => setContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') closeMenu(); };
    window.addEventListener('click', closeMenu);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('click', closeMenu);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [contextMenu]);

  // Ctrl/Cmd+S belongs to the focused Monaco instance only; getState() avoids a stale closure.
  const onEditorMount: OnMount = (editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void useWorkspaceStore.getState().saveActiveFile();
    });
  };

  const openContextMenu = (event: ReactMouseEvent, tabId: string) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, tabId, path: filePathFromTabId(tabId) ?? undefined });
  };

  const copyPath = async () => {
    if (contextMenu?.path) {
      try { await navigator.clipboard.writeText(contextMenu.path); } catch { /* clipboard denied */ }
    }
    setContextMenu(null);
  };

  const appendPathToDocument = async () => {
    const path = contextMenu?.path;
    if (!path) return;
    try {
      const { content } = await readWorkspaceFsFile(path);
      appendToDocument(`## ${path}\n\n\`\`\`\n${content}\n\`\`\`\n`);
    } catch {
      appendToDocument(`## ${path}\n\n`);
    }
    addContextPath(path);
    setContextMenu(null);
  };

  const submitRename = async (event: FormEvent) => {
    event.preventDefault();
    if (!contextMenu?.path || contextMenu.renameValue === undefined) return;
    try {
      await renameWorkspaceFile(contextMenu.path, contextMenu.renameValue);
      setContextMenu(null);
    } catch {
      // The store status keeps the API error visible while the menu stays open for correction.
    }
  };

  if (!activeTab) {
    return <div className="m-3 px-3 py-4 text-center text-xs text-muted">열린 파일이 없습니다. 파일 탭에서 파일을 선택하세요.</div>;
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-ink"
      data-testid="inline-code-viewer"
      onDragOver={(event) => { if (event.dataTransfer.types.includes(ASSET_MIME)) event.preventDefault(); }}
      onDrop={(event) => {
        const assetId = event.dataTransfer.getData(ASSET_MIME);
        if (!assetId) return;
        event.preventDefault();
        openAssetInEditor(assetId);
      }}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line bg-panel px-2.5 py-1">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist" aria-label="열린 코드 파일">
          {openTabs.map((tab) => {
            const selected = tab.id === activeTab.id;
            const label = tabLabel(tab);
            return (
              <div
                key={tab.id}
                onContextMenu={(event) => openContextMenu(event, tab.id)}
                className={`flex shrink-0 items-center rounded border text-[11px] ${
                  selected ? 'border-accent/60 bg-selected text-text' : 'border-line/70 text-muted hover:text-text'
                }`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setActiveTab(tab.id)}
                  className="max-w-36 truncate px-2 py-0.5 font-medium"
                  title={filePathFromTabId(tab.id) ?? tab.title}
                >
                  {label}{tab.dirty ? <span className="ml-1 text-accent" aria-label="저장되지 않은 변경">●</span> : null}
                </button>
                <button
                  type="button"
                  onClick={() => void closeEditorTab(tab.id)}
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
          {editorSaveStatus ? <span className="max-w-40 truncate text-[10px] text-muted" role="status">{editorSaveStatus}</span> : null}
          {activeFilePath ? (
            <>
              <button
                type="button"
                disabled={editorSaving || !activeTab.dirty}
                onClick={() => void saveActiveFile()}
                title="파일 저장 (편집기에서 Ctrl+S)"
                className="inline-flex items-center gap-1 rounded border border-line px-2 py-0.5 text-[10px] text-text hover:border-accent/60 disabled:opacity-40"
              >
                <FloppyDisk size={12} />
                {editorSaving ? '저장 중…' : '저장'}
              </button>
              <button
                type="button"
                onClick={() => void openWorkspacePathInExplorer(activeFilePath)}
                title="탐색기에서 위치 열기"
                aria-label="탐색기에서 위치 열기"
                className="inline-flex items-center rounded border border-line px-1.5 py-0.5 text-[10px] text-muted hover:border-accent/60 hover:text-text"
              >
                <ArrowSquareOut size={12} />
              </button>
            </>
          ) : null}
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <Editor
          height="100%"
          path={activeTab.id}
          language={activeTab.language || 'plaintext'}
          theme={theme === 'dark' ? 'vs-dark' : 'vs'}
          value={activeTab.content}
          onChange={(value) => setEditorContent(value ?? '')}
          onMount={onEditorMount}
          options={{
            minimap: { enabled: false },
            fontSize: 12,
            wordWrap: 'on',
            scrollBeyondLastLine: false,
            automaticLayout: true,
            find: { seedSearchStringFromSelection: 'always', autoFindInSelection: 'never' },
          }}
        />
      </div>
      {contextMenu ? createPortal(
        <div
          ref={contextMenuRef}
          className="fixed z-[300] min-w-36 rounded border border-line bg-panel p-1 text-[11px] shadow-xl"
          style={{ left: contextMenuPosition?.left ?? 0, top: contextMenuPosition?.top ?? 0, visibility: contextMenuPosition ? 'visible' : 'hidden' }}
          onClick={(event) => event.stopPropagation()}
          role="menu"
        >
          {contextMenu.path ? (
            <>
              <button type="button" role="menuitem" className="block w-full rounded px-2 py-1.5 text-left text-text hover:bg-line" onClick={() => void copyPath()}>경로 복사</button>
              <button
                type="button"
                role="menuitem"
                className="block w-full rounded px-2 py-1.5 text-left text-text hover:bg-line"
                onClick={() => setContextMenu((menu) => (menu ? { ...menu, renameValue: fileNameFromPath(menu.path ?? '') } : null))}
              >
                이름 수정
              </button>
              <button type="button" role="menuitem" className="block w-full rounded px-2 py-1.5 text-left text-text hover:bg-line" onClick={() => void appendPathToDocument()}>문서에 추가</button>
              {contextMenu.renameValue !== undefined ? (
                <form className="mt-1 border-t border-line pt-1" onSubmit={(event) => void submitRename(event)}>
                  <label className="sr-only" htmlFor="inline-viewer-rename-input">새 파일명</label>
                  <input
                    id="inline-viewer-rename-input"
                    autoFocus
                    value={contextMenu.renameValue}
                    onChange={(event) => setContextMenu((menu) => (menu ? { ...menu, renameValue: event.target.value } : null))}
                    className="w-full rounded border border-line bg-ink px-2 py-1 text-text outline-none focus:border-accent"
                  />
                  <button type="submit" className="mt-1 block w-full rounded px-2 py-1.5 text-left text-accent hover:bg-line">이름 변경</button>
                </form>
              ) : null}
            </>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className="block w-full rounded px-2 py-1.5 text-left text-text hover:bg-line"
            onClick={() => { void closeEditorTab(contextMenu.tabId); setContextMenu(null); }}
          >
            탭 닫기
          </button>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
