import {
  GearSix,
  MagnifyingGlass,
  Notebook,
  PencilSimple,
  SidebarSimple,
  Sparkle,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import {
  listProviders,
  listSkills,
  type ProviderPublic,
  type SkillListItem,
} from '../api/myAgentClient';
import { useWorkspaceStore } from '../store/workspaceStore';
import { ErrorReportMenu } from './ErrorReportMenu';
import { SettingsModal } from './SettingsModal';
import { ProjectsTree } from './ProjectsTree';

type OverlayPanel = 'skills' | null;

export function GeminiNavSidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const [overlay, setOverlay] = useState<OverlayPanel>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [skills, setSkills] = useState<SkillListItem[]>([]);
  const [providers, setProviders] = useState<ProviderPublic[]>([]);
  const [busyMsg, setBusyMsg] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);

  const startNewChat = useWorkspaceStore((state) => state.startNewChat);
  const setSkillMode = useWorkspaceStore((state) => state.setSkillMode);
  const skillMode = useWorkspaceStore((state) => state.skillMode);

  const refreshProviders = useCallback(async () => {
    try {
      setProviders(await listProviders());
    } catch (err) {
      setBusyMsg(err instanceof Error ? err.message : '모델 목록을 불러오지 못했습니다.');
    }
  }, []);

  const refreshSkills = useCallback(async () => {
    try {
      setSkills(await listSkills());
    } catch (err) {
      setBusyMsg(err instanceof Error ? err.message : '스킬 목록을 불러오지 못했습니다.');
    }
  }, []);

  useEffect(() => { void refreshProviders(); }, [refreshProviders, settingsOpen]);
  useEffect(() => { if (overlay === 'skills') void refreshSkills(); }, [overlay, refreshSkills]);

  const onNewChat = async () => {
    setBusyMsg('');
    try {
      await startNewChat(null);
      setOverlay(null);
    } catch (err) {
      setBusyMsg(err instanceof Error ? err.message : '새 세션을 만들지 못했습니다.');
    }
  };

  const configured = providers.find((provider) => provider.id === 'custom')?.configured ?? false;
  const personalCount = providers.filter(
    (provider) => provider.configured && (['openai', 'anthropic', 'google'].includes(provider.id) || provider.user_defined),
  ).length;

  if (collapsed) {
    return (
      <aside className="flex h-full w-14 shrink-0 flex-col items-center border-r border-line bg-panel py-2">
        <DockIcon icon={SidebarSimple} label="사이드바 펼치기" onClick={() => setCollapsed(false)} />
        <DockIcon icon={PencilSimple} label="새 세션" onClick={() => void onNewChat()} />
        <div className="mt-auto flex flex-col items-center gap-1">
          <DockIcon icon={Notebook} label="워크스페이스" onClick={() => { setCollapsed(false); setOverlay(null); }} />
          <DockIcon icon={Sparkle} label="AI 모델 및 스킬" onClick={() => { setCollapsed(false); setOverlay('skills'); }} />
          <DockIcon icon={GearSix} label="설정" onClick={() => setSettingsOpen(true)} />
        </div>
        <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-[272px] shrink-0 flex-col border-r border-line bg-panel">
      <header className="shrink-0 px-2.5 pb-2 pt-2.5">
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => void onNewChat()} className="flex min-w-0 flex-1 items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[12px] font-semibold text-white transition hover:brightness-105">
            <PencilSimple size={15} weight="bold" />
            새 세션
          </button>
          <DockIcon icon={MagnifyingGlass} label="워크스페이스 검색" active={searchOpen} onClick={() => { setOverlay(null); setSearchOpen((value) => !value); }} />
        </div>
        {searchOpen ? (
          <div className="relative mt-2">
            <MagnifyingGlass className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" size={13} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="프로젝트 또는 세션 검색" className="w-full rounded-lg border border-line bg-ink py-1.5 pl-8 pr-2.5 text-[11px] text-text outline-none transition focus:border-accent" autoFocus />
          </div>
        ) : null}
      </header>

      {busyMsg ? <p className="mx-2.5 mb-1 truncate rounded-md bg-ink px-2 py-1 text-[10px] text-muted" title={busyMsg}>{busyMsg}</p> : null}

      <div className="min-h-0 flex-1 overflow-hidden border-t border-line">
        {overlay === 'skills' ? (
          <div className="h-full overflow-y-auto p-2.5">
            <div className="mb-2 flex items-center justify-between px-1">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">AI 모델 및 스킬</p>
              <button type="button" onClick={() => setOverlay(null)} className="text-[10px] text-muted hover:text-text">워크스페이스</button>
            </div>
            <div className="space-y-1.5">
              {skills.map((skill) => (
                <button key={skill.id} type="button" onClick={() => setSkillMode(skill.mode, skill.label)} className={`w-full rounded-lg border px-2.5 py-2 text-left transition ${skillMode === skill.mode ? 'border-accent/50 bg-accent/10' : 'border-line bg-ink/45 hover:bg-ink'}`}>
                  <span className="block truncate text-[12px] font-medium text-text">{skill.label}</span>
                  <span className="mt-0.5 block truncate text-[10px] text-muted">{skill.mode} · {skill.source === 'bundled' ? '기본' : '사용자'}</span>
                </button>
              ))}
            </div>
          </div>
        ) : <ProjectsTree query={query} onMessage={setBusyMsg} />}
      </div>

      <button type="button" onClick={() => setSettingsOpen(true)} className="mx-2 mb-1 flex h-8 shrink-0 items-center gap-2 rounded-lg border border-line bg-ink/35 px-2.5 text-left transition hover:border-accent/40 hover:bg-accent/5" title="프로바이더 설정 열기">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${configured ? 'bg-emerald-400' : 'bg-muted/50'}`} />
        <span className="min-w-0 flex-1 truncate text-[10px] font-medium text-text">MY OpenRouter · {configured ? '연결됨' : '설정 필요'}</span>
        <span className="shrink-0 rounded bg-panel-2 px-1.5 py-0.5 text-[9px] text-muted">개인 {personalCount}</span>
      </button>

      <footer className="flex shrink-0 items-center justify-around border-t border-line px-1.5 py-1.5">
        <DockIcon icon={SidebarSimple} label="사이드바 접기" onClick={() => setCollapsed(true)} />
        <DockIcon icon={Notebook} label="워크스페이스" active={overlay === null} onClick={() => setOverlay(null)} />
        <DockIcon icon={Sparkle} label="AI 모델 및 스킬" active={overlay === 'skills'} onClick={() => setOverlay(overlay === 'skills' ? null : 'skills')} />
        <DockIcon icon={GearSix} label="설정" active={settingsOpen} onClick={() => setSettingsOpen(true)} />
        <span title="메시지 및 오류 보고"><ErrorReportMenu compact /></span>
      </footer>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </aside>
  );
}

function DockIcon({ icon: Icon, label, active, onClick }: {
  icon: typeof PencilSimple;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" title={label} aria-label={label} aria-pressed={active} onClick={onClick} className={`rounded-lg p-1.5 transition ${active ? 'bg-accent/10 text-accent' : 'text-muted hover:bg-ink hover:text-text'}`}>
      <Icon size={16} weight={active ? 'bold' : 'regular'} />
    </button>
  );
}
