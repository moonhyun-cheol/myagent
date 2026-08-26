import Editor from '@monaco-editor/react';
import { useEffect, useState } from 'react';
import type { FileNode } from '../types';
import { ASSET_MIME, useWorkspaceStore } from '../store/workspaceStore';

const FILES_PANEL_OPEN_KEY = 'my-agent-workspace-files-panel-open';
const LEGACY_FILES_PANEL_OPEN_KEY = 'cqr-workspace-files-panel-open';

function readFilesPanelOpenPref(): boolean {
  try {
    const current = localStorage.getItem(FILES_PANEL_OPEN_KEY);
    const legacy = current === null ? localStorage.getItem(LEGACY_FILES_PANEL_OPEN_KEY) : null;
    if (legacy !== null) localStorage.setItem(FILES_PANEL_OPEN_KEY, legacy);
    return (current ?? legacy) !== '0';
  } catch {
    return true;
  }
}

interface EditorContextMenuState {
  x: number;
  y: number;
  path?: string;
  tabId?: string;
  renameValue?: string;
}

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function tabLabel(tab: { id: string; title: string }): string {
  if (tab.id.startsWith('file:')) return fileNameFromPath(tab.id.slice('file:'.length));
  return tab.title === 'Generated code' ? 'code.ts' : tab.title;
}

