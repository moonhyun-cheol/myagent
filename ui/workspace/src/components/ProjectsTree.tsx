import {
  CaretDown,
  CaretRight,
  ChatTeardropText,
  FolderPlus,
  FolderSimple,
  Plus,
  Trash,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import {
  createProject,
  deleteProject,
  deleteSession,
  fetchWorkspaceTree,
  getStoredSessionId,
  setDevWorkspace,
  type SessionSummary,
  type WorkspaceNode,
  type WorkspaceTreePayload,
} from '../api/myAgentClient';
import { useWorkspaceStore } from '../store/workspaceStore';
import { confirmDialog, promptDialog } from '../lib/confirmDialog';
import { FolderBrowserModal } from './FolderBrowserModal';

const COLLAPSED_KEY = 'my-agent-workspace-collapsed-nodes';
const LEGACY_COLLAPSED_KEY = 'cqr-workspace-collapsed-nodes';

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

  return (
    <div className={embedded ? "border-t border-line" : "flex h-full min-h-0 flex-col"}>
      <div className="space-y-1 border-b border-line px-3 py-2">
        <p className="text-[11px] font-medium tracking-wide text-muted">작업 단위</p>
        <button
          type="button"
          onClick={() => setBrowseOpen(true)}
          className="flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-[12px] text-muted hover:bg-ink hover:text-text"
        >
          <FolderPlus size={15} />
          + 작업 폴더 추가
        </button>
        <button
          type="button"
          onClick={() => void onNewProject()}
          className="flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-[12px] text-muted hover:bg-ink hover:text-text"
        >
          <Plus size={15} />
          + 새 프로젝트
        </button>
      </div>

      <div className={embedded ? "px-2 py-2" : "min-h-0 flex-1 overflow-y-auto px-2 py-2"}>
        {(tree?.workspace_trees ?? []).filter(matchNode).map((root) => (
          <TreeNode
            key={root.id}
            node={root}
            workspaceRoot={root}
            depth={0}
            collapsed={collapsed}
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
            onDeleteNode={(n) => void onDeleteNode(n)}
          />
        ))}

        {(tree?.projects ?? []).length > 0 ? (
          <>
            <p className="mt-3 px-2 text-[11px] font-medium tracking-wide text-muted">프로젝트</p>
            {tree!.projects
              .filter((p) => !q || p.title.toLowerCase().includes(q) || p.sessions.some(matchSession))
              .map((p) => (
                <ProjectBlock
                  key={p.id}
                  id={p.id}
                  title={p.title}
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
                  onDelete={() =>
                    void deleteProject(p.id).then(refresh).catch((err) => {
                      onMessage?.(err instanceof Error ? err.message : '삭제 실패');
                    })
                  }
                />
              ))}
          </>
        ) : null}

        {(tree?.workspace_trees?.length ?? 0) === 0 && (tree?.projects?.length ?? 0) === 0 ? (
          <p className="px-2 py-4 text-[11px] text-muted">
            작업 폴더나 프로젝트를 추가하면 여기에 표시됩니다.
          </p>
        ) : null}
      </div>

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
  onDeleteNode,
}: {
  node: WorkspaceNode;
  workspaceRoot: WorkspaceNode;
  depth: number;
  collapsed: Set<string>;
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
  onDeleteNode: (node: WorkspaceNode) => void;
}) {
  const isOpen = !collapsed.has(node.id);
  const isContainer = node.kind === 'workspace_root' || node.kind === 'folder';
  const isActiveRoot = node.kind === 'workspace_root' && node.id === activeWorkspaceId;
  const pad = 8 + depth * 10;

  return (
    <div className="mb-0.5">
      <div
        className={`group flex items-center gap-0.5 rounded-xl py-1.5 pr-1 text-[12px] ${
          isActiveRoot ? 'bg-accent/10 text-accent' : 'text-muted hover:bg-ink hover:text-text'
        }`}
        style={{ paddingLeft: pad }}
      >
        <button
          type="button"
          className="rounded p-0.5"
          onClick={() => onToggle(node.id)}
          aria-label={isOpen ? '접기' : '펼치기'}
        >
          {isOpen ? <CaretDown size={12} /> : <CaretRight size={12} />}
        </button>
        <FolderSimple size={14} className="shrink-0" weight={isActiveRoot ? 'fill' : 'regular'} />
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left font-medium"
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
          className="rounded p-0.5 opacity-0 group-hover:opacity-100"
          title="이 위치에 새 채팅"
          onClick={() => onNewChat(node.id)}
        >
          <ChatTeardropText size={13} />
        </button>
        {isContainer ? (
          <button
            type="button"
            className="rounded p-0.5 opacity-0 group-hover:opacity-100"
            title="하위 폴더 추가"
            onClick={() => onAddFolder(node.id)}
          >
            <FolderPlus size={13} />
          </button>
        ) : null}
        <button
          type="button"
          className="rounded p-0.5 opacity-0 group-hover:opacity-100 hover:text-red-400"
          title="삭제"
          onClick={() => onDeleteNode(node)}
        >
          <Trash size={12} />
        </button>
      </div>

      {isOpen ? (
        <div>
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
          {(node.children ?? []).filter(matchNode).map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              workspaceRoot={workspaceRoot}
              depth={depth + 1}
              collapsed={collapsed}
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
              onDeleteNode={onDeleteNode}
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
  sessions,
  collapsed,
  activeSessionId,
  matchSession,
  onToggle,
  onOpenChat,
  onSelectSession,
  onDeleteSession,
  onNewChat,
  onDelete,
}: {
  id: string;
  title: string;
  sessions: SessionSummary[];
  collapsed: boolean;
  activeSessionId: string | null;
  matchSession: (s: SessionSummary) => boolean;
  onToggle: () => void;
  onOpenChat: () => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onNewChat: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="mb-0.5">
      <div className="group flex items-center gap-0.5 rounded-xl px-2 py-1.5 text-[12px] text-muted hover:bg-ink hover:text-text">
        <button type="button" className="rounded p-0.5" onClick={onToggle} aria-label={collapsed ? '펼치기' : '접기'}>
          {collapsed ? <CaretRight size={12} /> : <CaretDown size={12} />}
        </button>
        <FolderSimple size={14} />
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
          className="rounded p-0.5 opacity-0 group-hover:opacity-100"
          title="프로젝트에 새 채팅"
          onClick={onNewChat}
        >
          <ChatTeardropText size={13} />
        </button>
        <button
          type="button"
          className="rounded p-0.5 opacity-0 group-hover:opacity-100 hover:text-red-400"
          title="삭제"
          onClick={onDelete}
        >
          <Trash size={12} />
        </button>
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
  onSelect,
  onDelete,
}: {
  session: SessionSummary;
  active: boolean;
  indent?: number;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const phase = useWorkspaceStore((s) => s.sessionPhases[session.id]);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSelect();
      }}
      className={`group mb-0.5 flex cursor-pointer items-center gap-1 rounded-xl py-1.5 pr-1 text-[12px] ${
        active ? 'bg-line/70 text-text' : 'text-muted hover:bg-ink hover:text-text'
      }`}
      style={{ paddingLeft: indent }}
    >
      <span className="min-w-0 flex-1 truncate">{session.title || '제목 없음'}</span>
      {phase === 'running' ? (
        <span className="shrink-0 text-[9px] text-accent" title="생성 중">
          ●
        </span>
      ) : null}
      <button
        type="button"
        className="shrink-0 rounded p-0.5 opacity-0 hover:text-red-400 group-hover:opacity-100"
        title="삭제"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        <Trash size={12} />
      </button>
    </div>
  );
}
