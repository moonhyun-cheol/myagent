import {
  ArrowSquareOut,
  ArrowsClockwise,
  CaretRight,
  FileCode,
  FileText,
  Folder,
  MagnifyingGlass,
  X,
} from '@phosphor-icons/react';
import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { openWorkspacePathInExplorer, readWorkspaceFsFile } from '../api/myAgentClient';
import { openWorkspaceFileWithConfiguredApp } from '../lib/applicationAssociations';
import { isAllowedDocumentPath } from '../lib/documentFile';
import type { FileNode } from '../types';
import { useWorkspaceStore } from '../store/workspaceStore';
import { ContextMenuPortal, useContextMenu, type ContextMenuItem } from './ContextMenu';

function filterFileNodes(nodes: FileNode[], query: string): FileNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
  const out: FileNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'folder') {
      const children = filterFileNodes(node.children ?? [], q);
      if (children.length > 0 || node.name.toLowerCase().includes(q)) {
        out.push({ ...node, children });
      }
    } else if (node.name.toLowerCase().includes(q) || node.id.toLowerCase().includes(q)) {
      out.push(node);
    }
  }
  return out;
}

function TreeItem({ node, depth = 0, forceExpand = false }: { node: FileNode; depth?: number; forceExpand?: boolean }) {
  const openFile = useWorkspaceStore((s) => s.openFile);
  const activeFileId = useWorkspaceStore((s) => s.activeFileId);
  const addContextPath = useWorkspaceStore((s) => s.addContextPath);
  const appendToDocument = useWorkspaceStore((s) => s.appendToDocument);
  const openDocumentPath = useWorkspaceStore((s) => s.openDocumentPath);
  const { menu, openAt, close } = useContextMenu();
  const [open, setOpen] = useState(depth < 2);
  const [openState, setOpenState] = useState<'idle' | 'opening' | 'failed'>('idle');
  const [openError, setOpenError] = useState('');
  const isExpanded = forceExpand || open;

  const openInApp = () => {
    if (isAllowedDocumentPath(node.id)) {
      void openDocumentPath(node.id);
    } else {
      void openFile(node.id);
    }
  };

  const openAssociated = async () => {
    if (openState === 'opening') return;
    setOpenState('opening');
    setOpenError('');
    try {
      await openWorkspaceFileWithConfiguredApp(node.id);
      setOpenState('idle');
    } catch (error) {
      const message = error instanceof Error ? error.message : '연결 프로그램을 실행하지 못했습니다.';
      console.error('파일 연결 프로그램 실행 실패', error);
      setOpenError(message);
      setOpenState('failed');
      window.setTimeout(() => {
        setOpenState('idle');
        setOpenError('');
      }, 5_000);
    }
  };

  const openCtx = (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const items: ContextMenuItem[] = [
      {
        id: 'at-ctx',
        label: '@ 컨텍스트에 추가',
        onSelect: () => addContextPath(node.id),
      },
      {
        id: 'open-explorer',
        label: 'OS 탐색기에서 열기',
        onSelect: () => void openWorkspacePathInExplorer(node.id),
      },
    ];
    if (node.kind !== 'folder') {
      if (isAllowedDocumentPath(node.id)) {
        items.unshift({
          id: 'open-document',
          label: '문서에서 열기',
          onSelect: () => void openDocumentPath(node.id),
        });
        items.unshift({
          id: 'append-to-document',
          label: '문서에 추가',
          onSelect: () => {
            void (async () => {
              try {
                const { content } = await readWorkspaceFsFile(node.id);
                appendToDocument(`## ${node.id}\n\n\`\`\`\n${content}\n\`\`\`\n`);
                addContextPath(node.id);
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                const state = useWorkspaceStore.getState();
                const active = state.documentTabs.find((tab) => tab.id === state.activeDocumentTabId);
                useWorkspaceStore.setState({
                  documentTabs: active
                    ? state.documentTabs.map((tab) => tab.id === active.id ? { ...tab, status: message } : tab)
                    : state.documentTabs,
                  mode: 'document',
                });
              }
            })();
          },
        });
      }
      items.unshift({
        id: 'open-associated',
        label: '연결 프로그램으로 열기',
        onSelect: () => void openAssociated(),
      });
      items.unshift({
        id: 'open',
        label: '앱 내부 에디터에서 열기',
        onSelect: () => void openFile(node.id),
      });
    }
    openAt(e, items);
  };

  if (node.kind === 'folder') {
    return (
      <div>
        <button
          type="button"
          className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] text-muted hover:bg-panel-2 hover:text-text"
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => setOpen((v) => !v)}
          onContextMenu={openCtx}
        >
          <CaretRight
            size={12}
            className={`shrink-0 transition ${isExpanded ? 'rotate-90' : ''}`}
            weight="bold"
          />
          <Folder size={15} weight="duotone" className="text-accent/80" />
          <span className="truncate">{node.name}</span>
        </button>
        {menu ? <ContextMenuPortal menu={menu} onClose={close} /> : null}
        {isExpanded
          ? node.children?.map((child) => <TreeItem key={child.id} node={child} depth={depth + 1} forceExpand={forceExpand} />)
          : null}
      </div>
    );
  }

  const Icon = node.language === 'markdown' ? FileText : FileCode;
  const active = activeFileId === node.id || activeFileId === `file:${node.id}`;
  const docAvailable = isAllowedDocumentPath(node.id);

  return (
    <>
      <div
        className={`flex min-w-0 items-center gap-2 border-b border-line/50 px-3 py-1.5 last:border-b-0 ${
          active ? 'bg-accent/10' : 'hover:bg-ink'
        }`}
        style={{ paddingLeft: 12 + depth * 12 }}
        ref={active ? (element) => element?.scrollIntoView({ block: 'nearest' }) : undefined}
        onContextMenu={openCtx}
      >
        <button
          type="button"
          className={`flex min-w-0 flex-1 items-center gap-2 text-left text-xs ${active ? 'text-accent' : 'text-text'}`}
          title={`${node.id} · 클릭하여 ${docAvailable ? '문서 탭에서 열기' : '앱 내 코드 뷰어에서 열기'}`}
          onClick={openInApp}
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-ink">
            <Icon size={15} weight="duotone" className="text-accent" />
          </span>
          <span className="truncate font-medium">{node.name}</span>
        </button>
        <div className="flex shrink-0 gap-1">
          {docAvailable ? (
            <button
              type="button"
              title="문서 탭에서 열기"
              className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[10px] text-muted hover:border-accent/60 hover:text-text"
              onClick={() => void openDocumentPath(node.id)}
            >
              <FileText size={12} />
              문서
            </button>
          ) : (
            <button
              type="button"
              title="앱 내부 뷰어에서 열기"
              className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[10px] text-muted hover:border-accent/60 hover:text-text"
              onClick={() => void openFile(node.id)}
            >
              <FileCode size={12} />
              보기
            </button>
          )}
          <button
            type="button"
            disabled={openState === 'opening'}
            title={openState === 'failed' ? openError || '파일 열기에 실패했습니다. 연결 프로그램 설정을 확인하세요.' : 'Windows 연결 프로그램으로 열기'}
            className="inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[10px] text-muted hover:border-accent/60 hover:text-text disabled:cursor-wait disabled:opacity-60"
            onClick={() => void openAssociated()}
          >
            <ArrowSquareOut size={12} />
            {openState === 'opening' ? '여는 중' : openState === 'failed' ? '실패' : '외부'}
          </button>
        </div>
      </div>
      {menu ? <ContextMenuPortal menu={menu} onClose={close} /> : null}
    </>
  );
}