function WorkspaceTreeItem({
  node,
  depth = 0,
  onOpenFile,
  onContextMenu,
}: {
  node: FileNode;
  depth?: number;
  onOpenFile: (path: string) => void;
  onContextMenu: (event: React.MouseEvent, path: string) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const isFolder = node.kind === 'folder';

  return (
    <li>
      <button
        type="button"
        onClick={() => (isFolder ? setExpanded((value) => !value) : onOpenFile(node.id))}
        onContextMenu={(event) => {
          if (!isFolder) onContextMenu(event, node.id);
        }}
        className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[11px] transition-colors ${
          isFolder ? 'text-muted hover:bg-panel hover:text-text' : 'text-text/90 hover:bg-panel'
        }`}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
        title={node.id}
      >
        <span className="w-3 shrink-0 text-center text-muted" aria-hidden="true">
          {isFolder ? (expanded ? '⌄' : '›') : '·'}
        </span>
        <span className="truncate">{node.name}</span>
      </button>
      {isFolder && expanded && node.children?.length ? (
        <ul>
          {node.children.map((child) => (
            <WorkspaceTreeItem
              key={child.id}
              node={child}
              depth={depth + 1}
              onOpenFile={onOpenFile}
              onContextMenu={onContextMenu}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function EditorPane() {
  const files = useWorkspaceStore((s) => s.files);
  const filesRoot = useWorkspaceStore((s) => s.filesRoot);
  const filesMessage = useWorkspaceStore((s) => s.filesMessage);
  const openTabs = useWorkspaceStore((s) => s.openTabs);
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);
  const activeFileId = useWorkspaceStore((s) => s.activeFileId);
  const activeTab = openTabs.find((tab) => tab.id === activeTabId) ?? null;
  const refreshExplorer = useWorkspaceStore((s) => s.refreshExplorer);
  const openFile = useWorkspaceStore((s) => s.openFile);
  const setEditorContent = useWorkspaceStore((s) => s.setEditorContent);
  const saveActiveFile = useWorkspaceStore((s) => s.saveActiveFile);
  const renameWorkspaceFile = useWorkspaceStore((s) => s.renameWorkspaceFile);
  const setActiveTab = useWorkspaceStore((s) => s.setActiveTab);
  const closeEditorTab = useWorkspaceStore((s) => s.closeEditorTab);
  const openAssetInEditor = useWorkspaceStore((s) => s.openAssetInEditor);
  const editorSaveStatus = useWorkspaceStore((s) => s.editorSaveStatus);
  const editorSaving = useWorkspaceStore((s) => s.editorSaving);
  const [filesPanelOpen, setFilesPanelOpen] = useState(readFilesPanelOpenPref);
  const [contextMenu, setContextMenu] = useState<EditorContextMenuState | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(FILES_PANEL_OPEN_KEY, filesPanelOpen ? '1' : '0');
    } catch {
      // Ignore storage restrictions; the toggle still works for this render.
    }
  }, [filesPanelOpen]);

  useEffect(() => {
    void refreshExplorer();
  }, [refreshExplorer]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveActiveFile();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [saveActiveFile]);

  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu();
    };
    window.addEventListener('click', closeMenu);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('click', closeMenu);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const openContextMenu = (event: React.MouseEvent, state: Omit<EditorContextMenuState, 'x' | 'y'>) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, ...state });
  };

  const copyContextPath = async () => {
    if (!contextMenu?.path) return;
    try {
      await navigator.clipboard.writeText(contextMenu.path);
      setContextMenu(null);
    } catch {
      setContextMenu(null);
    }
  };

  const closeContextTab = () => {
    if (contextMenu?.tabId) void closeEditorTab(contextMenu.tabId);
    setContextMenu(null);
  };

  const startRename = () => {
    if (!contextMenu?.path) return;
    setContextMenu((menu) =>
      menu ? { ...menu, renameValue: fileNameFromPath(menu.path ?? '') } : null,
    );
  };

  const submitRename = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!contextMenu?.path || contextMenu.renameValue === undefined) return;
    try {
      await renameWorkspaceFile(contextMenu.path, contextMenu.renameValue);
      setContextMenu(null);
    } catch {
      // Store status keeps the API error visible while leaving the menu open for correction.
    }
  };

  const editorLabel = activeFileId ?? activeTab?.title ?? '새 버퍼';

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-ink"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(ASSET_MIME)) e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        const assetId = e.dataTransfer.getData(ASSET_MIME);
        if (assetId) openAssetInEditor(assetId);
      }}
    >
      <div className="flex min-h-0 flex-1">
        {filesPanelOpen ? (
          <aside className="flex w-44 shrink-0 flex-col border-r border-line bg-panel/40">
            <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">Files</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void refreshExplorer()}
                  className="text-[10px] text-muted hover:text-accent"
                  title="파일 트리 새로고침"
                >
                  새로고침
                </button>
                <button
                  type="button"
                  onClick={() => setFilesPanelOpen(false)}
                  className="rounded px-1 text-[13px] leading-none text-muted hover:bg-line hover:text-text"
                  title="파일 트리 숨기기"
                  aria-label="파일 트리 숨기기"
                >
                  ‹
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto py-1.5">
              {filesRoot ? <p className="truncate px-3 pb-1 text-[10px] text-muted/80" title={filesRoot}>{filesRoot}</p> : null}
              {files.length ? (
                <ul>
                  {files.map((node) => (
                    <WorkspaceTreeItem
                      key={node.id}
                      node={node}
                      onOpenFile={(path) => void openFile(path)}
                      onContextMenu={(event, path) => openContextMenu(event, { path })}
                    />
                  ))}
                </ul>
              ) : (
                <p className="px-3 py-2 text-[11px] leading-5 text-muted">
                  {filesRoot ? filesMessage || '파일 없음' : '폴더를 연결하세요'}
                </p>
              )}
            </div>
          </aside>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-2 text-xs text-muted">
            {!filesPanelOpen ? (
              <button
                type="button"
                onClick={() => setFilesPanelOpen(true)}
                className="shrink-0 rounded border border-line px-2 py-1 text-[11px] text-muted hover:border-accent hover:text-accent"
                title="파일 트리 표시"
                aria-label="파일 트리 표시"
              >
                파일 ›
              </button>
            ) : null}
            <div className="-my-2 flex min-w-0 flex-1 overflow-x-auto" role="tablist" aria-label="열린 편집기 탭">
              {openTabs.map((tab) => {
                const selected = tab.id === activeTab?.id;
                return (
                  <div
                    key={tab.id}
                    role="tab"
                    aria-selected={selected}
                    onContextMenu={(event) =>
                      openContextMenu(event, {
                        tabId: tab.id,
                        path: tab.id.startsWith('file:') ? tab.id.slice('file:'.length) : undefined,
                      })
                    }
                    className={`group flex shrink-0 items-center gap-1 border-b-2 px-2.5 py-2 ${
                      selected
                        ? 'border-accent bg-panel text-text'
                        : 'border-transparent text-muted hover:bg-panel/70 hover:text-text'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setActiveTab(tab.id)}
                      className="max-w-40 truncate text-left"
                      title={tab.id.startsWith('file:') ? tab.id.slice('file:'.length) : tab.title}
                    >
                      {tabLabel(tab)}{tab.dirty ? <span className="ml-1 text-accent" aria-label="저장되지 않은 변경">●</span> : null}
                    </button>
                    <button
                      type="button"
                      onClick={() => void closeEditorTab(tab.id)}
                      aria-label={`${tab.title} 탭 닫기`}
                      className="rounded px-0.5 text-muted opacity-70 hover:bg-line hover:text-text group-hover:opacity-100"
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {editorSaveStatus ? <span className="max-w-52 truncate text-[11px] text-muted" role="status">{editorSaveStatus}</span> : null}
              <button
                type="button"
                onClick={() => void saveActiveFile()}
                disabled={editorSaving}
                className="rounded border border-line px-2 py-1 text-[11px] text-text hover:border-accent hover:text-accent disabled:cursor-wait disabled:opacity-60"
                title="현재 작업 폴더 파일 저장 (Ctrl+S)"
              >
                {editorSaving ? '저장 중…' : '저장'}
              </button>
              <span className="max-w-56 truncate text-[11px] text-accent/80" title={editorLabel}>{editorLabel}</span>
            </div>
          </div>
          <div className="min-h-0 flex-1">
            <Editor
              height="100%"
              theme="vs"
              path={activeTab?.id}
              language={activeTab?.language ?? 'plaintext'}
              value={activeTab?.content ?? ''}
              onChange={(v) => setEditorContent(v ?? '')}
              options={{
                fontFamily: 'IBM Plex Mono, monospace',
                fontSize: 13,
                minimap: { enabled: false },
                padding: { top: 16 },
                scrollBeyondLastLine: false,
                smoothScrolling: true,
                // Keep Monaco's built-in find widget (Ctrl/Cmd+F); do not customize scope.
                find: {
                  seedSearchStringFromSelection: 'always',
                  autoFindInSelection: 'never',
                },
              }}
            />
          </div>
        </div>
      </div>
      {contextMenu ? (
        <div
          className="fixed z-50 min-w-36 rounded border border-line bg-panel p-1 text-[11px] shadow-xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
          role="menu"
        >
          {contextMenu.path ? (
            <>
              <button
                type="button"
                className="block w-full rounded px-2 py-1.5 text-left text-text hover:bg-line"
                onClick={() => void copyContextPath()}
                role="menuitem"
              >
                경로 복사
              </button>
              <button
                type="button"
                className="block w-full rounded px-2 py-1.5 text-left text-text hover:bg-line"
                onClick={startRename}
                role="menuitem"
              >
                이름 수정
              </button>
              {contextMenu.renameValue !== undefined ? (
                <form className="mt-1 border-t border-line pt-1" onSubmit={(event) => void submitRename(event)}>
                  <label className="sr-only" htmlFor="workspace-rename-input">새 파일명</label>
                  <input
                    id="workspace-rename-input"
                    autoFocus
                    value={contextMenu.renameValue}
                    onChange={(event) =>
                      setContextMenu((menu) => menu ? { ...menu, renameValue: event.target.value } : null)
                    }
                    className="w-full rounded border border-line bg-ink px-2 py-1 text-text outline-none focus:border-accent"
                    onClick={(event) => event.stopPropagation()}
                  />
                  <button
                    type="submit"
                    className="mt-1 block w-full rounded px-2 py-1.5 text-left text-accent hover:bg-line"
                  >
                    이름 변경
                  </button>
                </form>
              ) : null}
            </>
          ) : null}
          {contextMenu.tabId ? (
            <button
              type="button"
              className="block w-full rounded px-2 py-1.5 text-left text-text hover:bg-line"
              onClick={closeContextTab}
              role="menuitem"
            >
              탭 닫기
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
