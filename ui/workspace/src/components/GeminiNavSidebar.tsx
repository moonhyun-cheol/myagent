import {
  GearSix,
  MagnifyingGlass,
  Notebook,
  PencilSimple,
  PushPin,
  SidebarSimple,
  Sparkle,
  Trash,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
  deleteSession,
  getPinnedSessionIds,
  getStoredSessionId,
  listProviders,
  listSessions,
  listSkills,
  setPinnedSessionIds,
  type ProviderPublic,
  type SessionSummary,
  type SkillListItem,
} from '../api/myAgentClient';
import { useWorkspaceStore } from '../store/workspaceStore';
import { confirmDialog } from '../lib/confirmDialog';
import { ErrorReportMenu } from './ErrorReportMenu';
import { SettingsModal } from './SettingsModal';
import { ProjectsTree } from './ProjectsTree';

type OverlayPanel = 'skills' | 'workspace' | null;

function sortSessions(list: SessionSummary[], pinned: string[]): SessionSummary[] {
  const pinSet = new Set(pinned);
  return [...list].sort((a, b) => {
    const ap = pinSet.has(a.id) ? 1 : 0;
    const bp = pinSet.has(b.id) ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return String(b.updated_at).localeCompare(String(a.updated_at));
  });
}

export function GeminiNavSidebar() {
  const [collapsed, setCollapsed] = useState(false);
  /** Skills / workspace overlays. null이면 대화 목록. */
  const [overlay, setOverlay] = useState<OverlayPanel>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [pinned, setPinned] = useState<string[]>(() => getPinnedSessionIds());
  const [query, setQuery] = useState('');
  const [skills, setSkills] = useState<SkillListItem[]>([]);
  const [providers, setProviders] = useState<ProviderPublic[]>([]);
  const [busyMsg, setBusyMsg] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);

  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const startNewChat = useWorkspaceStore((s) => s.startNewChat);
  const clearActiveChat = useWorkspaceStore((s) => s.clearActiveChat);
  const loadChatSession = useWorkspaceStore((s) => s.loadChatSession);
  const setSkillMode = useWorkspaceStore((s) => s.setSkillMode);
  const skillMode = useWorkspaceStore((s) => s.skillMode);
  const sessionPhases = useWorkspaceStore((s) => s.sessionPhases);

  const showChatHome = overlay === null;
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  const openOverlay = (next: OverlayPanel) => {
    setOverlay(next);
    setSearchOpen(false);
  };

  const toggleOverlay = (next: OverlayPanel) => {
    if (overlay === next) {
      backToChats();
      return;
    }
    openOverlay(next);
  };

  const backToChats = () => {
    setOverlay(null);
  };

  const toggleSearch = () => {
    setOverlay(null);
    setSearchOpen((v) => !v);
  };

  const refreshSessions = useCallback(async () => {
    try {
      // Main「채팅」list: standalone only. Project chats stay under notebook folders.
      const list = (await listSessions()).filter((s) => !s.project_id);
      setSessions(list);
    } catch (err) {
      setBusyMsg(err instanceof Error ? err.message : '세션 목록 실패');
    }
  }, []);

  const refreshSkills = useCallback(async () => {
    try {
      setSkills(await listSkills());
    } catch (err) {
      setBusyMsg(err instanceof Error ? err.message : '스킬 목록 실패');
    }
  }, []);

  const refreshProviders = useCallback(async () => {
    try {
      setProviders(await listProviders());
    } catch (err) {
      setBusyMsg(err instanceof Error ? err.message : '모델 목록 실패');
    }
  }, []);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions, activeSessionId]);

  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders, settingsOpen]);

  useEffect(() => {
    if (overlay === 'skills') void refreshSkills();
  }, [overlay, refreshSkills]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = sortSessions(sessions, pinned);
    if (!q) return base;
    return base.filter((s) => (s.title || s.id).toLowerCase().includes(q));
  }, [sessions, pinned, query]);

  const pinnedSessions = useMemo(
    () => filtered.filter((s) => pinned.includes(s.id)),
    [filtered, pinned],
  );
  const otherSessions = useMemo(
    () => filtered.filter((s) => !pinned.includes(s.id)),
    [filtered, pinned],
  );

  const togglePin = (id: string) => {
    const next = pinned.includes(id) ? pinned.filter((x) => x !== id) : [id, ...pinned];
    setPinned(next);
    setPinnedSessionIds(next);
  };

  /** Top-level「새 채팅」은 항상 독립(standalone) 세션. 프로젝트 채팅은 노트북 트리에서만 생성. */
  const onNewChat = async () => {
    setBusyMsg('');
    try {
      await startNewChat(null);
      backToChats();
      await refreshSessions();
    } catch (err) {
      setBusyMsg(err instanceof Error ? err.message : '새 채팅 실패');
    }
  };

  const onSelectSession = async (id: string) => {
    setBusyMsg('');
    try {
      await loadChatSession(id);
      backToChats();
    } catch (err) {
      setBusyMsg(err instanceof Error ? err.message : '세션 로드 실패');
    }
  };

  const onDeleteSession = async (id: string, e: ReactMouseEvent) => {
    e.stopPropagation();
    const ok = await confirmDialog({
      title: '대화 삭제',
      message: '이 대화를 삭제할까요?',
      danger: true,
      confirmLabel: '삭제',
    });
    if (!ok) return;
    try {
      await deleteSession(id);
      if (pinned.includes(id)) {
        const nextPins = pinned.filter((x) => x !== id);
        setPinned(nextPins);
        setPinnedSessionIds(nextPins);
      }
      if (activeSessionId === id || getStoredSessionId() === id) {
        clearActiveChat();
      }
      await refreshSessions();
    } catch (err) {
      setBusyMsg(err instanceof Error ? err.message : '삭제 실패');
    }
  };

  if (collapsed) {
    return (
      <aside className="flex h-full w-14 flex-col items-center gap-1 border-r border-line bg-panel py-2">
        <DockIcon
          icon={SidebarSimple}
          label="사이드바 펼치기"
          onClick={() => setCollapsed(false)}
        />
        <DockIcon icon={PencilSimple} label="새 채팅" onClick={() => void onNewChat()} />
        <div className="mt-auto flex flex-col items-center gap-1">
          <DockIcon
            icon={Notebook}
            label="작업 단위"
            onClick={() => {
              setCollapsed(false);
              toggleOverlay('workspace');
            }}
          />
          <DockIcon
            icon={Sparkle}
            label="스킬"
            onClick={() => {
              setCollapsed(false);
              toggleOverlay('skills');
            }}
          />
          <DockIcon
            icon={GearSix}
            label="설정"
            onClick={() => {
              setSettingsOpen(true);
            }}
          />
        </div>
        <SettingsModal open={settingsOpen} onClose={closeSettings} />
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-[260px] shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex items-center gap-1 px-2 py-2">
        <DockIcon icon={SidebarSimple} label="사이드바 접기" onClick={() => setCollapsed(true)} />
        <button
          type="button"
          onClick={() => void onNewChat()}
          className="min-w-0 flex-1 rounded-lg px-2 py-1.5 text-left text-[13px] font-medium text-text hover:bg-ink"
        >
          새 채팅
        </button>
        <DockIcon
          icon={MagnifyingGlass}
          label="채팅 검색"
          active={showChatHome && searchOpen}
          onClick={toggleSearch}
        />
      </div>

      {busyMsg ? (
        <p className="mx-2 mb-1 truncate rounded-md bg-ink px-2 py-1 text-[10px] text-muted" title={busyMsg}>
          {busyMsg}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-t border-line">
        {overlay ? (
          <button
            type="button"
            onClick={backToChats}
            className="shrink-0 border-b border-line px-3 py-1.5 text-left text-[11px] text-muted hover:text-text"
          >
            채팅 목록
          </button>
        ) : null}
        <div className="min-h-0 flex-1 overflow-hidden">
        {showChatHome ? (
          <div className="flex h-full min-h-0 flex-col">
            {searchOpen ? (
              <div className="shrink-0 border-b border-line px-3 py-2">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="대화 검색…"
                  className="w-full rounded-lg border border-line bg-ink px-2.5 py-1.5 text-xs text-text outline-none focus:border-accent"
                  autoFocus
                />
              </div>
            ) : null}

            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="px-2 pb-2">
              {pinnedSessions.length > 0 ? (
                <>
                  <p className="px-2 pb-1 pt-3 text-[11px] font-medium tracking-wide text-muted">고정</p>
                  {pinnedSessions.map((s) => (
                    <SessionRow
                      key={s.id}
                      session={s}
                      active={s.id === activeSessionId}
                      pinned
                      phase={sessionPhases[s.id]}
                      onSelect={() => void onSelectSession(s.id)}
                      onTogglePin={() => togglePin(s.id)}
                      onDelete={(e) => void onDeleteSession(s.id, e)}
                    />
                  ))}
                </>
              ) : null}

              <p className="border-b border-line px-2 pb-2 pt-2 text-[11px] font-medium tracking-wide text-muted">채팅 목록</p>
              {otherSessions.length === 0 && pinnedSessions.length === 0 ? (
                <p className="px-2 py-4 text-xs text-muted">대화 없음 · 새 채팅</p>
              ) : otherSessions.length === 0 ? (
                <p className="px-2 py-2 text-[11px] text-muted">고정된 대화 없음</p>
              ) : (
                otherSessions.map((s) => (
                  <SessionRow
                    key={s.id}
                    session={s}
                    active={s.id === activeSessionId}
                    pinned={false}
                    phase={sessionPhases[s.id]}
                    onSelect={() => void onSelectSession(s.id)}
                    onTogglePin={() => togglePin(s.id)}
                    onDelete={(e) => void onDeleteSession(s.id, e)}
                  />
                ))
              )}
              </div>

              <ProjectsTree embedded query={query} onMessage={setBusyMsg} onChatOpened={backToChats} />
            </div>
          </div>
        ) : null}

        {overlay === 'skills' ? (
          <div className="flex h-full min-h-0 flex-col overflow-y-auto p-3">
            <div className="mb-2 flex items-center justify-between">
              <div>
                <p className="text-[11px] font-medium tracking-wide text-muted">스킬 선택</p>
                <p className="mt-0.5 text-[10px] text-muted">추가·제거는 설정 &gt; 스킬</p>
              </div>
            </div>

            <div className="space-y-1.5">
              {skills.map((s) => (
                <div key={`${s.source}:${s.id}`} className="rounded-xl border border-line bg-ink/60 p-2.5">
                  <div className="mb-1.5 flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-text">{s.label}</p>
                      <p className="truncate text-[10px] text-muted">{s.mode}</p>
                    </div>
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] ${
                        s.source === 'bundled'
                          ? 'bg-line text-muted'
                          : s.source === 'organization'
                            ? 'bg-accent/15 text-accent'
                            : 'bg-accent/15 text-accent'
                      }`}
                    >
                      {s.source === 'bundled' ? '번들' : s.source === 'organization' ? '조직' : '사용자'}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <button
                      type="button"
                      className={`rounded-md px-2 py-1 text-[10px] ${
                        skillMode === s.mode
                          ? 'bg-accent text-ink'
                          : 'border border-line text-muted hover:text-text'
                      }`}
                      onClick={() => setSkillMode(s.mode, s.label)}
                    >
                      사용
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {overlay === 'workspace' ? (
          <div className="h-full min-h-0">
            <ProjectsTree onMessage={setBusyMsg} onChatOpened={backToChats} />
          </div>
        ) : null}
        </div>
      </div>

      <button
        type="button"
        onClick={() => setSettingsOpen(true)}
        className="mx-2 mb-2 rounded-xl border border-line bg-ink/45 px-3 py-2.5 text-left hover:border-accent/40 hover:bg-accent/5"
      >
        <span className="flex items-center justify-between gap-2">
          <span className="min-w-0">
            <span className="block truncate text-[11px] font-medium text-text">MY OpenRouter</span>
            <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted">
              <span className={`h-1.5 w-1.5 rounded-full ${providers.find((p) => p.id === 'custom')?.configured ? 'bg-emerald-400' : 'bg-muted/50'}`} />
              {providers.find((p) => p.id === 'custom')?.configured ? '연결됨' : '설정 필요'}
            </span>
          </span>
          <span className="shrink-0 rounded-md bg-panel-2 px-2 py-1 text-[9px] text-muted">
            개인 {providers.filter((p) => p.configured && (['openai', 'anthropic', 'google'].includes(p.id) || p.user_defined)).length}
          </span>
        </span>
      </button>

      <div className="flex items-center justify-between gap-0.5 border-t border-line px-1.5 py-1.5">
        <DockIcon
          icon={Notebook}
          label="작업 단위"
          active={overlay === 'workspace'}
          onClick={() => toggleOverlay('workspace')}
        />
        <DockIcon
          icon={Sparkle}
          label="스킬"
          active={overlay === 'skills'}
          onClick={() => toggleOverlay('skills')}
        />
        <DockIcon
          icon={GearSix}
          label="설정"
          active={settingsOpen}
          onClick={() => setSettingsOpen(true)}
        />
        <ErrorReportMenu compact />
      </div>
      <SettingsModal open={settingsOpen} onClose={closeSettings} />
    </aside>
  );
}

function SessionRow({
  session,
  active,
  pinned,
  phase,
  onSelect,
  onTogglePin,
  onDelete,
}: {
  session: SessionSummary;
  active: boolean;
  pinned: boolean;
  phase?: 'running';
  onSelect: () => void;
  onTogglePin: () => void;
  onDelete: (e: ReactMouseEvent) => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSelect();
      }}
      className={`group mb-0.5 flex cursor-pointer items-center gap-1 rounded-xl px-2.5 py-2 text-left text-[13px] transition ${
        active ? 'bg-line/70 text-text' : 'text-muted hover:bg-ink hover:text-text'
      }`}
    >
      {pinned ? <PushPin size={12} weight="fill" className="shrink-0 text-accent" /> : null}
      <span className="min-w-0 flex-1 truncate">{session.title || '제목 없음'}</span>
      {phase === 'running' ? (
        <span className="shrink-0 text-[9px] text-accent" title="생성 중">
          ●
        </span>
      ) : null}
      <button
        type="button"
        className={`shrink-0 rounded p-0.5 transition ${
          pinned
            ? 'text-accent opacity-100'
            : 'text-muted opacity-0 group-hover:opacity-100 hover:text-text'
        }`}
        title={pinned ? '고정 해제' : '고정'}
        onClick={(e) => {
          e.stopPropagation();
          onTogglePin();
        }}
      >
        <PushPin size={13} weight={pinned ? 'fill' : 'regular'} />
      </button>
      <button
        type="button"
        className="shrink-0 rounded p-0.5 text-muted opacity-0 transition hover:text-red-400 group-hover:opacity-100"
        title="삭제"
        onClick={onDelete}
      >
        <Trash size={13} />
      </button>
    </div>
  );
}

function DockIcon({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: typeof PencilSimple;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-lg p-1.5 transition ${
        active ? 'bg-line/70 text-text' : 'text-muted hover:bg-ink hover:text-text'
      }`}
    >
      <Icon size={16} weight={active ? 'bold' : 'regular'} />
    </button>
  );
}
