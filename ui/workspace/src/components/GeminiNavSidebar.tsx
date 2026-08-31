import {
  CalendarBlank,
  GearSix,
  MagnifyingGlass,
  Notebook,
  PencilSimple,
  SidebarSimple,
  type Icon,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import automationSchedulerImage from '../assets/auto_scheduler.png';
import { listProviders, type ProviderPublic } from '../api/myAgentClient';
import { useWorkspaceStore } from '../store/workspaceStore';
import { ErrorReportMenu } from './ErrorReportMenu';
import { SettingsModal } from './SettingsModal';
import { ProjectsTree } from './ProjectsTree';


export type AppSurface = 'chat' | 'scheduler';

interface GeminiNavSidebarProps {
  activeSurface: AppSurface;
  onSurfaceChange: (surface: AppSurface) => void;
  automationUnreadCount?: number;
}

export function GeminiNavSidebar({
  activeSurface,
  onSurfaceChange,
  automationUnreadCount = 0,
}: GeminiNavSidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [providers, setProviders] = useState<ProviderPublic[]>([]);
  const [busyMsg, setBusyMsg] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);

  const startNewChat = useWorkspaceStore((state) => state.startNewChat);

  const refreshProviders = useCallback(async () => {
    try {
      setProviders(await listProviders());
    } catch (err) {
      setBusyMsg(err instanceof Error ? err.message : '모델 목록을 불러오지 못했습니다.');
    }
  }, []);

  useEffect(() => { void refreshProviders(); }, [refreshProviders, settingsOpen]);

  const onNewChat = async () => {
    setBusyMsg('');
    try {
      await startNewChat(null);
      onSurfaceChange('chat');
    } catch (err) {
      setBusyMsg(err instanceof Error ? err.message : '새 세션을 만들지 못했습니다.');
    }
  };

  const configured = providers.find((provider) => provider.id === 'custom')?.configured ?? false;
  const personalCount = providers.filter(
    (provider) => provider.configured && (['openai', 'anthropic', 'google'].includes(provider.id) || provider.user_defined),
  ).length;

  return (
    <aside
      className={`flex h-full shrink-0 border-r border-line bg-panel transition-[width] duration-150 ${
        collapsed ? 'w-14' : 'w-[272px]'
      }`}
      data-sidebar-collapsed={collapsed}
    >
      <nav className="flex h-full w-14 shrink-0 flex-col items-center border-r border-line py-2" aria-label="주요 메뉴">
        <DockIcon
          icon={SidebarSimple}
          label={collapsed ? '사이드바 펼치기' : '사이드바 접기'}
          active={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        />
        <DockIcon icon={PencilSimple} label="새 세션" onClick={() => void onNewChat()} />

        <div className="mt-auto flex flex-col items-center gap-1">
          <DockIcon
            icon={Notebook}
            label="워크스페이스"
            active={activeSurface === 'chat'}
            onClick={() => onSurfaceChange('chat')}
          />
          <DockIcon
            icon={CalendarBlank}
            imageSrc={automationSchedulerImage}
            label="자동화"
            active={activeSurface === 'scheduler'}
            badgeCount={automationUnreadCount}
              onClick={() => onSurfaceChange('scheduler')}
          />
          <DockIcon
            icon={GearSix}
            label="설정"
            active={settingsOpen}
            onClick={() => setSettingsOpen(true)}
          />
          <span title="메시지 및 오류 보고"><ErrorReportMenu compact /></span>
        </div>
      </nav>

      {!collapsed ? (
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="shrink-0 px-3 pb-2 pt-3">
            <div className="flex h-8 items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                {activeSurface === 'chat'
                  ? <Notebook size={15} className="shrink-0 text-accent" />
                  : <img src={automationSchedulerImage} alt="" className="h-[15px] w-[15px] rounded-sm object-cover" />}
                <p className="truncate text-xs font-semibold text-text">
                  {activeSurface === 'chat' ? '워크스페이스' : '자동화'}
                </p>
              </div>
              {activeSurface === 'chat' ? (
                <button
                  type="button"
                  onClick={() => setSearchOpen((value) => !value)}
                  className={`rounded-lg p-1.5 transition ${searchOpen ? 'bg-accent/10 text-accent' : 'text-muted hover:bg-ink hover:text-text'}`}
                  aria-label="워크스페이스 검색"
                  aria-pressed={searchOpen}
                >
                  <MagnifyingGlass size={14} />
                </button>
              ) : null}
            </div>
            {activeSurface === 'chat' && searchOpen ? (
              <div className="relative mt-2">
                <MagnifyingGlass className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" size={13} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="프로젝트 또는 세션 검색"
                  className="w-full rounded-lg border border-line bg-ink py-1.5 pl-8 pr-2.5 text-[11px] text-text outline-none transition focus:border-accent"
                  autoFocus
                />
              </div>
            ) : null}
          </header>

          {busyMsg ? <p className="mx-2.5 mb-1 truncate rounded-md bg-ink px-2 py-1 text-[10px] text-muted" title={busyMsg}>{busyMsg}</p> : null}

          <div className="min-h-0 flex-1 overflow-hidden border-t border-line">
            {activeSurface === 'chat' ? (
              <ProjectsTree query={query} onMessage={setBusyMsg} />
            ) : (
              <AutomationSidebarSummary unreadCount={automationUnreadCount} />
            )}
          </div>

          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="mx-2 mb-2 flex h-8 shrink-0 items-center gap-2 rounded-lg border border-line bg-ink/35 px-2.5 text-left transition hover:border-accent/40 hover:bg-accent/5"
            title="프로바이더 설정 열기"
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${configured ? 'bg-emerald-400' : 'bg-muted/50'}`} />
            <span className="min-w-0 flex-1 truncate text-[10px] font-medium text-text">MY OpenRouter · {configured ? '연결됨' : '설정 필요'}</span>
            <span className="shrink-0 rounded bg-panel-2 px-1.5 py-0.5 text-[9px] text-muted">개인 {personalCount}</span>
          </button>
        </div>
      ) : null}

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </aside>
  );
}

function AutomationSidebarSummary({ unreadCount }: { unreadCount: number }) {
  return (
    <div className="flex h-full flex-col px-3 py-4">
      <p className="text-[11px] leading-5 text-muted">
        일정과 독립 실행 기록을 관리합니다. 자동화 실행은 일반 채팅 목록에 표시되지 않습니다.
      </p>
      <div className="mt-4 rounded-lg border border-line bg-ink/35 px-3 py-2.5">
        <p className="text-[10px] uppercase tracking-[0.08em] text-muted">확인할 알림</p>
        <p className="mt-1 text-lg font-semibold text-text">{unreadCount}</p>
      </div>
    </div>
  );
}

function DockIcon({ icon: IconComponent, imageSrc, label, active, badgeCount = 0, onClick }: {
  icon: Icon;
  imageSrc?: string;
  label: string;
  active?: boolean;
  badgeCount?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={badgeCount > 0 ? `${label}, 읽지 않은 알림 ${badgeCount}개` : label}
      aria-pressed={active}
      onClick={onClick}
      className={`relative rounded-lg p-1.5 transition ${active ? 'bg-accent/10 text-accent' : 'text-muted hover:bg-ink hover:text-text'}`}
    >
      {imageSrc ? (
        <img src={imageSrc} alt="" className="h-4 w-4 object-contain" />
      ) : (
        <IconComponent size={16} weight={active ? 'bold' : 'regular'} />
      )}
      {badgeCount > 0 ? (
        <span className="absolute -right-1.5 -top-1.5 flex min-h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold leading-none text-white">
          {badgeCount > 99 ? '99+' : badgeCount}
        </span>
      ) : null}
    </button>
  );
}
