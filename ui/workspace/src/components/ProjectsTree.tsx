import {
  Archive,
  Brain,
  CaretDown,
  CaretRight,
  ChatTeardropText,
  DotsThree,
  FolderPlus,
  FolderSimple,
  PencilSimple,
  Plus,
  PushPin,
  Trash,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import {
  createProject,
  deleteProject,
  deleteSession,
  fetchWorkspaceTree,
  getPinnedSessionIds,
  getStoredSessionId,
  setDevWorkspace,
  setPinnedSessionIds,
  updateProject,
  type ProjectColor,
  type SessionSummary,
  type WorkspaceNode,
  type WorkspaceTreePayload,
} from '../api/myAgentClient';
import { useWorkspaceStore } from '../store/workspaceStore';
import { confirmDialog, promptDialog } from '../lib/confirmDialog';
import { FolderBrowserModal } from './FolderBrowserModal';
import { openUserMemoryPanel, UserMemoryPanelHost } from './UserMemoryPanel';

const COLLAPSED_KEY = 'my-agent-workspace-collapsed-nodes';
const LEGACY_COLLAPSED_KEY = 'cqr-workspace-collapsed-nodes';
const PINNED_NODES_KEY = 'my-agent-workspace-pinned-nodes';
const PROJECT_COLORS: ProjectColor[] = ['gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'pink'];
const PROJECT_COLOR_HEX: Record<ProjectColor, string> = {
  gray: '#94a3b8', red: '#f87171', orange: '#fb923c', yellow: '#facc15',
  green: '#4ade80', teal: '#2dd4bf', blue: '#60a5fa', pink: '#f472b6',
};
const SIDEBAR_MENU_OPEN_EVENT = 'cqr:sidebar-menu-open';

function useExclusiveSidebarMenu(menuId: string) {
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const closeForOtherMenu = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== menuId) setMenuOpen(false);
    };
    const closeFromOutside = (event: PointerEvent) => {
      const owner = event.target instanceof Element
        ? event.target.closest('[data-sidebar-menu-id]')?.getAttribute('data-sidebar-menu-id')
        : null;
      if (owner !== menuId) setMenuOpen(false);
    };

    window.addEventListener(SIDEBAR_MENU_OPEN_EVENT, closeForOtherMenu);
    document.addEventListener('pointerdown', closeFromOutside);
    return () => {
      window.removeEventListener(SIDEBAR_MENU_OPEN_EVENT, closeForOtherMenu);
      document.removeEventListener('pointerdown', closeFromOutside);
    };
  }, [menuId]);

  const openMenu = () => {
    window.dispatchEvent(new CustomEvent<string>(SIDEBAR_MENU_OPEN_EVENT, { detail: menuId }));
    setMenuOpen(true);
  };
  const toggleMenu = () => {
    if (menuOpen) setMenuOpen(false);
    else openMenu();
  };

  return { menuOpen, setMenuOpen, openMenu, toggleMenu };
}

function loadCollapsed(): Set<string> {
  try {
    const current = localStorage.getItem(COLLAPSED_KEY);
    const legacy = current === null ? localStorage.getItem(LEGACY_COLLAPSED_KEY) : null;
    if (legacy !== null) localStorage.setItem(COLLAPSED_KEY, legacy);
    const raw = JSON.parse(current ?? legacy ?? '[]');
    return new Set(Array.isArray(raw) ? raw.map(String) : []);
  } catch {
    return new Set();
  }
}

function saveCollapsed(ids: Set<string>) {
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids]));
}

function loadPinnedNodes(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(PINNED_NODES_KEY) ?? '[]');
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

function pinnedFirst<T extends { id: string }>(items: T[], pinned: string[]): T[] {
  return [...items].sort((a, b) => Number(pinned.includes(b.id)) - Number(pinned.includes(a.id)));
}

interface ProjectsTreeProps {
  query?: string;
  onMessage?: (msg: string) => void;
  /** Render inside the default sidebar scroll instead of owning a full-height pane. */
  embedded?: boolean;
  /** Called after a folder/session click successfully opens the chat pane. */
  onChatOpened?: () => void;
}

function latestSession(sessions: SessionSummary[] | undefined): SessionSummary | null {
  if (!sessions?.length) return null;
  return [...sessions].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0] ?? null;
}

