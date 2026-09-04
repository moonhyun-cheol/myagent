import {
  CalendarBlank,
  CheckCircle,
  Clock,
  FileText,
  GearSix,
  DownloadSimple,
  ArrowsOut,
  MagnifyingGlass,
  Notebook,
  PencilSimple,
  Robot,
  SidebarSimple,
  type Icon,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import automationSchedulerImage from '../assets/auto_scheduler.png';
import {
  listAutomationFeed,
  listProviders,
  type AutomationFeedItem,
  type ProviderPublic,
} from '../api/myAgentClient';
import { useWorkspaceStore } from '../store/workspaceStore';
import { ErrorReportMenu } from './ErrorReportMenu';
import { AutomationFeedModal } from './AutomationFeedModal';
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
  const [automationFeedOpen, setAutomationFeedOpen] = useState(false);
  const [width, setWidth] = useState(272);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const startNewChat = useWorkspaceStore((state) => state.startNewChat);
  const activeProjectId = useWorkspaceStore((state) => state.activeProjectId);
  const activeWorkspaceProjectId = useWorkspaceStore((state) => state.activeWorkspaceProjectId);

  const refreshProviders = useCallback(async () => {
    try {
      setProviders(await listProviders());
    } catch (err) {
      setBusyMsg(err instanceof Error ? err.message : '모델 목록을 불러오지 못했습니다.');
    }
  }, []);

  useEffect(() => { void refreshProviders(); }, [refreshProviders, settingsOpen]);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (!resizeRef.current) return;
      setWidth(Math.min(560, Math.max(272, resizeRef.current.startWidth + event.clientX - resizeRef.current.startX)));
    };
    const onUp = () => { resizeRef.current = null; document.body.style.cursor = ''; };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  const onNewChat = async () => {
    setBusyMsg('');
    try {
      const projectId = activeProjectId === activeWorkspaceProjectId ? null : activeProjectId;
      await startNewChat(projectId, activeWorkspaceProjectId);
      onSurfaceChange('chat');
    } catch (err) {
      setBusyMsg(err instanceof Error ? err.message : '새 대화를 만들지 못했습니다.');
    }
  };

  const configured = providers.find((provider) => provider.id === 'custom')?.configured ?? false;
  const personalCount = providers.filter(
    (provider) => provider.configured && (['openai', 'anthropic', 'google'].includes(provider.id) || provider.user_defined),
  ).length;

  return (
    <aside
      className={`relative flex h-full shrink-0 border-r border-line bg-panel ${collapsed ? 'w-14' : ''}`}
      style={collapsed ? undefined : { width }}
      data-sidebar-collapsed={collapsed}
    >
      <nav className="flex h-full w-14 shrink-0 flex-col items-center border-r border-line py-2" aria-label="주요 메뉴">
        <DockIcon
          icon={SidebarSimple}
          label={collapsed ? '사이드바 펼치기' : '사이드바 접기'}
          active={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        />
        <DockIcon icon={PencilSimple} label="현재 위치에 새 대화" onClick={() => void onNewChat()} />

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
              <AutomationSidebarSummary unreadCount={automationUnreadCount} onOpenFeed={() => setAutomationFeedOpen(true)} />
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

      {!collapsed ? (
        <button
          type="button"
          aria-label="사이드바 너비 조절"
          title="드래그하여 사이드바 너비 조절"
          className="absolute -right-1.5 top-0 z-20 h-full w-3 cursor-col-resize bg-transparent hover:bg-accent/20 focus:bg-accent/20 focus:outline-none"
          onPointerDown={(event) => {
            event.preventDefault();
            resizeRef.current = { startX: event.clientX, startWidth: width };
            document.body.style.cursor = 'col-resize';
          }}
        />
      ) : null}

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <AutomationFeedModal open={automationFeedOpen} onClose={() => setAutomationFeedOpen(false)} />
    </aside>
  );
}

