import {
  Archive,
  ArrowBendUpRight,
  Brain,
  CaretDown,
  CaretLeft,
  CaretRight,
  CaretUp,
  ChatTeardropText,
  CircleNotch,
  DotsThree,
  Export,
  FolderPlus,
  FolderSimple,
  HardDrives,
  PencilSimple,
  Plus,
  PushPin,
  SlidersHorizontal,
  Trash,
  TreeStructure,
} from '@phosphor-icons/react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { durableSetItem } from '../lib/durableUiState';
import { removePinnedInstructions } from '../lib/pinnedInstructions';
import {
  archiveSession,
  createProject,
  deleteProject,
  deleteSession,
  fetchProjectDeletePreview,
  importSession,
  renameSession,
  fetchWorkspaceTree,
  getPinnedSessionIds,
  getStoredSessionId,
  setDevWorkspace,
  setPinnedSessionIds,
  setSessionProject as saveSessionProject,
  setSessionWorkspaceProject as saveSessionWorkspaceProject,
  updateProject,
  type ProjectColor,
  type ProjectKind,
  type SessionSummary,
  type WorkspaceNode,
  type WorkspaceTreePayload,
} from '../api/myAgentClient';
import { useWorkspaceStore } from '../store/workspaceStore';
import { choiceDialog, confirmDialog, promptDialog } from '../lib/confirmDialog';
import { pickPortableSessionFile } from '../lib/sessionImport';
import { exportPortableSession } from '../lib/sessionExport';
import { FolderBrowserModal } from './FolderBrowserModal';
import { openUserMemoryPanel, UserMemoryPanelHost } from './UserMemoryPanel';
import { openScopeSettings, ScopeSettingsModalHost } from './ScopeSettingsModal';
import { useAnchoredOverlay } from '../lib/useAnchoredOverlay';

