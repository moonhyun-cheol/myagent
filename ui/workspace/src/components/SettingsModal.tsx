import {
  FolderSimple,
  GearSix,
  MagnifyingGlass,
  Plugs,
  PuzzlePiece,
  Robot,
  Stack,
  X,
  type Icon,
} from '@phosphor-icons/react';
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { useWorkspaceStore } from '../store/workspaceStore';
import { ModelManagementModal } from './ModelManagementModal';
import { SettingsAgentPage } from './SettingsAgentPage';
import { SettingsGeneralPage } from './SettingsGeneralPage';
import { SettingsMcpPage } from './SettingsMcpPage';
import { SettingsPluginsPage } from './SettingsPluginsPage';
import { SettingsSkillsPage } from './SettingsSkillsPage';
import { SettingsWorkspacePage } from './SettingsWorkspacePage';

interface SettingsSectionProps {
  readOnly: boolean;
  onWorkspaceChanged?: (root: string | null) => void;
  onSectionChange: (id: string) => void;
}

interface SettingsSectionDef {
  id: string;
  group: string;
  label: string;
  icon: Icon;
  keywords: string[];
  render: (props: SettingsSectionProps) => ReactElement;
}

const ignoreEmbeddedClose = () => undefined;

const SETTINGS_SECTIONS: SettingsSectionDef[] = [
  {
    id: 'general',
    group: '일반',
    label: '프로그램',
    icon: GearSix,
    keywords: ['프로그램', '파일 연결', '연결 프로그램', 'applications', 'file association'],
    render: ({ readOnly }) => <SettingsGeneralPage readOnly={readOnly} />,
  },
  {
    id: 'models',
    group: '모델',
    label: '모델·프로바이더',
    icon: Stack,
    keywords: ['모델', 'llm', 'provider', 'api key', '프로바이더', 'openai', 'gemini'],
    render: () => <ModelManagementModal open embedded onClose={ignoreEmbeddedClose} />,
  },
  {
    id: 'agent',
    group: '에이전트',
    label: '동작·승인',
    icon: Robot,
    keywords: ['에이전트', '자동화', 'autopilot', 'reasoning', '추론', '승인', 'approval', '위임', 'preset'],
    render: ({ readOnly, onSectionChange }) => (
      <SettingsAgentPage readOnly={readOnly} onManageWorkspaces={() => onSectionChange('workspaces')} />
    ),
  },
  {
    id: 'workspaces',
    group: '워크스페이스',
    label: '폴더 관리',
    icon: FolderSimple,
    keywords: ['워크스페이스', '작업 폴더', 'dev workspace', '폴더'],
    render: ({ readOnly, onWorkspaceChanged }) => (
      <SettingsWorkspacePage readOnly={readOnly} onWorkspaceChanged={onWorkspaceChanged} />
    ),
  },
  {
    id: 'skills',
    group: '확장',
    label: '스킬',
    icon: PuzzlePiece,
    keywords: ['스킬', 'skill', '지침'],
    render: ({ readOnly }) => <SettingsSkillsPage readOnly={readOnly} />,
  },
  {
    id: 'plugins',
    group: '확장',
    label: '플러그인',
    icon: Plugs,
    keywords: ['플러그인', 'plugin', '로컬 도구'],
    render: ({ readOnly }) => <SettingsPluginsPage readOnly={readOnly} />,
  },
  {
    id: 'mcp',
    group: '확장',
    label: 'MCP',
    icon: Plugs,
    keywords: ['mcp', '서버', 'model context protocol', '외부 도구'],
    render: ({ readOnly }) => <SettingsMcpPage readOnly={readOnly} />,
  },
];

function matchesSection(definition: SettingsSectionDef, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return (
    definition.label.toLowerCase().includes(normalized)
    || definition.group.toLowerCase().includes(normalized)
    || definition.keywords.some((keyword) => keyword.toLowerCase().includes(normalized))
  );
}

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [activeSectionId, setActiveSectionId] = useState<string>('general');
  const [query, setQuery] = useState('');
  const licenseMode = useWorkspaceStore((state) => state.licenseMode);
  const readOnly = licenseMode !== null && licenseMode !== 'full';

  const filteredSections = useMemo(
    () => SETTINGS_SECTIONS.filter((section) => matchesSection(section, query)),
    [query],
  );
  const groupedSections = useMemo(() => {
    const groups: Array<{ group: string; sections: SettingsSectionDef[] }> = [];
    for (const section of filteredSections) {
      const existing = groups.find((entry) => entry.group === section.group);
      if (existing) existing.sections.push(section);
      else groups.push({ group: section.group, sections: [section] });
    }
    return groups;
  }, [filteredSections]);

  useEffect(() => {
    if (!open || filteredSections.length === 0) return;
    if (!filteredSections.some((section) => section.id === activeSectionId)) {
      setActiveSectionId(filteredSections[0].id);
    }
  }, [activeSectionId, filteredSections, open]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (query) {
        event.preventDefault();
        setQuery('');
      } else {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, query]);

  if (!open) return null;

  const activeSection = SETTINGS_SECTIONS.find((section) => section.id === activeSectionId) ?? SETTINGS_SECTIONS[0];
  const sectionProps: SettingsSectionProps = {
    readOnly,
    onSectionChange: setActiveSectionId,
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/45 p-5 backdrop-blur-sm" onMouseDown={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label="설정"
        className="relative flex h-[min(820px,90vh)] w-full max-w-6xl overflow-hidden rounded-2xl border border-line bg-panel text-text shadow-[0_28px_90px_rgba(0,0,0,0.28)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-[#e7eae7]">
          <div className="sticky top-0 z-10 bg-[#e7eae7] p-4 pb-3">
            <div className="mb-4 flex items-center gap-2 px-2 py-1">
              <GearSix size={20} className="text-accent" />
              <span className="text-lg font-semibold">설정</span>
            </div>
            <label className="flex items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2 text-muted focus-within:border-accent/60 focus-within:text-text">
              <MagnifyingGlass size={16} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && query) {
                    event.preventDefault();
                    event.stopPropagation();
                    setQuery('');
                  }
                }}
                placeholder="설정 검색"
                aria-label="설정 검색"
                className="min-w-0 flex-1 bg-transparent text-sm text-text outline-none placeholder:text-muted"
              />
            </label>
          </div>

          <nav className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4" aria-label="설정 범주">
            {groupedSections.map(({ group, sections }) => (
              <div key={group}>
                <p className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">{group}</p>
                <div className="space-y-1">
                  {sections.map((section) => {
                    const SectionIcon = section.icon;
                    const active = section.id === activeSectionId;
                    return (
                      <button
                        key={section.id}
                        type="button"
                        data-testid={`settings-nav-${section.id}`}
                        onClick={() => setActiveSectionId(section.id)}
                        className={`flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-medium ${
                          active ? 'bg-panel text-text shadow-sm' : 'text-muted hover:bg-panel/60 hover:text-text'
                        }`}
                      >
                        <SectionIcon size={17} />
                        {section.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            {filteredSections.length === 0 ? <p className="px-3 py-4 text-sm text-muted">검색 결과 없음</p> : null}
          </nav>
          <p className="px-6 pb-4 text-xs leading-5 text-muted">설정은 이 PC에만 저장됩니다.</p>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <button
            type="button"
            onClick={onClose}
            className="absolute right-7 top-7 z-10 rounded-lg p-2 text-muted hover:bg-panel-2 hover:text-text"
            aria-label="설정 닫기"
          >
            <X size={18} />
          </button>
          {activeSection.render(sectionProps)}
        </div>
      </section>
    </div>
  );
}
