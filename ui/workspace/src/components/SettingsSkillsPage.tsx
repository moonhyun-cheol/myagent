import { Archive, FolderOpen, Package, Trash } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyOrganizationModule,
  checkOrganizationModule,
  deleteSkill,
  fetchOrganizationModule,
  fetchProfiles,
  importSkillPackage,
  listSkills,
  type SkillListItem,
} from '../api/myAgentClient';
import { confirmDialog } from '../lib/confirmDialog';

function isSkillPinned(skill: SkillListItem, pinned: ReadonlySet<string>): boolean {
  return pinned.has(skill.id) || pinned.has(skill.mode) || pinned.has(`org:${skill.id}`);
}

interface SettingsSkillsPageProps {
  readOnly: boolean;
}

type ShellWebViewMessage = {
  type?: string;
  requestId?: string;
  purpose?: string;
  canceled?: boolean;
  path?: string | null;
};

type ShellWebViewHost = {
  postMessage: (message: unknown) => void;
  addEventListener: (type: 'message', listener: (event: { data: unknown }) => void) => void;
  removeEventListener: (type: 'message', listener: (event: { data: unknown }) => void) => void;
};

function getShellWebView(): ShellWebViewHost | null {
  const chrome = (window as unknown as { chrome?: { webview?: ShellWebViewHost } }).chrome;
  return chrome?.webview ?? null;
}