export function ProjectsTree({ query = '', onMessage, embedded = false, onChatOpened }: ProjectsTreeProps) {
  const [tree, setTree] = useState<WorkspaceTreePayload | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed());
  const [pinned, setPinned] = useState<string[]>(() => getPinnedSessionIds());
  const [pinnedNodes, setPinnedNodes] = useState<string[]>(loadPinnedNodes);
  const [browseOpen, setBrowseOpen] = useState(false);

  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const startNewChat = useWorkspaceStore((s) => s.startNewChat);
  const clearActiveChat = useWorkspaceStore((s) => s.clearActiveChat);
  const loadChatSession = useWorkspaceStore((s) => s.loadChatSession);

  const refresh = useCallback(async () => {
    try {
      setTree(await fetchWorkspaceTree());
    } catch (err) {
      onMessage?.(err instanceof Error ? err.message : '워크스페이스 로드 실패');
    }
  }, [onMessage]);

  useEffect(() => {
    void refresh();
  }, [refresh, activeSessionId]);

  useEffect(() => {
    const onTreeChanged = () => void refresh();
    window.addEventListener('cqr:workspace-tree-changed', onTreeChanged);
    return () => window.removeEventListener('cqr:workspace-tree-changed', onTreeChanged);
  }, [refresh]);

  const togglePin = (id: string) => {
    const next = pinned.includes(id) ? pinned.filter((item) => item !== id) : [id, ...pinned];
    setPinned(next);
    setPinnedSessionIds(next);
  };

  const toggleNodePin = (id: string) => {
    setPinnedNodes((current) => {
      const next = current.includes(id) ? current.filter((item) => item !== id) : [id, ...current];
      localStorage.setItem(PINNED_NODES_KEY, JSON.stringify(next));
      return next;
    });
  };

  const changeNodeColor = async (id: string, color: ProjectColor) => {
    try {
      await updateProject(id, { color });
      await refresh();
    } catch (err) {
      onMessage?.(err instanceof Error ? err.message : '컬러 라벨 변경 실패');
    }
  };

  const toggle = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveCollapsed(next);
      return next;
    });
  };

  const onNewProject = async () => {
    const title = await promptDialog({
      title: '새 프로젝트',
      message: '이름 입력',
      defaultValue: '새 프로젝트',
      placeholder: '프로젝트 이름',
      confirmLabel: '만들기',
    });
    if (title === null) return;
    try {
      const p = await createProject({ title: title.trim() || '새 프로젝트', kind: 'project' });
      await refresh();
      await startNewChat(p.id);
      onChatOpened?.();
      onMessage?.('프로젝트 생성');
    } catch (err) {
      onMessage?.(err instanceof Error ? err.message : '생성 실패');
    }
  };

  const onRenameNode = async (node: WorkspaceNode) => {
    const title = await promptDialog({
      title: '이름 변경',
      message: '새 이름을 입력하세요.',
      defaultValue: node.title,
      placeholder: '이름',
      confirmLabel: '변경',
    });
    if (title === null || !title.trim() || title.trim() === node.title) return;
    try {
      await updateProject(node.id, { title: title.trim() });
      await refresh();
    } catch (err) {
      onMessage?.(err instanceof Error ? err.message : '이름 변경 실패');
    }
  };

  const onAddFolder = async (parentId: string) => {
    const title = await promptDialog({
      title: '새 폴더',
      message: '이름 입력',
      defaultValue: '새 폴더',
      placeholder: '폴더 이름',
      confirmLabel: '만들기',
    });
    if (title === null) return;
    try {
      const folder = await createProject({
        title: title.trim() || '새 폴더',
        kind: 'folder',
        parent_id: parentId,
      });
      setCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(parentId);
        next.delete(folder.id);
        saveCollapsed(next);
        return next;
      });
      await refresh();
      await startNewChat(folder.id);
      onChatOpened?.();
      onMessage?.('폴더를 만들고 해당 위치 채팅을 열었습니다.');
    } catch (err) {
      onMessage?.(err instanceof Error ? err.message : '폴더 생성 실패');
    }
  };

  const onNewChatIn = async (projectId: string | null) => {
    try {
      await startNewChat(projectId);
      await refresh();
      onChatOpened?.();
    } catch (err) {
      onMessage?.(err instanceof Error ? err.message : '새 채팅 실패');
    }
  };

  const openSession = async (id: string, _projectId: string | null) => {
    try {
      await loadChatSession(id);
      onChatOpened?.();
    } catch (err) {
      onMessage?.(err instanceof Error ? err.message : '세션 로드 실패');
    }
  };

  const openNodeChat = async (node: WorkspaceNode) => {
    const latest = latestSession(node.sessions);
    if (latest) {
      await openSession(latest.id, latest.project_id ?? node.id);
      return;
    }
    await onNewChatIn(node.id);
  };

  const activateWorkspaceRoot = async (node: WorkspaceNode) => {
    const folderPath = node.folder_path?.trim();
    if (!folderPath) return;
    if (tree?.active_workspace_project_id === node.id) return;
    try {
      await setDevWorkspace(folderPath);
      await refresh();
    } catch (err) {
      onMessage?.(err instanceof Error ? err.message : '작업 폴더 활성화 실패');
    }
  };

  const onSelectSession = async (id: string, projectId: string | null = null) => {
    await openSession(id, projectId);
  };

  const onDeleteSession = async (id: string) => {
    const ok = await confirmDialog({
      title: '대화 삭제',
      message: '이 대화를 삭제할까요?',
      danger: true,
      confirmLabel: '삭제',
    });
    if (!ok) return;
    try {
      await deleteSession(id);
      if (activeSessionId === id || getStoredSessionId() === id) {
        clearActiveChat();
      }
      await refresh();
    } catch (err) {
      onMessage?.(err instanceof Error ? err.message : '삭제 실패');
    }
  };

  const onDeleteNode = async (node: WorkspaceNode) => {
    const label =
      node.kind === 'workspace_root'
        ? '작업 폴더'
        : node.kind === 'folder'
          ? '폴더'
          : '프로젝트';
    const ok = await confirmDialog({
      title: `${label} 삭제`,
      message: `${label} "${node.title}"을(를) 삭제할까요?`,
      danger: true,
      confirmLabel: '삭제',
    });
    if (!ok) return;
    try {
      await deleteProject(node.id, node.kind === 'workspace_root');
      await refresh();
    } catch (err) {
      onMessage?.(err instanceof Error ? err.message : '삭제 실패');
    }
  };

  const onPickWorkspace = async (folderPath: string) => {
    setBrowseOpen(false);
    try {
      const result = await setDevWorkspace(folderPath);
      await refresh();
      const projectId = result.active_workspace_project_id ?? null;
      if (projectId) {
        await startNewChat(projectId);
        onChatOpened?.();
        onMessage?.(`작업 폴더 연결 · 프로젝트 채팅 시작: ${folderPath}`);
      } else {
        onMessage?.(`작업 폴더 연결: ${folderPath}`);
      }
    } catch (err) {
      onMessage?.(err instanceof Error ? err.message : '작업 폴더 연결 실패');
    }
  };

  /** Folder title opens that location's chat first; workspace switch is best-effort after. */
  const onActivateWorkspace = async (node: WorkspaceNode) => {
    const folderPath = node.folder_path?.trim();
    if (!folderPath) {
      onMessage?.('폴더 경로 없음');
      return;
    }
    try {
      await openNodeChat(node);
      await activateWorkspaceRoot(node);
    } catch (err) {
      onMessage?.(err instanceof Error ? err.message : '작업 폴더 활성화 실패');
    }
  };

  const onSelectSessionUnderWorkspace = async (
    session: SessionSummary,
    root: WorkspaceNode,
  ) => {
    try {
      await openSession(session.id, session.project_id ?? root.id);
      if (root.kind === 'workspace_root') await activateWorkspaceRoot(root);
    } catch (err) {
      onMessage?.(err instanceof Error ? err.message : '세션 로드 실패');
    }
  };

  const q = query.trim().toLowerCase();
  const matchSession = (s: SessionSummary) =>
    !q || (s.title || s.id).toLowerCase().includes(q);
  const matchNode = (n: WorkspaceNode): boolean => {
    if (!q) return true;
    if (n.title.toLowerCase().includes(q)) return true;
    if ((n.sessions ?? []).some(matchSession)) return true;
    return (n.children ?? []).some(matchNode);
  };

  // 작업 폴더와 독립 프로젝트는 화면에서 하나의 최상위 목록이다.
  // 종류별로 따로 정렬하면 프로젝트를 고정해도 작업 폴더 아래에 남으므로,
  // 원래 서버 순서를 보존한 채 통합한 다음 고정 항목만 앞으로 이동한다.
  const topLevelNodes = pinnedFirst([
    ...(tree?.workspace_trees ?? [])
      .filter(matchNode)
      .map((node) => ({ id: node.id, kind: 'workspace' as const, node })),
    ...(tree?.projects ?? [])
      .filter((project) => !q || project.title.toLowerCase().includes(q) || project.sessions.some(matchSession))
      .map((project) => ({ id: project.id, kind: 'project' as const, project })),
  ], pinnedNodes);

  return (
    <div className={embedded ? "border-t border-line" : "flex h-full min-h-0 flex-col"}>
      <div className="group flex h-9 shrink-0 items-center border-b border-line px-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">워크스페이스</p>
        <div className="ml-auto flex items-center opacity-70 transition group-hover:opacity-100">
          <button
            type="button"
            onClick={() => setBrowseOpen(true)}
            className="rounded-md p-1 text-muted hover:bg-ink hover:text-text"
            title="작업 폴더 연결"
            aria-label="작업 폴더 연결"
          >
            <FolderPlus size={14} />
          </button>
          <button
            type="button"
            onClick={() => void onNewProject()}
            className="rounded-md p-1 text-muted hover:bg-ink hover:text-text"
            title="새 프로젝트"
            aria-label="새 프로젝트"
          >
            <Plus size={14} weight="bold" />
          </button>
        </div>
      </div>

      <div className={embedded ? "flex flex-col px-2 py-1.5" : "flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-1.5"}>
        {(tree?.standalone_sessions ?? []).filter(matchSession).length > 0 ? (
          <div className="mb-1">
            <div className="flex h-8 items-center gap-1 rounded-md px-1 text-[12px] text-muted">
              <FolderSimple size={16} weight="fill" style={{ color: PROJECT_COLOR_HEX.gray }} />
              <span className="font-medium">개인 작업</span>
            </div>
            <div className="ml-[11px] border-l border-line/70 pl-1">
              {[...(tree?.standalone_sessions ?? [])]
                .filter(matchSession)
                .sort((a, b) => Number(pinned.includes(b.id)) - Number(pinned.includes(a.id)))
                .map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  active={session.id === activeSessionId}
                  indent={20}
                  pinned={pinned.includes(session.id)}
                  onTogglePin={() => togglePin(session.id)}
                  onSelect={() => void onSelectSession(session.id)}
                  onDelete={() => void onDeleteSession(session.id)}
                />
              ))}
            </div>
          </div>
        ) : null}
        {topLevelNodes.map((entry) => {
          if (entry.kind === 'workspace') {
            const root = entry.node;
            return (
              <TreeNode
                key={root.id}
                node={root}
                workspaceRoot={root}
                depth={0}
                collapsed={collapsed}
                pinnedNodes={pinnedNodes}
                activeSessionId={activeSessionId}
                activeWorkspaceId={tree?.active_workspace_project_id ?? null}
                matchSession={matchSession}
                matchNode={matchNode}
                onToggle={toggle}
                onActivateWorkspace={(n) => void onActivateWorkspace(n)}
                onOpenNodeChat={(n) => void openNodeChat(n)}
                onSelectSession={(s, wsRoot) => void onSelectSessionUnderWorkspace(s, wsRoot)}
                onDeleteSession={(id) => void onDeleteSession(id)}
                onNewChat={(id) => void onNewChatIn(id)}
                onAddFolder={(id) => void onAddFolder(id)}
                onRenameNode={(n) => void onRenameNode(n)}
                onDeleteNode={(n) => void onDeleteNode(n)}
                onTogglePin={toggleNodePin}
                onChangeColor={(id, color) => void changeNodeColor(id, color)}
              />
            );
          }

          const p = entry.project;
          return (
                <ProjectBlock
                  key={p.id}
                  id={p.id}
                  title={p.title}
                  color={p.color ?? 'gray'}
                  pinned={pinnedNodes.includes(p.id)}
                  sessions={p.sessions}
                  collapsed={collapsed.has(p.id)}
                  activeSessionId={activeSessionId}
                  matchSession={matchSession}
                  onToggle={() => toggle(p.id)}
                  onOpenChat={() =>
                    void openNodeChat({
                      id: p.id,
                      title: p.title,
                      kind: 'project',
                      sessions: p.sessions,
                      children: [],
                      session_count: p.sessions.length,
                    })
                  }
                  onSelectSession={(id) => void onSelectSession(id, p.id)}
                  onDeleteSession={(id) => void onDeleteSession(id)}
                  onNewChat={() => void onNewChatIn(p.id)}
                  onRename={() => void onRenameNode({
                    id: p.id,
                    title: p.title,
                    kind: 'project',
                    color: p.color,
                    sessions: p.sessions,
                    children: [],
                    session_count: p.sessions.length,
                  })}
                  onTogglePin={() => toggleNodePin(p.id)}
                  onChangeColor={(color) => void changeNodeColor(p.id, color)}
                  onDelete={() =>
                    void deleteProject(p.id).then(refresh).catch((err) => {
                      onMessage?.(err instanceof Error ? err.message : '삭제 실패');
                    })
                  }
                />
          );
        })}

        {(tree?.workspace_trees?.length ?? 0) === 0 && (tree?.projects?.length ?? 0) === 0 ? (
          <p className="px-2 py-4 text-[11px] text-muted">
            작업 폴더나 프로젝트를 추가하면 여기에 표시됩니다.
          </p>
        ) : null}
      </div>

      <UserMemoryPanelHost />
      <FolderBrowserModal
        open={browseOpen}
        onClose={() => setBrowseOpen(false)}
        onSelect={(path) => void onPickWorkspace(path)}
      />
    </div>
  );
}

