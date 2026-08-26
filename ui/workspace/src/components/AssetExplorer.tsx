import {
  ArrowSquareOut,
  ArrowsClockwise,
  CaretRight,
  FileCode,
  FileText,
  Folder,
  SquaresFour,
} from '@phosphor-icons/react';
import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { openWorkspacePathInExplorer } from '../api/myAgentClient';
import { openWorkspaceFileWithConfiguredApp } from '../lib/applicationAssociations';
import type { FileNode } from '../types';
import { useWorkspaceStore } from '../store/workspaceStore';
import { ContextMenuPortal, useContextMenu, type ContextMenuItem } from './ContextMenu';

function TreeItem({ node, depth = 0 }: { node: FileNode; depth?: number }) {
  const openFile = useWorkspaceStore((s) => s.openFile);
  const openFileOnCanvas = useWorkspaceStore((s) => s.openFileOnCanvas);
  const activeFileId = useWorkspaceStore((s) => s.activeFileId);
  const addContextPath = useWorkspaceStore((s) => s.addContextPath);
  const { menu, openAt, close } = useContextMenu();
  const [open, setOpen] = useState(depth < 2);
  const [openState, setOpenState] = useState<'idle' | 'opening' | 'failed'>('idle');
  const [openError, setOpenError] = useState('');

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
      if (/\.(mmd|mermaid)$/i.test(node.name)) {
        items.unshift({
          id: 'open-canvas',
          label: '워크플로 캔버스에서 열기',
          onSelect: () => void openFileOnCanvas(node.id),
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
          className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[13px] text-muted hover:bg-panel-2 hover:text-text"
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => setOpen((v) => !v)}
          onContextMenu={openCtx}
        >
          <CaretRight
            size={12}
            className={`shrink-0 transition ${open ? 'rotate-90' : ''}`}
            weight="bold"
          />
          <Folder size={15} weight="duotone" className="text-accent/80" />
          <span className="truncate">{node.name}</span>
        </button>
        {menu ? <ContextMenuPortal menu={menu} onClose={close} /> : null}
        {open
          ? node.children?.map((child) => <TreeItem key={child.id} node={child} depth={depth + 1} />)
          : null}
      </div>
    );
  }

  const Icon = node.language === 'markdown' ? FileText : FileCode;
  const active = activeFileId === node.id || activeFileId === `file:${node.id}`;
  const canvasAvailable = /\.(mmd|mermaid)$/i.test(node.name);

  return (
    <>
      <div
        className={`flex min-w-0 items-center gap-2 border-b border-line/70 px-3 py-1.5 last:border-b-0 ${
          active ? 'bg-accent/10' : 'hover:bg-ink'
        }`}
        style={{ paddingLeft: 12 + depth * 12 }}
        ref={active ? (element) => element?.scrollIntoView({ block: 'nearest' }) : undefined}
        onContextMenu={openCtx}
      >
        <button
          type="button"
          className={`flex min-w-0 flex-1 items-center gap-2 text-left text-xs ${active ? 'text-accent' : 'text-text'}`}
          title={`${node.name} · ${openState === 'failed' ? openError || '열기 실패' : '연결 프로그램으로 열기'}`}
          onClick={() => void openAssociated()}
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-ink">
            <Icon size={16} weight="duotone" className="text-accent" />
          </span>
          <span className="truncate font-medium">{node.name}</span>
        </button>
        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            disabled={openState === 'opening'}
            title={openState === 'failed' ? openError || '파일 열기에 실패했습니다. 연결 프로그램 설정을 확인하세요.' : '연결 프로그램으로 열기'}
            className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[10px] text-muted hover:border-accent/60 hover:text-text disabled:cursor-wait disabled:opacity-60"
            onClick={() => void openAssociated()}
          >
            <ArrowSquareOut size={12} />
            {openState === 'opening' ? '여는 중' : openState === 'failed' ? '실패' : '열기'}
          </button>
          <button
            type="button"
            disabled={!canvasAvailable}
            title={canvasAvailable ? '캔버스에서 열기' : '이 파일 형식은 캔버스에서 열 수 없습니다'}
            className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[10px] text-muted hover:border-accent/60 hover:text-text disabled:cursor-not-allowed disabled:border-line/60 disabled:text-muted/40 disabled:hover:border-line/60 disabled:hover:text-muted/40"
            onClick={() => {
              if (canvasAvailable) void openFileOnCanvas(node.id);
            }}
          >
            <SquaresFour size={12} />
            캔버스
          </button>
        </div>
      </div>
      {menu ? <ContextMenuPortal menu={menu} onClose={close} /> : null}
    </>
  );
}

export function AssetExplorer() {
  const files = useWorkspaceStore((s) => s.files);
  const filesRoot = useWorkspaceStore((s) => s.filesRoot);
  const filesMessage = useWorkspaceStore((s) => s.filesMessage);
  const refreshExplorer = useWorkspaceStore((s) => s.refreshExplorer);

  useEffect(() => {
    void refreshExplorer();
  }, [refreshExplorer]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex shrink-0 items-center justify-between border-b border-line px-3 py-2">
        <p className="min-w-0 truncate text-[10px] text-muted" title={filesRoot ?? undefined}>
          {filesRoot ?? '연결된 작업 폴더가 없습니다'}
        </p>
        <button
          type="button"
          className="ml-2 shrink-0 rounded-md p-1.5 text-muted hover:bg-ink hover:text-text"
          title="새로고침"
          onClick={() => void refreshExplorer()}
        >
          <ArrowsClockwise size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {filesMessage ? (
          <p className="px-3 py-4 text-center text-[11px] text-muted">{filesMessage}</p>
        ) : null}
        {files.map((n) => (
          <TreeItem key={n.id} node={n} />
        ))}
      </div>
    </div>
  );
}