export function SettingsSkillsPage({ readOnly }: SettingsSkillsPageProps) {
  const [skills, setSkills] = useState<SkillListItem[]>([]);
  const [pinnedSkillIds, setPinnedSkillIds] = useState<string[]>([]);
  const [zipPath, setZipPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const pickerRequestRef = useRef<{ id: string; purpose: 'skillZip' } | null>(null);
  const canCheckRemoteRef = useRef(false);
  const initialRemoteCheckDoneRef = useRef(false);

  const syncOrgModuleSilently = useCallback(async () => {
    if (readOnly || !canCheckRemoteRef.current) return;
    try {
      const update = await checkOrganizationModule();
      if (!update) return;
      await applyOrganizationModule();
    } catch {
      /* background sync */
    }
  }, [readOnly]);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setSkills(await listSkills());
      const status = await fetchOrganizationModule();
      canCheckRemoteRef.current = status.can_check_remote === true;
      try {
        const profiles = await fetchProfiles();
        setPinnedSkillIds(profiles.applied?.ui?.pinned_skill_ids ?? []);
      } catch {
        setPinnedSkillIds([]);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '스킬 목록을 불러오지 못했습니다.');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await refresh();
      if (cancelled || initialRemoteCheckDoneRef.current) return;
      initialRemoteCheckDoneRef.current = true;
      if (canCheckRemoteRef.current) {
        await syncOrgModuleSilently();
        if (!cancelled) await refresh();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh, syncOrgModuleSilently]);

  useEffect(() => {
    const webview = getShellWebView();
    if (!webview) return;
    const onMessage = (event: { data: unknown }) => {
      const data = event.data as ShellWebViewMessage | null;
      const pending = pickerRequestRef.current;
      if (
        !data
        || !pending
        || data.type !== 'filePicker.result'
        || data.purpose !== pending.purpose
        || data.requestId !== pending.id
      ) return;
      pickerRequestRef.current = null;
      if (!data.canceled && typeof data.path === 'string' && data.path.toLowerCase().endsWith('.zip')) {
        setZipPath(data.path);
        setMessage('스킬 ZIP을 선택했습니다. 설치를 누르면 등록합니다.');
      }
    };
    webview.addEventListener('message', onMessage);
    return () => webview.removeEventListener('message', onMessage);
  }, []);

  const pinRank = useCallback(
    (skill: SkillListItem) => {
      const pin = new Set(pinnedSkillIds);
      return isSkillPinned(skill, pin) ? 0 : 1;
    },
    [pinnedSkillIds],
  );

  const pinnedSet = useMemo(() => new Set(pinnedSkillIds), [pinnedSkillIds]);

  const installed = useMemo(
    () =>
      skills
        .filter((skill) => skill.source === 'user')
        .sort((a, b) => pinRank(a) - pinRank(b) || a.label.localeCompare(b.label, 'ko')),
    [skills, pinRank],
  );
  const bundled = useMemo(
    () =>
      skills
        .filter((skill) => skill.source === 'bundled')
        .sort((a, b) => pinRank(a) - pinRank(b) || a.label.localeCompare(b.label, 'ko')),
    [skills, pinRank],
  );
  const organization = useMemo(
    () =>
      skills
        .filter((skill) => skill.source === 'organization')
        .sort((a, b) => pinRank(a) - pinRank(b) || a.label.localeCompare(b.label, 'ko')),
    [skills, pinRank],
  );
  const pinnedOrgSkills = useMemo(
    () => organization.filter((skill) => isSkillPinned(skill, pinnedSet)),
    [organization, pinnedSet],
  );

  const openZipPicker = () => {
    if (readOnly || busy) return;
    const webview = getShellWebView();
    if (!webview) {
      setMessage('파일 탐색기는 데스크톱 앱에서 사용할 수 있습니다. 이 화면에서는 ZIP 경로를 직접 입력하세요.');
      return;
    }
    const requestId = `skill-zip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    pickerRequestRef.current = { id: requestId, purpose: 'skillZip' };
    setMessage('스킬 ZIP을 선택하세요.');
    webview.postMessage({ type: 'filePicker.open', requestId, purpose: 'skillZip' });
  };

  const install = async () => {
    const requestedPath = zipPath.trim().replace(/^"|"$/g, '');
    if (!requestedPath) {
      setMessage('설치할 스킬 ZIP 파일 경로를 입력하세요.');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const skill = await importSkillPackage(requestedPath);
      setZipPath('');
      setMessage(`설치됨 · ${skill.label}`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '스킬 설치 실패');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (skill: SkillListItem) => {
    const ok = await confirmDialog({
      title: '스킬 제거',
      message: `「${skill.label}」 스킬과 이 PC에 복사된 패키지 파일을 제거할까요?`,
      confirmLabel: '제거',
      cancelLabel: '취소',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setMessage('');
    try {
      await deleteSkill(skill.id);
      setMessage(`제거됨 · ${skill.label}`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '스킬 제거 실패');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-ink px-8 py-7">
      <header className="mb-5 pr-12">
        <h2 className="text-xl font-semibold">스킬</h2>
        <p className="mt-1 text-sm text-muted">
          조직 모듈·ZIP 스킬을 관리합니다. 작업 키트는 MY Agent 관리자에서 설정하세요.
        </p>
      </header>

      {message ? (
        <p data-testid="skill-settings-message" className="mb-5 max-w-4xl rounded-xl border border-line bg-panel px-4 py-3 text-sm text-muted">
          {message}
        </p>
      ) : null}

      <details className="max-w-4xl rounded-2xl border border-line bg-panel p-5 shadow-sm">
        <summary className="cursor-pointer text-sm font-medium text-text">고급 · 스킬 관리</summary>

        {organization.length > 0 ? (
          <div
            data-testid="organization-skill-chips"
            className="mt-4 rounded-xl border border-line bg-panel/60 px-4 py-3"
          >
            {pinnedOrgSkills.length > 0 ? (
              <p data-testid="organization-pinned-summary" className="mb-2 text-xs text-muted">
                적용된 작업 키트에 맞춰 켜진 스킬 {pinnedOrgSkills.length}개
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {organization.map((skill) => {
                const pinned = isSkillPinned(skill, pinnedSet);
                return (
                  <span
                    key={skill.id}
                    data-testid={`organization-skill-${skill.id}`}
                    data-pinned={pinned ? 'true' : 'false'}
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs ${
                      pinned
                        ? 'border-accent/40 bg-accent/10 font-semibold text-accent'
                        : 'border-line bg-ink/40 text-muted'
                    }`}
                  >
                    {skill.label}
                  </span>
                );
              })}
            </div>
          </div>
        ) : null}

        <section className="mt-5">
        <div className="mb-4 flex items-center gap-2">
          <Archive size={21} className="text-accent" />
          <div>
            <h3 className="font-semibold">ZIP 파일로 스킬 설치</h3>
            <p className="mt-0.5 text-xs text-muted">별도로 받은 스킬 ZIP만 여기서 설치합니다.</p>
          </div>
        </div>
        <div className="flex gap-2">
          <input
            data-testid="skill-zip-path"
            value={zipPath}
            disabled={readOnly || busy}
            onClick={openZipPicker}
            onChange={(event) => setZipPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void install();
            }}
            placeholder="예: C:\\Users\\me\\Downloads\\rulebook.zip"
            className="min-w-0 flex-1 rounded-xl border border-line bg-[#fafbf8] px-3 py-2.5 font-mono text-sm outline-none focus:border-accent disabled:opacity-50"
          />
          <button
            data-testid="skill-zip-browse-button"
            type="button"
            disabled={readOnly || busy}
            onClick={openZipPicker}
            className="inline-flex items-center gap-1.5 rounded-xl border border-line bg-[#fafbf8] px-3.5 py-2.5 text-sm font-semibold text-text hover:border-accent disabled:cursor-not-allowed disabled:opacity-45"
          >
            <FolderOpen size={17} /> 찾아보기
          </button>
          <button
            data-testid="skill-import-button"
            type="button"
            disabled={readOnly || busy || !zipPath.trim()}
            onClick={() => void install()}
            className="rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-45"
          >
            설치
          </button>
        </div>
        <p className="mt-3 text-xs leading-5 text-muted">ZIP 원본은 앱에 복사하지 않고 내부 스킬 폴더로 압축 해제합니다.</p>
        </section>

        <section className="mt-5">
        <div className="mb-4 flex items-center gap-2">
          <Package size={21} className="text-accent" />
          <h3 className="font-semibold">사용자가 설치한 스킬</h3>
          <span className="rounded-md bg-accent/10 px-2 py-0.5 text-xs text-accent">{installed.length}</span>
        </div>
        {busy && installed.length === 0 ? <p className="py-4 text-sm text-muted">불러오는 중...</p> : null}
        {!busy && installed.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">설치된 사용자 스킬이 없습니다.</p>
        ) : (
          <div className="space-y-3">
            {installed.map((skill) => {
              const pinned = isSkillPinned(skill, pinnedSet);
              return (
              <div key={skill.id} data-testid={`installed-skill-${skill.id}`} data-pinned={pinned ? 'true' : 'false'} className="flex items-start justify-between gap-4 rounded-xl border border-line bg-ink/40 p-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-semibold text-text">{skill.label}</p>
                    {pinned ? (
                      <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold text-accent">핀</span>
                    ) : null}
                    <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">
                      {skill.install_kind === 'package' ? '압축 해제 설치' : '사용자 스킬'}
                    </span>
                  </div>
                  <p className="mt-1 font-mono text-[11px] text-muted">{skill.id}</p>
                  {skill.description ? <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted">{skill.description}</p> : null}
                  {typeof skill.file_count === 'number' ? <p className="mt-1 text-[11px] text-muted">패키지 파일 {skill.file_count}개</p> : null}
                </div>
                <button
                  type="button"
                  disabled={readOnly || busy || skill.removable === false}
                  onClick={() => void remove(skill)}
                  className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-line px-3 py-1.5 text-xs text-muted enabled:hover:border-red-400/50 enabled:hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <Trash size={13} /> 제거
                </button>
              </div>
              );
            })}
          </div>
        )}
        </section>

        <details className="mt-5">
          <summary className="cursor-pointer text-sm font-medium text-text">앱 기본 스킬 {bundled.length}개</summary>
          <p className="mt-2 text-xs text-muted">기본 스킬은 앱 업데이트로 관리됩니다.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {bundled.map((skill) => <span key={skill.id} className="rounded-lg border border-line bg-ink/40 px-2.5 py-1.5 text-xs text-muted">{skill.label}</span>)}
          </div>
        </details>
      </details>
    </div>
  );
}