function TreeNode({
  node,
  workspaceRoot,
  depth,
  collapsed,
  pinnedNodes,
  activeSessionId,
  activeWorkspaceId,
  matchSession,
  matchNode,
  onToggle,
  onActivateWorkspace,
  onOpenNodeChat,
  onSelectSession,
  onDeleteSession,
  onNewChat,
  onAddFolder,
  onRenameNode,
  onDeleteNode,
  onTogglePin,
  onChangeColor,
}: {
  node: WorkspaceNode;
  workspaceRoot: WorkspaceNode;
  depth: number;
  collapsed: Set<string>;
  pinnedNodes: string[];
  activeSessionId: string | null;
  activeWorkspaceId: string | null;
  matchSession: (s: SessionSummary) => boolean;
  matchNode: (n: WorkspaceNode) => boolean;
  onToggle: (id: string) => void;
  onActivateWorkspace: (node: WorkspaceNode) => void;
  onOpenNodeChat: (node: WorkspaceNode) => void;
  onSelectSession: (session: SessionSummary, workspaceRoot: WorkspaceNode) => void;
  onDeleteSession: (id: string) => void;
  onNewChat: (projectId: string) => void;
  onAddFolder: (parentId: string) => void;
  onRenameNode: (node: WorkspaceNode) => void;
  onDeleteNode: (node: WorkspaceNode) => void;
  onTogglePin: (id: string) => void;
  onChangeColor: (id: string, color: ProjectColor) => void;
}) {
  const isOpen = !collapsed.has(node.id);
  const isContainer = node.kind === 'workspace_root' || node.kind === 'folder';
  // A workspace is context, not a second selection. Highlight it only when no chat is selected.
  const isFocusedRoot = node.kind === 'workspace_root'
    && node.id === activeWorkspaceId
    && activeSessionId === null;
  const [labelColor, setLabelColor] = useState<ProjectColor>(node.color ?? 'gray');
  const menuId = `workspace-node:${node.id}`;
  const { menuOpen, setMenuOpen, openMenu, toggleMenu } = useExclusiveSidebarMenu(menuId);
  const isPinned = pinnedNodes.includes(node.id);
  const pad = 8 + depth * 10;

  return (
    <div
      className="mb-0.5"
      data-sidebar-menu-id={menuId}
    >
      <div
        className={`group relative flex h-8 items-center gap-0.5 rounded-md pr-1 text-[12px] transition before:absolute before:bottom-1 before:left-0 before:top-1 before:w-0.5 before:rounded ${
          isFocusedRoot ? 'bg-accent/10 text-text before:bg-accent' : 'text-muted before:bg-transparent hover:bg-ink hover:text-text'
        }`}
        style={{ paddingLeft: pad }}
        onContextMenu={(event) => {
          event.preventDefault();
          openMenu();
        }}
      >
        <button
          type="button"
          className="rounded p-0.5"
          onClick={() => onToggle(node.id)}
          aria-label={isOpen ? '접기' : '펼치기'}
        >
          {isOpen ? <CaretDown size={12} /> : <CaretRight size={12} />}
        </button>
        <span className="shrink-0 p-0.5" aria-label={`${node.title} 컬러 라벨`}>
          <FolderSimple size={16} className="shrink-0" weight="fill" style={{ color: PROJECT_COLOR_HEX[labelColor] }} />
        </span>
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left font-medium"
          aria-current={isFocusedRoot ? 'page' : undefined}
          title={
            node.kind === 'workspace_root'
              ? `${node.folder_path || node.title} (클릭하면 이 폴더 채팅을 엽니다)`
              : `${node.title} (클릭하면 이 위치 채팅을 엽니다)`
          }
          onClick={() => {
            if (node.kind === 'workspace_root') onActivateWorkspace(node);
            else onOpenNodeChat(node);
          }}
        >
          {node.title}
        </button>
        <button
          type="button"
          className={`shrink-0 rounded p-1 transition hover:bg-ink ${isPinned ? 'text-accent opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'}`}
          title={isPinned ? '고정 해제' : '상단에 고정'}
          aria-label={isPinned ? `${node.title} 고정 해제` : `${node.title} 상단에 고정`}
          onClick={() => onTogglePin(node.id)}
        >
          <PushPin size={12} weight={isPinned ? 'fill' : 'regular'} />
        </button>
        <button
          type="button"
          className="rounded p-1 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100"
          title="이름 변경"
          aria-label="이름 변경"
          onClick={() => onRenameNode(node)}
        >
          <PencilSimple size={12} />
        </button>
        <div className="relative">
          <button
            type="button"
            className="rounded p-1 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100"
            title="더보기"
            aria-label="더보기"
            onClick={toggleMenu}
          >
            <DotsThree size={14} weight="bold" />
          </button>
          {menuOpen ? (
            <div className="absolute right-0 top-7 z-30 w-44 rounded-lg border border-line bg-panel p-1 text-text shadow-xl">
              <p className="px-2 py-1 text-[10px] text-muted">컬러 라벨</p>
              <div className="grid grid-cols-8 gap-1 px-2 pb-2">
                {PROJECT_COLORS.map((color) => (
                  <button key={color} type="button" title={`${color} 라벨`} aria-label={`${color} 라벨`} className={`h-4 w-4 rounded-full border ${labelColor === color ? 'border-text' : 'border-transparent'}`} style={{ backgroundColor: PROJECT_COLOR_HEX[color] }} onClick={() => { setLabelColor(color); setMenuOpen(false); onChangeColor(node.id, color); }} />
                ))}
              </div>
              <div className="border-t border-line pt-1">
                <button type="button" onClick={() => { setMenuOpen(false); onTogglePin(node.id); }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] hover:bg-ink"><PushPin size={13} weight={isPinned ? 'fill' : 'regular'} />{isPinned ? '고정 해제' : '상단에 고정'}</button>
                <button type="button" onClick={() => { setMenuOpen(false); onRenameNode(node); }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] hover:bg-ink"><PencilSimple size={13} />이름 변경</button>
                <button type="button" onClick={() => { setMenuOpen(false); openUserMemoryPanel({ projectId: node.id, title: node.title }); }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] hover:bg-ink"><Brain size={13} />워크스페이스 지식·메모리</button>
                <button type="button" disabled title="보관 기능은 준비 중입니다" className="flex w-full cursor-not-allowed items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] text-muted opacity-45"><Archive size={13} />보관 (준비 중)</button>
                <button type="button" onClick={() => { setMenuOpen(false); onDeleteNode(node); }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] text-red-300 hover:bg-ink"><Trash size={13} />삭제</button>
              </div>
              <div className="mt-1 border-t border-line pt-1">
                <button type="button" onClick={() => { setMenuOpen(false); onNewChat(node.id); }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] hover:bg-ink">
                  <ChatTeardropText size={13} />새 세션
                </button>
                {isContainer ? (
                  <button type="button" onClick={() => { setMenuOpen(false); onAddFolder(node.id); }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] hover:bg-ink">
                    <FolderPlus size={13} />하위 폴더
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {isOpen ? (
        <div className="ml-[11px] border-l border-line/70 pl-1">
          {(node.sessions ?? []).filter(matchSession).map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              active={s.id === activeSessionId}
              indent={pad + 18}
              onSelect={() => onSelectSession(s, workspaceRoot)}
              onDelete={() => onDeleteSession(s.id)}
            />
          ))}
          {pinnedFirst((node.children ?? []).filter(matchNode), pinnedNodes).map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              workspaceRoot={workspaceRoot}
              depth={depth + 1}
              collapsed={collapsed}
              pinnedNodes={pinnedNodes}
              activeSessionId={activeSessionId}
              activeWorkspaceId={activeWorkspaceId}
              matchSession={matchSession}
              matchNode={matchNode}
              onToggle={onToggle}
              onActivateWorkspace={onActivateWorkspace}
              onOpenNodeChat={onOpenNodeChat}
              onSelectSession={onSelectSession}
              onDeleteSession={onDeleteSession}
              onNewChat={onNewChat}
              onAddFolder={onAddFolder}
              onRenameNode={onRenameNode}
              onDeleteNode={onDeleteNode}
              onTogglePin={onTogglePin}
              onChangeColor={onChangeColor}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ProjectBlock({
  id,
  title,
  color,
  pinned,
  sessions,
  collapsed,
  activeSessionId,
  matchSession,
  onToggle,
  onOpenChat,
  onSelectSession,
  onDeleteSession,
  onNewChat,
  onRename,
  onDelete,
  onTogglePin,
  onChangeColor,
}: {
  id: string;
  title: string;
  color: ProjectColor;
  pinned: boolean;
  sessions: SessionSummary[];
  collapsed: boolean;
  activeSessionId: string | null;
  matchSession: (s: SessionSummary) => boolean;
  onToggle: () => void;
  onOpenChat: () => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onNewChat: () => void;
  onRename: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
  onChangeColor: (color: ProjectColor) => void;
}) {
  const menuId = `project:${id}`;
  const { menuOpen, setMenuOpen, openMenu, toggleMenu } = useExclusiveSidebarMenu(menuId);
  const [labelColor, setLabelColor] = useState(color);
  return (
    <div className="mb-0.5" data-sidebar-menu-id={menuId}>
      <div className="group relative flex h-8 items-center gap-0.5 rounded-md px-2 text-[12px] text-muted transition hover:bg-ink hover:text-text" onContextMenu={(event) => { event.preventDefault(); openMenu(); }}>
        <button type="button" className="rounded p-0.5" onClick={onToggle} aria-label={collapsed ? '펼치기' : '접기'}>
          {collapsed ? <CaretRight size={12} /> : <CaretDown size={12} />}
        </button>
        <FolderSimple size={16} weight="fill" style={{ color: PROJECT_COLOR_HEX[labelColor] }} />
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left font-medium"
          title={`${title} (클릭하면 이 프로젝트 채팅을 엽니다)`}
          onClick={onOpenChat}
        >
          {title}
        </button>
        <button
          type="button"
          className={`shrink-0 rounded p-1 transition hover:bg-ink ${pinned ? 'text-accent opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'}`}
          title={pinned ? '고정 해제' : '상단에 고정'}
          aria-label={pinned ? `${title} 고정 해제` : `${title} 상단에 고정`}
          onClick={onTogglePin}
        >
          <PushPin size={12} weight={pinned ? 'fill' : 'regular'} />
        </button>
        <button type="button" className="rounded p-1 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100" title="이름 변경" onClick={onRename}>
          <PencilSimple size={12} />
        </button>
        <div className="relative">
          <button type="button" className="rounded p-1 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100" title="더보기" onClick={toggleMenu}>
            <DotsThree size={14} weight="bold" />
          </button>
          {menuOpen ? (
            <div className="absolute right-0 top-7 z-30 w-44 rounded-lg border border-line bg-panel p-1 text-text shadow-xl">
              <p className="px-2 py-1 text-[10px] text-muted">컬러 라벨</p>
              <div className="grid grid-cols-8 gap-1 px-2 pb-2">
                {PROJECT_COLORS.map((nextColor) => (
                  <button key={nextColor} type="button" title={`${nextColor} 라벨`} aria-label={`${nextColor} 라벨`} className={`h-4 w-4 rounded-full border ${labelColor === nextColor ? 'border-text' : 'border-transparent'}`} style={{ backgroundColor: PROJECT_COLOR_HEX[nextColor] }} onClick={() => { setLabelColor(nextColor); setMenuOpen(false); onChangeColor(nextColor); }} />
                ))}
              </div>
              <div className="border-t border-line pt-1">
                <button type="button" onClick={() => { setMenuOpen(false); onTogglePin(); }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] hover:bg-ink"><PushPin size={13} weight={pinned ? 'fill' : 'regular'} />{pinned ? '고정 해제' : '상단에 고정'}</button>
                <button type="button" onClick={() => { setMenuOpen(false); onRename(); }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] hover:bg-ink"><PencilSimple size={13} />이름 변경</button>
                <button type="button" onClick={() => { setMenuOpen(false); openUserMemoryPanel({ projectId: id, title }); }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] hover:bg-ink"><Brain size={13} />프로젝트 지식·메모리</button>
                <button type="button" disabled title="보관 기능은 준비 중입니다" className="flex w-full cursor-not-allowed items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] text-muted opacity-45"><Archive size={13} />보관 (준비 중)</button>
                <button type="button" onClick={() => { setMenuOpen(false); onDelete(); }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] text-red-300 hover:bg-ink"><Trash size={13} />삭제</button>
              </div>
              <div className="mt-1 border-t border-line pt-1">
                <button type="button" onClick={() => { setMenuOpen(false); onNewChat(); }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] hover:bg-ink"><ChatTeardropText size={13} />새 세션</button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
      {!collapsed
        ? sessions.filter(matchSession).map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              active={s.id === activeSessionId}
              indent={28}
              onSelect={() => onSelectSession(s.id)}
              onDelete={() => onDeleteSession(s.id)}
            />
          ))
        : null}
      {/* silence unused id when collapsed-only */}
      <span className="hidden">{id}</span>
    </div>
  );
}

function SessionRow({
  session,
  active,
  indent = 8,
  pinned,
  onTogglePin,
  onSelect,
  onDelete,
}: {
  session: SessionSummary;
  active: boolean;
  indent?: number;
  pinned?: boolean;
  onTogglePin?: () => void;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const phase = useWorkspaceStore((s) => s.sessionPhases[session.id]);
  const menuId = `session:${session.id}`;
  const { menuOpen, setMenuOpen, openMenu, toggleMenu } = useExclusiveSidebarMenu(menuId);
  return (
    <div
      role="button"
      tabIndex={0}
      data-sidebar-menu-id={menuId}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openMenu();
      }}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSelect();
      }}
      className={`group relative mb-0.5 flex h-7 cursor-pointer items-center gap-1 rounded-md pr-1 text-[11px] transition before:absolute before:bottom-1 before:left-0 before:top-1 before:w-0.5 before:rounded ${
        active ? 'bg-accent/10 text-text before:bg-accent' : 'text-muted before:bg-transparent hover:bg-ink hover:text-text'
      }`}
      style={{ paddingLeft: indent }}
    >
      <span className="min-w-0 flex-1 truncate">{session.title || '제목 없음'}</span>
      {phase === 'running' ? (
        <span className="shrink-0 text-[9px] text-accent" title="생성 중">
          ●
        </span>
      ) : null}
      {onTogglePin ? (
        <button
          type="button"
          className={`shrink-0 rounded p-0.5 transition ${pinned ? 'text-accent opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
          title={pinned ? '고정 해제' : '고정'}
          onClick={(event) => { event.stopPropagation(); onTogglePin(); }}
        >
          <PushPin size={11} weight={pinned ? 'fill' : 'regular'} />
        </button>
      ) : null}
      <div className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="rounded p-0.5 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100"
          title="더보기"
          aria-label={`${session.title || '세션'} 더보기`}
          onClick={toggleMenu}
        >
          <DotsThree size={14} weight="bold" />
        </button>
        {menuOpen ? (
          <div className="absolute right-0 top-6 z-30 w-36 rounded-lg border border-line bg-panel p-1 text-text shadow-xl">
            {onTogglePin ? (
              <button type="button" onClick={() => { setMenuOpen(false); onTogglePin(); }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] hover:bg-ink"><PushPin size={13} weight={pinned ? 'fill' : 'regular'} />{pinned ? '고정 해제' : '고정'}</button>
            ) : null}
            <button type="button" onClick={() => { setMenuOpen(false); onDelete(); }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] text-red-300 hover:bg-ink"><Trash size={13} />삭제</button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
