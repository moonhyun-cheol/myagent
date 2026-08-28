import { Archive, FolderOpen, Package, Trash } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyOrganizationModule,
  checkOrganizationModule,
  deleteSkill,
  fetchOrganizationModule,
  importSkillPackage,
  installOrganizationModule,
  listSkills,
  type OrganizationModuleStatus,
  type OrganizationModuleUpdate,
  type SkillListItem,
} from '../api/myAgentClient';
import { confirmDialog } from '../lib/confirmDialog';

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
  const [moduleStatus, setModuleStatus] = useState<OrganizationModuleStatus | null>(null);
  const [moduleUpdate, setModuleUpdate] = useState<OrganizationModuleUpdate | null>(null);
  const [zipPath, setZipPath] = useState('');
  const [moduleZipPath, setModuleZipPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const pickerRequestRef = useRef<{ id: string; purpose: 'skillZip' | 'organizationModuleZip' } | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setSkills(await listSkills());
      setModuleStatus(await fetchOrganizationModule());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '스킬 목록을 불러오지 못했습니다.');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
        if (pending.purpose === 'organizationModuleZip') {
          setModuleZipPath(data.path);
          setMessage('회사 팩 ZIP을 선택했습니다. 추가를 누르면 서명을 확인하고 설치합니다.');
        } else {
          setZipPath(data.path);
          setMessage('스킬 ZIP을 선택했습니다. 설치를 누르면 압축을 확인하고 등록합니다.');
        }
      }
    };
    webview.addEventListener('message', onMessage);
    return () => webview.removeEventListener('message', onMessage);
  }, []);

  const installed = useMemo(() => skills.filter((skill) => skill.source === 'user'), [skills]);
  const bundled = useMemo(() => skills.filter((skill) => skill.source === 'bundled'), [skills]);
  const organization = useMemo(() => skills.filter((skill) => skill.source === 'organization'), [skills]);

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

  const openModuleZipPicker = () => {
    if (readOnly || busy) return;
    const webview = getShellWebView();
    if (!webview) {
      setMessage('파일 탐색기는 데스크톱 앱에서 사용할 수 있습니다. 이 화면에서는 ZIP 경로를 직접 입력하세요.');
      return;
    }
    const requestId = `org-module-zip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    pickerRequestRef.current = { id: requestId, purpose: 'organizationModuleZip' };
    setMessage('받은 회사 팩 ZIP을 선택하세요.');
    webview.postMessage({ type: 'filePicker.open', requestId, purpose: 'organizationModuleZip' });
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

  const installModuleZip = async () => {
    const requestedPath = moduleZipPath.trim().replace(/^"|"$/g, '');
    if (!requestedPath) {
      setMessage('추가할 회사 팩 ZIP 파일 경로를 입력하세요.');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const moduleInstalled = await installOrganizationModule(requestedPath);
      setModuleZipPath('');
      setMessage(moduleInstalled
        ? `회사 팩 추가됨 · ${moduleInstalled.version} (시퀀스 ${moduleInstalled.update_sequence})`
        : '회사 팩을 추가했습니다.');
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '회사 팩 추가 실패');
    } finally {
      setBusy(false);
    }
  };

  const checkModule = async () => {
    setBusy(true);
    setMessage('');
    try {
      const update = await checkOrganizationModule();
      setModuleUpdate(update);
      setMessage(update
        ? `새 모듈 ${update.version} (시퀀스 ${update.sequence})`
        : '받을 조직 모듈 업데이트가 없습니다.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '조직 모듈 확인 실패');
    } finally {
      setBusy(false);
    }
  };

  const applyModule = async () => {
    setBusy(true);
    setMessage('');
    try {
      await applyOrganizationModule();
      setModuleUpdate(null);
      setMessage('조직 모듈을 업데이트했습니다.');
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '조직 모듈 업데이트 실패');
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
      <header className="mb-6 pr-12">
        <h2 className="text-xl font-semibold">스킬</h2>
        <p className="mt-1 text-sm text-muted">ZIP으로 전달받은 스킬을 풀어서 이 PC에 설치하고 관리합니다.</p>
      </header>

      {message ? (
        <p data-testid="skill-settings-message" className="mb-5 rounded-xl border border-line bg-panel px-4 py-3 text-sm text-muted">
          {message}
        </p>
      ) : null}

      <section className="mb-5 max-w-3xl rounded-2xl border border-line bg-panel p-5 shadow-sm">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold">조직 모듈</h3>
            <p className="mt-0.5 text-xs text-muted">받은 회사 팩 ZIP을 선택하면 서명을 확인하고 자동으로 추가됩니다.</p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="organization-module-check"
              disabled={busy || !moduleStatus?.installed?.update_feed_url}
              onClick={() => void checkModule()}
              className="rounded-xl border border-line px-3 py-2 text-xs font-semibold text-text hover:border-accent disabled:cursor-not-allowed disabled:opacity-45"
            >
              업데이트 확인
            </button>
            {moduleUpdate ? (
              <button
                type="button"
                data-testid="organization-module-apply"
                disabled={readOnly || busy}
                onClick={() => void applyModule()}
                className="rounded-xl bg-accent px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45"
              >
                {moduleUpdate.version} 설치
              </button>
            ) : null}
          </div>
        </div>
        <div className="mb-3 flex gap-2">
          <input
            data-testid="organization-module-zip-path"
            value={moduleZipPath}
            disabled={readOnly || busy}
            onClick={openModuleZipPicker}
            onChange={(event) => setModuleZipPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void installModuleZip();
            }}
            placeholder="예: C:\\Users\\me\\Downloads\\company-pack.zip"
            className="min-w-0 flex-1 rounded-xl border border-line bg-[#fafbf8] px-3 py-2.5 font-mono text-sm outline-none focus:border-accent disabled:opacity-50"
          />
          <button
            data-testid="organization-module-zip-browse"
            type="button"
            disabled={readOnly || busy}
            onClick={openModuleZipPicker}
            className="inline-flex items-center gap-1.5 rounded-xl border border-line bg-[#fafbf8] px-3.5 py-2.5 text-sm font-semibold text-text hover:border-accent disabled:cursor-not-allowed disabled:opacity-45"
          >
            <FolderOpen size={17} /> 찾아보기
          </button>
          <button
            data-testid="organization-module-install"
            type="button"
            disabled={readOnly || busy || !moduleZipPath.trim()}
            onClick={() => void installModuleZip()}
            className="rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-45"
          >
            추가
          </button>
        </div>
        {moduleStatus?.installed ? (
          <p className="font-mono text-xs text-muted">
            {moduleStatus.installed.version} · 시퀀스 {moduleStatus.installed.update_sequence}
            {moduleStatus.installed.capabilities.length ? ` · ${moduleStatus.installed.capabilities.join(', ')}` : ''}
          </p>
        ) : (
          <p className="text-sm text-muted">아직 회사 팩이 없습니다. 위에서 ZIP을 고른 뒤 추가하세요.</p>
        )}
        {organization.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {organization.map((skill) => (
              <span key={skill.id} className="rounded-lg border border-line bg-ink/40 px-2.5 py-1.5 text-xs text-muted">
                {skill.label}
              </span>
            ))}
          </div>
        ) : null}
      </section>

      <section className="max-w-3xl rounded-2xl border border-line bg-panel p-5 shadow-sm">
        <div className="mb-4 flex items-center gap-2">
          <Archive size={21} className="text-accent" />
          <div>
            <h3 className="font-semibold">ZIP 파일로 스킬 설치</h3>
            <p className="mt-0.5 text-xs text-muted">ZIP 루트 또는 단일 최상위 폴더에 SKILL.md가 있어야 합니다.</p>
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
        <p className="mt-3 text-xs leading-5 text-muted">ZIP 원본은 앱에 복사하지 않고 내부 스킬 폴더로 압축 해제합니다. 경로 밖 쓰기, 심볼릭 링크, 암호화 ZIP 및 과도하게 큰 압축 파일은 차단됩니다.</p>
      </section>

      <section className="mt-5 max-w-3xl rounded-2xl border border-line bg-panel p-5 shadow-sm">
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
            {installed.map((skill) => (
              <div key={skill.id} data-testid={`installed-skill-${skill.id}`} className="flex items-start justify-between gap-4 rounded-xl border border-line bg-ink/40 p-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-semibold text-text">{skill.label}</p>
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
            ))}
          </div>
        )}
      </section>

      <details className="mt-5 max-w-3xl rounded-2xl border border-line bg-panel p-5 shadow-sm">
        <summary className="cursor-pointer text-sm font-medium text-text">앱 기본 스킬 {bundled.length}개</summary>
        <p className="mt-2 text-xs text-muted">기본 스킬은 앱 업데이트로 관리되며 여기서는 제거할 수 없습니다.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {bundled.map((skill) => <span key={skill.id} className="rounded-lg border border-line bg-ink/40 px-2.5 py-1.5 text-xs text-muted">{skill.label}</span>)}
        </div>
      </details>
    </div>
  );
}