const COLLAPSED_KEY = 'my-agent-workspace-collapsed-nodes';
const LEGACY_COLLAPSED_KEY = 'cqr-workspace-collapsed-nodes';
const PINNED_NODES_KEY = 'my-agent-workspace-pinned-nodes';
const STANDALONE_COLLAPSED_ID = '__standalone_sessions__';
const SESSION_PREVIEW_LIMIT = 5;
const PROJECT_COLORS: ProjectColor[] = ['gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'pink'];
const PROJECT_COLOR_HEX: Record<ProjectColor, string> = {
  gray: '#94a3b8', red: '#f87171', orange: '#fb923c', yellow: '#facc15',
  green: '#4ade80', teal: '#2dd4bf', blue: '#60a5fa', pink: '#f472b6',
};
const SIDEBAR_MENU_OPEN_EVENT = 'cqr:sidebar-menu-open';

/** After a permanent delete the open chat may be gone; 404 means it was removed. */
async function sessionStillExists(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/sessions/${encodeURIComponent(id)}`, { cache: 'no-store' });
    return res.status !== 404;
  } catch {
    return true;
  }
}

/** Three top-level kinds must use different shapes (not color alone). */
type TreeIconProps = { size?: number; weight?: 'fill' | 'regular' | 'bold'; className?: string; style?: { color?: string } };
function treeKindIcon(kind: ProjectKind | 'standalone'): ComponentType<TreeIconProps> {
  switch (kind) {
    case 'standalone':
      return ChatTeardropText; // 개인 작업
    case 'workspace_root':
      return HardDrives; // 워크스페이스(작업폴더)
    case 'folder':
      return FolderSimple; // 하위 폴더
    case 'project':
    default:
      return TreeStructure; // 프로젝트
  }
}

function TreeKindIcon({
  kind,
  color,
  className,
  title,
}: {
  kind: ProjectKind | 'standalone';
  color?: string;
  className?: string;
  title?: string;
}) {
  const Icon = treeKindIcon(kind);
  return (
    <span className={className} title={title} aria-hidden>
      <Icon size={16} weight="fill" style={color ? { color } : undefined} />
    </span>
  );
}

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

function SidebarMenuPopup({ open, menuId, anchorRef, widthClass, children }: {
  open: boolean;
  menuId: string;
  anchorRef: RefObject<HTMLElement | null>;
  widthClass: string;
  children: ReactNode;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  useAnchoredOverlay({ open, anchorRef, overlayRef, align: 'end', maxHeight: 480 });
  if (!open) return null;
  return createPortal(
    <div
      ref={overlayRef}
      data-sidebar-menu-id={menuId}
      role="menu"
      className={`fixed z-[300] overflow-y-auto rounded-lg border border-line bg-panel p-1 text-text shadow-xl ${widthClass}`}
      style={{ visibility: 'hidden' }}
    >
      {children}
    </div>,
    document.body,
  );
}

function useSidebarMenuShortcuts(
  menuOpen: boolean,
  onNewChat?: () => void,
  onDelete?: () => void,
) {
  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      const key = event.key.toLowerCase();
      const action = key === 'n' ? onNewChat : key === 'd' ? onDelete : undefined;
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      action();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [menuOpen, onDelete, onNewChat]);
}

/** One menu row for every sidebar context menu (same spacing, hover, and danger style). */
function SidebarMenuItem({ icon, danger = false, disabled = false, title, onClick, children }: {
  icon: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] ${
        disabled ? 'cursor-not-allowed opacity-45' : 'hover:bg-ink'
      } ${danger ? 'text-red-300' : ''}`}
    >
      <span className="flex shrink-0 items-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

/** Shared menu for 작업폴더 · 폴더 · 프로젝트 so wording, order, and dividers cannot drift apart. */
function NodeMenuItems({
  kind,
  labelColor,
  pinned,
  close,
  onPickColor,
  onImport,
  onTogglePin,
  onRename,
  onSettings,
  onMemory,
  onDelete,
  onNewChat,
  onAddFolder,
}: {
  kind: ProjectKind;
  labelColor: ProjectColor;
  pinned: boolean;
  close: () => void;
  onPickColor: (color: ProjectColor) => void;
  onImport: () => void;
  onTogglePin: () => void;
  onRename: () => void;
  onSettings: () => void;
  onMemory: () => void;
  onDelete: () => void;
  onNewChat: () => void;
  onAddFolder?: () => void;
}) {
  const kindLabel = kind === 'workspace_root' ? '작업폴더' : kind === 'folder' ? '폴더' : '프로젝트';
  const run = (action: () => void) => () => { close(); action(); };
  return (
    <>
      <p className="px-2 py-1 text-[10px] text-muted">컬러 라벨</p>
      <div className="grid grid-cols-8 gap-1 px-2 pb-2">
        {PROJECT_COLORS.map((color) => (
          <button key={color} type="button" title={`${color} 라벨`} aria-label={`${color} 라벨`} className={`h-4 w-4 rounded-full border ${labelColor === color ? 'border-text' : 'border-transparent'}`} style={{ backgroundColor: PROJECT_COLOR_HEX[color] }} onClick={run(() => onPickColor(color))} />
        ))}
      </div>
      <div className="border-t border-line pt-1">
        <SidebarMenuItem icon={<Archive size={13} />} onClick={run(onImport)}>세션 가져오기</SidebarMenuItem>
        <SidebarMenuItem icon={<PushPin size={13} weight={pinned ? 'fill' : 'regular'} />} onClick={run(onTogglePin)}>{pinned ? '고정 해제' : '상단에 고정'}</SidebarMenuItem>
        <SidebarMenuItem icon={<PencilSimple size={13} />} onClick={run(onRename)}>이름 변경</SidebarMenuItem>
        <SidebarMenuItem icon={<SlidersHorizontal size={13} />} onClick={run(onSettings)}>{kindLabel} 설정</SidebarMenuItem>
        <SidebarMenuItem icon={<Brain size={13} />} onClick={run(onMemory)}>{kindLabel} 지식·메모리</SidebarMenuItem>
        <SidebarMenuItem icon={<Trash size={13} />} danger onClick={run(onDelete)}>삭제 D</SidebarMenuItem>
      </div>
      <div className="mt-1 border-t border-line pt-1">
        <SidebarMenuItem icon={<ChatTeardropText size={13} />} onClick={run(onNewChat)}>새 대화 N</SidebarMenuItem>
        {onAddFolder ? (
          <SidebarMenuItem icon={<FolderPlus size={13} />} onClick={run(onAddFolder)}>하위 폴더</SidebarMenuItem>
        ) : null}
      </div>
    </>
  );
}

/** A place a conversation can live in the sidebar; `id: null` is 개인 작업. */
interface SessionDestination {
  id: string | null;
  label: string;
  depth: number;
  kind: ProjectKind | 'standalone';
}

/** Conversation-row actions owned by the tree, so rows at any depth share one implementation. */
interface SessionRowActions {
  destinations: SessionDestination[];
  workspaceRoots: { id: string; title: string }[];
  newChat: (projectId: string | null) => void;
  move: (session: SessionSummary, projectId: string | null) => void;
  bindWorkspace: (session: SessionSummary, workspaceProjectId: string | null) => void;
  exportSession: (session: SessionSummary) => void;
}

const SessionRowActionsContext = createContext<SessionRowActions | null>(null);

/** 개인 작업 chats have no files unless a folder or allowed path was attached to that chat. */
function sessionHasOwnFileAccess(session: SessionSummary): boolean {
  return !session.project_id && Boolean(session.workspace_project_id || session.allowed_paths?.length);
}

function SessionMenuItems({ session, pinned, busy, close, onTogglePin, onRename, onDelete }: {
  session: SessionSummary;
  pinned?: boolean;
  busy: boolean;
  close: () => void;
  onTogglePin?: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const actions = useContext(SessionRowActionsContext);
  const [view, setView] = useState<'main' | 'move' | 'bind'>('main');
  const run = (action: () => void) => () => { close(); action(); };
  const standalone = !session.project_id;
  const busyTitle = busy ? '진행 중인 작업이 끝난 뒤 변경하세요' : undefined;

  if (view === 'move' && actions) {
    return (
      <>
        <SidebarMenuItem icon={<CaretLeft size={13} />} onClick={() => setView('main')}>다른 위치로 이동</SidebarMenuItem>
        <p className="px-2 pb-1 text-[10px] leading-4 text-muted">파일 접근 범위는 새 위치를 따릅니다.</p>
        <div className="border-t border-line pt-1">
          {actions.destinations.map((destination) => (
            <SidebarMenuItem
              key={destination.id ?? '__standalone__'}
              icon={<span style={{ paddingLeft: destination.depth * 8 }}><TreeKindIcon kind={destination.kind} /></span>}
              disabled={(session.project_id ?? null) === destination.id}
              title={destination.label}
              onClick={run(() => actions.move(session, destination.id))}
            >
              {destination.label}
            </SidebarMenuItem>
          ))}
        </div>
      </>
    );
  }

  if (view === 'bind' && actions) {
    return (
      <>
        <SidebarMenuItem icon={<CaretLeft size={13} />} onClick={() => setView('main')}>작업폴더 연결</SidebarMenuItem>
        <p className="px-2 pb-1 text-[10px] leading-4 text-muted">이 대화에만 파일 접근을 엽니다. 대화 위치는 개인 작업에 그대로 남습니다.</p>
        <div className="border-t border-line pt-1">
          {actions.workspaceRoots.length === 0 ? (
            <p className="px-2 py-1.5 text-[11px] text-muted">등록된 작업폴더가 없습니다.</p>
          ) : null}
          {actions.workspaceRoots.map((root) => (
            <SidebarMenuItem
              key={root.id}
              icon={<TreeKindIcon kind="workspace_root" />}
              disabled={session.workspace_project_id === root.id}
              title={root.title}
              onClick={run(() => actions.bindWorkspace(session, root.id))}
            >
              {root.title}
            </SidebarMenuItem>
          ))}
          {session.workspace_project_id ? (
            <SidebarMenuItem icon={<FolderSimple size={13} />} onClick={run(() => actions.bindWorkspace(session, null))}>연결 해제</SidebarMenuItem>
          ) : null}
        </div>
      </>
    );
  }

  return (
    <>
      {onTogglePin ? (
        <SidebarMenuItem icon={<PushPin size={13} weight={pinned ? 'fill' : 'regular'} />} onClick={run(onTogglePin)}>{pinned ? '대화 고정 해제' : '이 묶음에 대화 고정'}</SidebarMenuItem>
      ) : null}
      <SidebarMenuItem
        icon={<SlidersHorizontal size={13} />}
        onClick={run(() => openScopeSettings({ kind: 'session', id: session.id, title: session.title || '제목 없음', preferredModel: session.preferred_model, allowedPaths: session.allowed_paths, projectId: session.project_id ?? null }))}
      >
        대화 설정
      </SidebarMenuItem>
      <SidebarMenuItem icon={<Brain size={13} />} onClick={run(() => openUserMemoryPanel({ sessionId: session.id, projectId: session.project_id ?? null, title: session.title || '제목 없음' }))}>대화 메모리</SidebarMenuItem>
      <SidebarMenuItem icon={<PencilSimple size={13} />} onClick={run(onRename)}>이름 변경</SidebarMenuItem>
      {actions && !session.archived ? (
        <div className="mt-1 border-t border-line pt-1">
          <SidebarMenuItem icon={<ArrowBendUpRight size={13} />} disabled={busy} title={busyTitle} onClick={() => setView('move')}>다른 위치로 이동…</SidebarMenuItem>
          {standalone ? (
            <SidebarMenuItem icon={<FolderSimple size={13} />} disabled={busy} title={busyTitle} onClick={() => setView('bind')}>{session.workspace_project_id ? '작업폴더 연결 변경…' : '작업폴더 연결…'}</SidebarMenuItem>
          ) : null}
          <SidebarMenuItem icon={<Export size={13} />} onClick={run(() => actions.exportSession(session))}>내보내기</SidebarMenuItem>
        </div>
      ) : null}
      <div className="mt-1 border-t border-line pt-1">
        <SidebarMenuItem
          icon={<Archive size={13} weight={session.archived ? 'fill' : 'regular'} />}
          onClick={run(() => {
            void archiveSession(session.id, !session.archived)
              .then(() => window.dispatchEvent(new Event('cqr:workspace-tree-changed')))
              .catch(() => { /* keep current state on failure */ });
          })}
        >
          {session.archived ? '보관 해제' : '보관'}
        </SidebarMenuItem>
        <SidebarMenuItem icon={<Trash size={13} />} danger onClick={run(onDelete)}>삭제 D</SidebarMenuItem>
      </div>
      {actions && !session.archived ? (
        <div className="mt-1 border-t border-line pt-1">
          <SidebarMenuItem icon={<ChatTeardropText size={13} />} onClick={run(() => actions.newChat(session.project_id ?? null))}>새 대화 N</SidebarMenuItem>
        </div>
      ) : null}
    </>
  );
}

/** 개인 작업 header: collapse toggle plus the same right-click menu pattern as other groups. */
function StandaloneHeader({ collapsed, onToggle, onNewChat, onImport }: {
  collapsed: boolean;
  onToggle: () => void;
  onNewChat: () => void;
  onImport: () => void;
}) {
  const menuId = 'standalone-root';
  const { menuOpen, setMenuOpen, openMenu, toggleMenu } = useExclusiveSidebarMenu(menuId);
  const menuAnchorRef = useRef<HTMLButtonElement>(null);
  useSidebarMenuShortcuts(menuOpen, () => { setMenuOpen(false); onNewChat(); }, undefined);
  const run = (action: () => void) => () => { setMenuOpen(false); action(); };
  return (
    <div
      className="group flex h-8 items-center gap-0.5 rounded-md pr-1 text-[12px] text-muted transition hover:bg-ink hover:text-text"
      data-sidebar-menu-id={menuId}
      data-testid="standalone-header"
      onContextMenu={(event) => {
        event.preventDefault();
        openMenu();
      }}
    >
      <button
        type="button"
        className="flex h-full min-w-0 flex-1 items-center gap-1 rounded-md px-1 text-left"
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-label={collapsed ? '개인 작업 펼치기' : '개인 작업 접기'}
        title={collapsed ? '개인 작업 펼치기' : '개인 작업 접기'}
      >
        {collapsed ? <CaretRight size={12} /> : <CaretDown size={12} />}
        <TreeKindIcon kind="standalone" color={PROJECT_COLOR_HEX.gray} title="개인 작업" />
        <span className="font-medium">개인 작업</span>
      </button>
      <button
        type="button"
        className="rounded p-1 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100"
        title="개인 작업에 새 대화"
        aria-label="개인 작업에 새 대화"
        onClick={onNewChat}
      >
        <Plus size={12} weight="bold" />
      </button>
      <div className="relative">
        <button
          ref={menuAnchorRef}
          type="button"
          className="rounded p-1 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100"
          title="더보기"
          aria-label="개인 작업 더보기"
          onClick={toggleMenu}
        >
          <DotsThree size={14} weight="bold" />
        </button>
        <SidebarMenuPopup open={menuOpen} menuId={menuId} anchorRef={menuAnchorRef} widthClass="w-48">
          <p className="px-2 py-1 text-[10px] leading-4 text-muted">파일 접근 없음 · Agent는 웹 도구만. 파일이 필요하면 대화에 작업폴더를 연결하세요.</p>
          <div className="border-t border-line pt-1">
            <SidebarMenuItem icon={<ChatTeardropText size={13} />} onClick={run(onNewChat)}>새 대화 N</SidebarMenuItem>
            <SidebarMenuItem icon={<Archive size={13} />} onClick={run(onImport)}>세션 가져오기</SidebarMenuItem>
            <SidebarMenuItem icon={<Brain size={13} />} onClick={run(() => openUserMemoryPanel({ title: '개인 작업' }))}>메모리 관리 · 보관함</SidebarMenuItem>
            <SidebarMenuItem icon={collapsed ? <CaretDown size={13} /> : <CaretRight size={13} />} onClick={run(onToggle)}>{collapsed ? '펼치기' : '접기'}</SidebarMenuItem>
          </div>
        </SidebarMenuPopup>
      </div>
    </div>
  );
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
  const requestHistoryFocus = useWorkspaceStore((s) => s.requestHistoryFocus);
  const setActiveSessionProject = useWorkspaceStore((s) => s.setSessionProject);
  const setActiveSessionWorkspaceProject = useWorkspaceStore((s) => s.setSessionWorkspaceProject);
  const refreshExplorer = useWorkspaceStore((s) => s.refreshExplorer);

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

  // Ctrl+PgUp / Ctrl+PgDn move between sessions actually rendered in the left list.
  // Rows collapsed under a folder or excluded by search are absent from the DOM,
  // so they are skipped automatically. Reuses each row's existing click path.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || (event.key !== 'PageUp' && event.key !== 'PageDown')) return;
      const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-session-nav-id]'));
      if (rows.length === 0) return;
      event.preventDefault();
      const currentIndex = rows.findIndex((row) => row.getAttribute('data-session-nav-id') === activeSessionId);
      let targetIndex: number;
      if (currentIndex === -1) {
        targetIndex = event.key === 'PageDown' ? 0 : rows.length - 1;
      } else if (event.key === 'PageUp') {
        if (currentIndex === 0) return;
        targetIndex = currentIndex - 1;
      } else {
        if (currentIndex === rows.length - 1) return;
        targetIndex = currentIndex + 1;
      }
      rows[targetIndex]?.click();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeSessionId]);

  const togglePin = (id: string) => {
    const next = pinned.includes(id) ? pinned.filter((item) => item !== id) : [id, ...pinned];
    setPinned(next);
    setPinnedSessionIds(next);
  };

  const toggleNodePin = (id: string) => {
    setPinnedNodes((current) => {
      const next = current.includes(id) ? current.filter((item) => item !== id) : [id, ...current];
      durableSetItem(PINNED_NODES_KEY, JSON.stringify(next));
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

  const importPortableSession = async (file: File, projectId: string | null) => {
    try {
      const raw = JSON.parse(await file.text());
      await importSession(raw, projectId);
      await refresh();
      onMessage?.('세션을 가져왔습니다.');
    } catch (err) {
      onMessage?.(err instanceof Error ? err.message : '세션 가져오기 실패');
    }
  };

  /** projectId = the node whose menu was used (root, folder, or project): the chat lands exactly there. */
  const chooseAndImportSession = async (projectId: string | null) => {
    const file = await pickPortableSessionFile();
    if (file) await importPortableSession(file, projectId);
  };

  const onNewChatIn = async (id: string | null) => {
    // The sidebar location is the only input; the core derives the workspace folder from it.
    await startNewChat(id);
    onChatOpened?.();
  };

  /** Move a conversation to another sidebar location; the server re-derives its file scope there. */
  const moveSession = async (session: SessionSummary, projectId: string | null) => {
    try {
      if (session.id === activeSessionId) {
        await setActiveSessionProject(projectId);
        await refreshExplorer();
      } else {
        await saveSessionProject(session.id, projectId);
      }
      await refresh();
      onMessage?.('대화를 옮겼습니다. 파일 접근 범위는 새 위치를 따릅니다.');
    } catch (err) {
      onMessage?.(err instanceof Error ? err.message : '대화 이동 실패');
    }
  };

  /** Attach or detach a registered workspace folder for one 개인 작업 conversation. */
  const bindSessionWorkspace = async (session: SessionSummary, workspaceProjectId: string | null) => {
    try {
      if (session.id === activeSessionId) await setActiveSessionWorkspaceProject(workspaceProjectId);
      else await saveSessionWorkspaceProject(session.id, workspaceProjectId);
      await refresh();
      onMessage?.(workspaceProjectId ? '이 대화에 작업폴더를 연결했습니다.' : '이 대화의 작업폴더 연결을 해제했습니다.');
    } catch (err) {
      onMessage?.(err instanceof Error ? err.message : '작업폴더 연결 변경 실패');
    }
  };

  const exportSession = async (session: SessionSummary) => {
    try {
      await exportPortableSession(session.id);
      onMessage?.('호환 가능한 JSON 세션 파일로 내보냈습니다.');
    } catch (err) {
      onMessage?.(err instanceof Error ? err.message : '세션 내보내기 실패');
    }
  };

  const sessionDestinations = useMemo(() => {
    const out: SessionDestination[] = [{ id: null, label: '개인 작업', depth: 0, kind: 'standalone' }];
    const walk = (node: WorkspaceNode, depth: number) => {
      out.push({ id: node.id, label: node.title, depth, kind: node.kind });
      (node.children ?? []).forEach((child) => walk(child, depth + 1));
    };
    (tree?.workspace_trees ?? []).forEach((node) => walk(node, 0));
    (tree?.projects ?? []).forEach((project) => out.push({ id: project.id, label: project.title, depth: 0, kind: 'project' }));
    return out;
  }, [tree]);

  const sessionRowActions: SessionRowActions = {
    destinations: sessionDestinations,
    workspaceRoots: (tree?.workspace_trees ?? []).map((node) => ({ id: node.id, title: node.title })),
    newChat: (projectId) => void onNewChatIn(projectId),
    move: (session, projectId) => void moveSession(session, projectId),
    bindWorkspace: (session, workspaceProjectId) => void bindSessionWorkspace(session, workspaceProjectId),
    exportSession: (session) => void exportSession(session),
  };

  const openSession = async (id: string, _projectId: string | null) => {
    try {
      await loadChatSession(id);
      onChatOpened?.();
      requestHistoryFocus();
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
      removePinnedInstructions(id);
      if (activeSessionId === id || getStoredSessionId() === id) {
        clearActiveChat();
      }
      await refresh();
    } catch (err) {
      onMessage?.(err instanceof Error ? err.message : '삭제 실패');
    }
  };

  const onDeleteNode = async (node: Pick<WorkspaceNode, 'id' | 'title' | 'kind'>) => {
    const label =
      node.kind === 'workspace_root'
        ? '작업 폴더'
        : node.kind === 'folder'
          ? '폴더'
          : '프로젝트';
    let mode: 'lift' | 'delete' = 'lift';
    try {
      const preview = await fetchProjectDeletePreview(node.id);
      const targetLabel = preview.target ? `「${preview.target.title}」` : '개인 작업';
      const sub = preview.folders > 0 ? ` (하위 폴더 ${preview.folders}개 포함)` : '';
      if (preview.sessions === 0) {
        const memoryNote = preview.memories > 0
          ? `\n프로젝트 메모리 ${preview.memories}개는 출처를 유지해 보관됩니다. 복원 전에는 자동 적용되지 않습니다.`
          : '';
        const ok = await confirmDialog({
          title: `${label} 삭제`,
          message: `${label} "${node.title}"${sub}을(를) 삭제할까요?${memoryNote}`,
          danger: true,
          confirmLabel: '삭제',
        });
        if (!ok) return;
      } else {
        const memoryNote = preview.memories > 0
          ? ` 프로젝트 메모리 ${preview.memories}개는 기본 선택에서 보관되며 복원 전에는 자동 적용되지 않습니다.`
          : '';
        const choice = await choiceDialog({
          title: `${label} 삭제`,
          message:
            `${label} "${node.title}"${sub} 안에 대화 ${preview.sessions}개가 있습니다.\n` +
            `기본으로는 대화를 ${targetLabel}(으)로 옮기고 ${label}만 삭제합니다.${memoryNote}`,
          options: [
            { id: 'lift', label: `대화 옮기고 ${label} 삭제` },
            { id: 'delete', label: `대화 ${preview.sessions}개까지 영구 삭제`, danger: true },
            { id: 'cancel', label: '취소' },
          ],
        });
        if (choice !== 'lift' && choice !== 'delete') return;
        if (choice === 'delete') {
          const sure = await confirmDialog({
            title: '대화 영구 삭제',
            message: `대화 ${preview.sessions}개와 프로젝트 메모리 ${preview.memories}개를 되돌릴 수 없게 삭제합니다. 계속할까요?`,
            danger: true,
            confirmLabel: '영구 삭제',
            allowEnterConfirm: false,
          });
          if (!sure) return;
        }
        mode = choice;
      }
      await deleteProject(node.id, mode);
      if (mode === 'delete') {
        const sid = activeSessionId ?? getStoredSessionId();
        if (sid && !(await sessionStillExists(sid))) clearActiveChat();
      }
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
        onMessage?.(`작업 폴더 연결 · 새 대화 시작: ${folderPath}`);
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
  const standaloneCollapsed = collapsed.has(STANDALONE_COLLAPSED_ID) && !q;
  const standaloneSessions = pinnedFirst((tree?.standalone_sessions ?? []).filter(matchSession), pinned);

  return (
    <SessionRowActionsContext.Provider value={sessionRowActions}>
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
        {tree && (!q || standaloneSessions.length > 0) ? (
          <div className="mb-1">
            <StandaloneHeader
              collapsed={standaloneCollapsed}
              onToggle={() => toggle(STANDALONE_COLLAPSED_ID)}
              onNewChat={() => void onNewChatIn(null)}
              onImport={() => void chooseAndImportSession(null)}
            />
            {!standaloneCollapsed ? (
              <div className="ml-[11px] border-l border-line/70 pl-1">
                {standaloneSessions.length === 0 ? (
                  <p className="py-1.5 pl-5 text-[11px] text-muted" data-testid="standalone-empty">대화가 없습니다. + 를 눌러 새 대화를 시작하세요.</p>
                ) : null}
                <SessionPreviewList
                  sessions={standaloneSessions}
                  activeSessionId={activeSessionId}
                  indent={20}
                  pinnedSessionIds={pinned}
                  revealAll={Boolean(q)}
                  onSelect={(session) => void onSelectSession(session.id)}
                  onDelete={(id) => void onDeleteSession(id)}
                  onTogglePin={togglePin}
                />
              </div>
            ) : null}
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
                pinnedSessionIds={pinned}
                activeSessionId={activeSessionId}
                activeWorkspaceId={tree?.active_workspace_project_id ?? null}
                matchSession={matchSession}
                matchNode={matchNode}
                revealAll={Boolean(q)}
                onToggle={toggle}
                onActivateWorkspace={(n) => void onActivateWorkspace(n)}
                onOpenNodeChat={(n) => void openNodeChat(n)}
                onSelectSession={(s, wsRoot) => void onSelectSessionUnderWorkspace(s, wsRoot)}
                onDeleteSession={(id) => void onDeleteSession(id)}
                onToggleSessionPin={togglePin}
                onNewChat={(id) => void onNewChatIn(id)}
                onImportSession={(projectId) => void chooseAndImportSession(projectId)}
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
                  preferredModel={p.preferred_model}
                  allowedPaths={p.allowed_paths}
                  color={p.color ?? 'gray'}
                  pinned={pinnedNodes.includes(p.id)}
                  sessions={p.sessions}
                  pinnedSessionIds={pinned}
                  collapsed={collapsed.has(p.id)}
                  activeSessionId={activeSessionId}
                  matchSession={matchSession}
                  revealAll={Boolean(q)}
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
                  onToggleSessionPin={togglePin}
                  onNewChat={() => void onNewChatIn(p.id)}
                  onImportSession={() => void chooseAndImportSession(p.id)}
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
                  onDelete={() => void onDeleteNode({ id: p.id, title: p.title, kind: 'project' })}
                />
          );
        })}

        {(tree?.workspace_trees?.length ?? 0) === 0 && (tree?.projects?.length ?? 0) === 0 ? (
          <p className="px-2 py-4 text-[11px] text-muted">
            작업 폴더나 프로젝트를 추가하면 여기에 표시됩니다.
          </p>
        ) : null}

        {(tree?.archived_sessions?.length ?? 0) > 0 ? (
          <ArchivedSessions
            sessions={tree!.archived_sessions!}
            activeSessionId={activeSessionId}
            matchSession={matchSession}
            onSelect={(id, projectId) => void onSelectSession(id, projectId)}
            onDelete={(id) => void onDeleteSession(id)}
          />
        ) : null}
      </div>

      <UserMemoryPanelHost />
      <ScopeSettingsModalHost />
      <FolderBrowserModal
        open={browseOpen}
        onClose={() => setBrowseOpen(false)}
        onSelect={(path) => void onPickWorkspace(path)}
      />
    </div>
    </SessionRowActionsContext.Provider>
  );
}

function TreeNode({
  node,
  workspaceRoot,
  depth,
  collapsed,
  pinnedNodes,
  pinnedSessionIds,
  activeSessionId,
  activeWorkspaceId,
  matchSession,
  matchNode,
  revealAll,
  onToggle,
  onActivateWorkspace,
  onOpenNodeChat,
  onSelectSession,
  onDeleteSession,
  onToggleSessionPin,
  onNewChat,
  onImportSession,
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
  pinnedSessionIds: string[];
  activeSessionId: string | null;
  activeWorkspaceId: string | null;
  matchSession: (s: SessionSummary) => boolean;
  matchNode: (n: WorkspaceNode) => boolean;
  revealAll?: boolean;
  onToggle: (id: string) => void;
  onActivateWorkspace: (node: WorkspaceNode) => void;
  onOpenNodeChat: (node: WorkspaceNode) => void;
  onSelectSession: (session: SessionSummary, workspaceRoot: WorkspaceNode) => void;
  onDeleteSession: (id: string) => void;
  onToggleSessionPin: (id: string) => void;
  onNewChat: (projectId: string) => void;
  onImportSession: (projectId: string | null) => void;
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
  const menuAnchorRef = useRef<HTMLButtonElement>(null);
  useSidebarMenuShortcuts(
    menuOpen,
    () => { setMenuOpen(false); onNewChat(node.id); },
    () => { setMenuOpen(false); onDeleteNode(node); },
  );
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
          <TreeKindIcon
            kind={node.kind}
            className="shrink-0"
            color={PROJECT_COLOR_HEX[labelColor]}
            title={
              node.kind === 'workspace_root'
                ? '워크스페이스'
                : node.kind === 'folder'
                  ? '폴더'
                  : '프로젝트'
            }
          />
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
            ref={menuAnchorRef}
            type="button"
            className="rounded p-1 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100"
            title="더보기"
            aria-label="더보기"
            onClick={toggleMenu}
          >
            <DotsThree size={14} weight="bold" />
          </button>
          <SidebarMenuPopup open={menuOpen} menuId={menuId} anchorRef={menuAnchorRef} widthClass="w-44">
              <NodeMenuItems
                kind={node.kind}
                labelColor={labelColor}
                pinned={isPinned}
                close={() => setMenuOpen(false)}
                onPickColor={(color) => { setLabelColor(color); onChangeColor(node.id, color); }}
                onImport={() => onImportSession(node.id)}
                onTogglePin={() => onTogglePin(node.id)}
                onRename={() => onRenameNode(node)}
                onSettings={() => openScopeSettings({ kind: node.kind === 'workspace_root' ? 'workspace' : 'project', id: node.id, title: node.title, preferredModel: node.preferred_model, allowedPaths: node.allowed_paths })}
                onMemory={() => openUserMemoryPanel({ projectId: node.id, title: node.title })}
                onDelete={() => onDeleteNode(node)}
                onNewChat={() => onNewChat(node.id)}
                onAddFolder={isContainer ? () => onAddFolder(node.id) : undefined}
              />
          </SidebarMenuPopup>
        </div>
      </div>

      {isOpen ? (
        <div className="ml-[11px] border-l border-line/70 pl-1">
          <SessionPreviewList
            sessions={pinnedFirst((node.sessions ?? []).filter(matchSession), pinnedSessionIds)}
            activeSessionId={activeSessionId}
            indent={pad + 18}
            pinnedSessionIds={pinnedSessionIds}
            revealAll={revealAll}
            onSelect={(session) => onSelectSession(session, workspaceRoot)}
            onDelete={onDeleteSession}
            onTogglePin={onToggleSessionPin}
          />
          {pinnedFirst((node.children ?? []).filter(matchNode), pinnedNodes).map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              workspaceRoot={workspaceRoot}
              depth={depth + 1}
              collapsed={collapsed}
              pinnedNodes={pinnedNodes}
              pinnedSessionIds={pinnedSessionIds}
              activeSessionId={activeSessionId}
              activeWorkspaceId={activeWorkspaceId}
              matchSession={matchSession}
              matchNode={matchNode}
              revealAll={revealAll}
              onToggle={onToggle}
              onActivateWorkspace={onActivateWorkspace}
              onOpenNodeChat={onOpenNodeChat}
              onSelectSession={onSelectSession}
              onDeleteSession={onDeleteSession}
              onToggleSessionPin={onToggleSessionPin}
              onNewChat={onNewChat}
              onImportSession={onImportSession}
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
  preferredModel,
  allowedPaths,
  color,
  pinned,
  sessions,
  pinnedSessionIds,
  collapsed,
  activeSessionId,
  matchSession,
  revealAll,
  onToggle,
  onOpenChat,
  onSelectSession,
  onDeleteSession,
  onToggleSessionPin,
  onNewChat,
  onImportSession,
  onRename,
  onDelete,
  onTogglePin,
  onChangeColor,
}: {
  id: string;
  title: string;
  preferredModel?: string | null;
  allowedPaths?: string[];
  color: ProjectColor;
  pinned: boolean;
  sessions: SessionSummary[];
  pinnedSessionIds: string[];
  collapsed: boolean;
  activeSessionId: string | null;
  matchSession: (s: SessionSummary) => boolean;
  revealAll?: boolean;
  onToggle: () => void;
  onOpenChat: () => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onToggleSessionPin: (id: string) => void;
  onNewChat: () => void;
  onImportSession: () => void;
  onRename: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
  onChangeColor: (color: ProjectColor) => void;
}) {
  const menuId = `project:${id}`;
  const { menuOpen, setMenuOpen, openMenu, toggleMenu } = useExclusiveSidebarMenu(menuId);
  const menuAnchorRef = useRef<HTMLButtonElement>(null);
  const [labelColor, setLabelColor] = useState(color);
  useSidebarMenuShortcuts(
    menuOpen,
    () => { setMenuOpen(false); onNewChat(); },
    () => { setMenuOpen(false); onDelete(); },
  );
  return (
    <div className="mb-0.5" data-sidebar-menu-id={menuId}>
      <div className="group relative flex h-8 items-center gap-0.5 rounded-md px-2 text-[12px] text-muted transition hover:bg-ink hover:text-text" onContextMenu={(event) => { event.preventDefault(); openMenu(); }}>
        <button type="button" className="rounded p-0.5" onClick={onToggle} aria-label={collapsed ? '펼치기' : '접기'}>
          {collapsed ? <CaretRight size={12} /> : <CaretDown size={12} />}
        </button>
        <TreeKindIcon kind="project" color={PROJECT_COLOR_HEX[labelColor]} title="프로젝트" />
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
          <button ref={menuAnchorRef} type="button" className="rounded p-1 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100" title="더보기" onClick={toggleMenu}>
            <DotsThree size={14} weight="bold" />
          </button>
          <SidebarMenuPopup open={menuOpen} menuId={menuId} anchorRef={menuAnchorRef} widthClass="w-44">
              <NodeMenuItems
                kind="project"
                labelColor={labelColor}
                pinned={pinned}
                close={() => setMenuOpen(false)}
                onPickColor={(nextColor) => { setLabelColor(nextColor); onChangeColor(nextColor); }}
                onImport={onImportSession}
                onTogglePin={onTogglePin}
                onRename={onRename}
                onSettings={() => openScopeSettings({ kind: 'project', id, title, preferredModel, allowedPaths })}
                onMemory={() => openUserMemoryPanel({ projectId: id, title })}
                onDelete={onDelete}
                onNewChat={onNewChat}
              />
          </SidebarMenuPopup>
        </div>
      </div>
      {!collapsed ? (
        <SessionPreviewList
          sessions={pinnedFirst(sessions.filter(matchSession), pinnedSessionIds)}
          activeSessionId={activeSessionId}
          indent={28}
          pinnedSessionIds={pinnedSessionIds}
          revealAll={revealAll}
          onSelect={(session) => onSelectSession(session.id)}
          onDelete={onDeleteSession}
          onTogglePin={onToggleSessionPin}
        />
      ) : null}
    </div>
  );
}

function ArchivedSessions({
  sessions,
  activeSessionId,
  matchSession,
  onSelect,
  onDelete,
}: {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  matchSession: (s: SessionSummary) => boolean;
  onSelect: (id: string, projectId: string | null) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const visible = sessions.filter(matchSession);
  if (visible.length === 0) return null;
  return (
    <div className="mt-1 border-t border-line/70 pt-1">
      <button
        type="button"
        className="flex h-8 w-full items-center gap-1 rounded-md px-1 text-[12px] text-muted transition hover:bg-ink hover:text-text"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        title="보관함"
      >
        {open ? <CaretDown size={12} /> : <CaretRight size={12} />}
        <Archive size={14} />
        <span className="font-medium">보관함</span>
        <span className="ml-auto rounded-full bg-ink px-1.5 text-[10px] tabular-nums text-muted">{visible.length}</span>
      </button>
      {open ? (
        <div className="ml-[11px] border-l border-line/70 pl-1">
          {visible.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              active={session.id === activeSessionId}
              indent={20}
              onSelect={() => onSelect(session.id, session.project_id ?? null)}
              onDelete={() => onDelete(session.id)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SessionPreviewList({
  sessions,
  activeSessionId,
  indent,
  pinnedSessionIds,
  revealAll = false,
  onSelect,
  onDelete,
  onTogglePin,
}: {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  indent: number;
  pinnedSessionIds: string[];
  revealAll?: boolean;
  onSelect: (session: SessionSummary) => void;
  onDelete: (id: string) => void;
  onTogglePin: (id: string) => void;
}) {
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const [expanded, setExpanded] = useState(() =>
    Boolean(activeSessionId && sessions.slice(SESSION_PREVIEW_LIMIT).some((session) => session.id === activeSessionId)),
  );

  useEffect(() => {
    if (!activeSessionId) return;
    if (sessionsRef.current.slice(SESSION_PREVIEW_LIMIT).some((session) => session.id === activeSessionId)) {
      setExpanded(true);
    }
  }, [activeSessionId]);

  if (sessions.length === 0) return null;

  const canToggle = !revealAll && sessions.length > SESSION_PREVIEW_LIMIT;
  const showAll = revealAll || expanded || sessions.length <= SESSION_PREVIEW_LIMIT;
  const previewSessions = canToggle ? sessions.slice(0, SESSION_PREVIEW_LIMIT) : sessions;
  const hiddenSessions = canToggle ? sessions.slice(SESSION_PREVIEW_LIMIT) : [];

  const renderRow = (session: SessionSummary) => (
    <SessionRow
      key={session.id}
      session={session}
      active={session.id === activeSessionId}
      indent={indent}
      pinned={pinnedSessionIds.includes(session.id)}
      onTogglePin={() => onTogglePin(session.id)}
      onSelect={() => onSelect(session)}
      onDelete={() => onDelete(session.id)}
    />
  );

  return (
    <>
      {previewSessions.map(renderRow)}
      {canToggle ? (
        <button
          type="button"
          className="mb-0.5 flex h-7 w-full items-center gap-1 rounded-md pr-1 text-[11px] text-muted transition hover:bg-ink hover:text-text"
          style={{ paddingLeft: indent }}
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={showAll}
          aria-label={showAll ? '대화 숨기기' : '숨겨진 대화 펼치기'}
          title={showAll ? '대화 숨기기' : '숨겨진 대화 펼치기'}
        >
          {showAll ? <CaretUp size={12} /> : <CaretRight size={12} />}
          <span className="truncate">{showAll ? '대화 숨기기' : '숨겨진 대화'}</span>
        </button>
      ) : null}
      {canToggle && showAll ? hiddenSessions.map(renderRow) : null}
    </>
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
  const unseen = useWorkspaceStore((s) => Boolean(s.unseenCompletions[session.id]));
  const menuId = `session:${session.id}`;
  const { menuOpen, setMenuOpen, openMenu, toggleMenu } = useExclusiveSidebarMenu(menuId);
  const menuAnchorRef = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const rowActions = useContext(SessionRowActionsContext);
  const ownFileAccess = sessionHasOwnFileAccess(session);
  useSidebarMenuShortcuts(
    menuOpen,
    rowActions && !session.archived
      ? () => { setMenuOpen(false); rowActions.newChat(session.project_id ?? null); }
      : undefined,
    () => { setMenuOpen(false); onDelete(); },
  );
  const beginRename = () => {
    setTitleDraft(session.title || '');
    setEditing(true);
  };
  const commitRename = async () => {
    const next = titleDraft.trim();
    setEditing(false);
    if (!next || next === (session.title || '').trim()) return;
    try {
      await renameSession(session.id, next);
      window.dispatchEvent(new Event('cqr:workspace-tree-changed'));
    } catch {
      // 이름 변경 실패 시 기존 제목 유지
    }
  };
  return (
    <div
      role="button"
      tabIndex={0}
      data-sidebar-menu-id={menuId}
      data-session-nav-id={session.id}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openMenu();
      }}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSelect();
      }}
      className={`group relative mb-0.5 flex min-h-8 cursor-pointer items-center gap-1 rounded-md pr-1 text-xs transition before:absolute before:bottom-1 before:left-0 before:top-1 before:w-0.5 before:rounded ${
        active ? 'bg-selected font-medium text-text before:bg-accent' : 'text-muted before:bg-transparent hover:bg-ink hover:text-text'
      }`}
      aria-current={active ? 'page' : undefined}
      title={session.title || '제목 없음'}
      style={{ paddingLeft: indent }}
    >
      {editing ? (
        <input
          value={titleDraft}
          autoFocus
          onChange={(e) => setTitleDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={() => void commitRename()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') void commitRename();
            if (e.key === 'Escape') setEditing(false);
          }}
          className="min-w-0 flex-1 rounded border border-accent/50 bg-panel px-1 py-0.5 text-[11px] text-text outline-none"
          aria-label="챗 이름 수정"
        />
      ) : (
        <span className={`min-w-0 flex-1 truncate ${unseen && phase !== 'running' ? 'font-semibold text-text' : ''}`}>{session.title || '제목 없음'}</span>
      )}
      {phase === 'running' ? (
        <CircleNotch size={12} weight="bold" aria-label="생성 중" className="shrink-0 animate-spin text-accent" />
      ) : unseen ? (
        <span className="shrink-0 text-[10px] text-emerald-500" title="새 답변 완료" aria-label="새 답변 완료">
          ●
        </span>
      ) : null}
      {ownFileAccess ? (
        <span
          className="shrink-0 text-muted"
          data-testid="session-file-access-badge"
          title={session.allowed_paths?.length ? '이 대화에 허용 경로가 지정됨 · 파일 접근 가능' : '이 대화에 작업폴더가 연결됨 · 파일 접근 가능'}
          aria-label="파일 접근 가능"
        >
          <FolderSimple size={11} weight="fill" />
        </span>
      ) : null}
      {onTogglePin ? (
        <button
          type="button"
          className={`shrink-0 rounded p-0.5 transition ${pinned ? 'text-accent opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
          title={pinned ? '대화 고정 해제' : '이 묶음 상단에 대화 고정'}
          aria-label={pinned ? `${session.title || '세션'} 대화 고정 해제` : `${session.title || '세션'} 이 묶음 상단에 대화 고정`}
          onClick={(event) => { event.stopPropagation(); onTogglePin(); }}
        >
          <PushPin size={11} weight={pinned ? 'fill' : 'regular'} />
        </button>
      ) : null}
      <div className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
        <button
          ref={menuAnchorRef}
          type="button"
          className="rounded p-0.5 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100"
          title="더보기"
          aria-label={`${session.title || '세션'} 더보기`}
          onClick={toggleMenu}
        >
          <DotsThree size={14} weight="bold" />
        </button>
        <SidebarMenuPopup open={menuOpen} menuId={menuId} anchorRef={menuAnchorRef} widthClass="w-48">
            <SessionMenuItems
              session={session}
              pinned={pinned}
              busy={phase === 'running'}
              close={() => setMenuOpen(false)}
              onTogglePin={onTogglePin}
              onRename={beginRename}
              onDelete={onDelete}
            />
        </SidebarMenuPopup>
      </div>
    </div>
  );
}