function AutomationSidebarSummary({ unreadCount, onOpenFeed }: { unreadCount: number; onOpenFeed: () => void }) {
  const [items, setItems] = useState<AutomationFeedItem[]>([]);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let active = true;
    void listAutomationFeed().then((feed) => {
      if (active) setItems(feed);
    }).catch((error: unknown) => {
      if (active) setLoadError(error instanceof Error ? error.message : '자동화 자료를 불러오지 못했습니다.');
    });
    return () => { active = false; };
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-line px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Robot size={14} weight="duotone" className="text-accent" />
            <h2 className="text-[11px] font-semibold text-text">작업 뉴스피드</h2>
          </div>
          {unreadCount > 0 ? (
            <span className="rounded-full bg-red-500 px-1.5 py-0.5 text-[9px] font-bold text-white">{unreadCount}</span>
          ) : null}
          <button
            type="button"
            onClick={onOpenFeed}
            className="ml-auto rounded-md border border-line bg-white/70 p-1.5 text-muted transition hover:border-accent/40 hover:text-accent"
            aria-label="작업 뉴스피드 크게 보기"
            title="크게 보기"
          >
            <ArrowsOut size={13} weight="bold" />
          </button>
        </div>
        <p className="mt-1 text-[10px] leading-4 text-muted">자동화 결과와 생성된 파일을 채팅 형태로 전달합니다.</p>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3" aria-label="자동화 작업 뉴스피드">
        {loadError ? <p className="rounded-lg border border-red-200 bg-red-50 p-2 text-[10px] text-red-700">{loadError}</p> : null}
        {!loadError && items.length === 0 ? <p className="px-1 text-[10px] text-muted">전달된 자동화 자료가 없습니다.</p> : null}
        {items.map((item) => (
          <AutomationFeedMessage
            key={item.id}
            time={formatFeedTime(item.created_at)}
            label={item.kind === 'error' ? '실행 오류' : item.kind === 'status' ? '진행 알림' : '실행 완료'}
            message={item.message}
            attachments={item.attachments}
            error={item.kind === 'error'}
          />
        ))}
      </div>
    </div>
  );
}

function formatFeedTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function isAutomationDownloadPath(value: string | undefined): value is string {
  return typeof value === 'string' && value.startsWith('/outputs/automations/');
}

function AutomationFeedMessage({
  time,
  label,
  message,
  attachments = [],
  error = false,
}: {
  time: string;
  label: string;
  message: string;
  attachments?: AutomationFeedItem['attachments'];
  error?: boolean;
}) {
  return (
    <article className="rounded-xl border border-line bg-white/75 p-2.5 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[9px] font-bold text-white ${error ? 'bg-red-600' : 'bg-emerald-600'}`}>
          {error ? <Clock size={11} /> : <CheckCircle size={11} weight="fill" />}
          {label}
        </span>
        <time className="text-[9px] text-muted">{time}</time>
      </div>
      <p className="mt-1.5 text-[10px] leading-[1.55] text-text/90">{message}</p>
      {attachments.map((attachment) => isAutomationDownloadPath(attachment.path) ? (
        <a
          key={`${attachment.path}:${attachment.name}`}
          href={attachment.path}
          download={attachment.name}
          className="mt-2 flex items-center gap-2 rounded-lg border border-accent/35 bg-accent/5 px-2 py-1.5 transition hover:border-accent hover:bg-accent/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          aria-label={`${attachment.name} 다운로드`}
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent text-white">
            <FileText size={14} weight="bold" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[9px] font-medium text-text">{attachment.name}</p>
            <p className="text-[8px] text-muted">{attachment.mime === 'text/markdown' ? 'Markdown' : attachment.mime ?? '파일'}{attachment.size ? ` · ${Math.max(1, Math.ceil(attachment.size / 1024))} KB` : ''}</p>
          </div>
          <DownloadSimple size={14} className="shrink-0 text-accent" weight="bold" />
        </a>
      ) : null)}
    </article>
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