export function AssetExplorer() {
  const files = useWorkspaceStore((s) => s.files);
  const filesMessage = useWorkspaceStore((s) => s.filesMessage);
  const refreshExplorer = useWorkspaceStore((s) => s.refreshExplorer);
  const [filterQuery, setFilterQuery] = useState('');

  useEffect(() => {
    void refreshExplorer();
  }, [refreshExplorer]);

  const filteredFiles = useMemo(() => filterFileNodes(files, filterQuery), [files, filterQuery]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-2.5 py-1.5">
        <label className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-line bg-ink px-2 py-1 focus-within:border-accent">
          <MagnifyingGlass size={13} className="shrink-0 text-muted" />
          <input
            type="text"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            placeholder="파일 또는 경로 검색…"
            aria-label="작업 폴더 파일 검색"
            className="min-w-0 flex-1 bg-transparent text-[11px] text-text outline-none placeholder:text-muted"
          />
          {filterQuery ? (
            <button
              type="button"
              onClick={() => setFilterQuery('')}
              aria-label="검색어 지우기"
              className="text-muted hover:text-text"
            >
              <X size={12} />
            </button>
          ) : null}
        </label>
        <button
          type="button"
          className="shrink-0 rounded-md border border-line p-1.5 text-muted hover:bg-ink hover:text-text"
          title="파일 목록 새로고침"
          aria-label="파일 목록 새로고침"
          onClick={() => void refreshExplorer()}
        >
          <ArrowsClockwise size={13} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {filesMessage ? (
          <p className="px-3 py-4 text-center text-[11px] text-muted">{filesMessage}</p>
        ) : null}
        {!filesMessage && filteredFiles.length === 0 && filterQuery.trim() ? (
          <p className="px-3 py-6 text-center text-[11px] text-muted">일치하는 파일이 없습니다.</p>
        ) : null}
        {filteredFiles.map((n) => (
          <TreeItem key={n.id} node={n} forceExpand={Boolean(filterQuery.trim())} />
        ))}
      </div>
    </div>
  );
}
