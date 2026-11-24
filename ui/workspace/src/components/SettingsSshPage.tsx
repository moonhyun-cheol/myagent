import { CheckCircle, Key, Plus, ShieldCheck, TerminalWindow, Trash, Warning, Wrench } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import {
  forgetSshServer,
  lockSshServer,
  retrySshRecall,
  listSshServers,
  saveSshServers,
  testSshServer,
  trustSshServer,
  unlockSshServer,
  type SshKeyState,
  type SshServerItem,
  type SshShell,
} from '../api/myAgentClient';
import { confirmDialog } from '../lib/confirmDialog';

interface SettingsSshPageProps {
  readOnly: boolean;
}

type ServerDraft = {
  id: string;
  label: string;
  host: string;
  port: string;
  username: string;
  keyPath: string;
  defaultCwd: string;
  shell: SshShell;
  encoding?: SshServerItem['encoding'];
};

const SHELL_OPTIONS: Array<{ value: SshShell; label: string }> = [
  { value: 'posix', label: '리눅스·맥' },
  { value: 'cmd', label: 'Windows(cmd)' },
  { value: 'powershell', label: 'Windows(PowerShell)' },
];

const shellLabel = (shell: SshShell | undefined) => SHELL_OPTIONS.find((option) => option.value === (shell ?? 'posix'))?.label ?? '리눅스·맥';

type ProbeResult = { fingerprint: string; trusted: boolean; changed: boolean };

const EMPTY_DRAFT: ServerDraft = { id: '', label: '', host: '', port: '22', username: '', keyPath: '', defaultCwd: '', shell: 'posix' };

const KEY_STATE_LABEL: Record<SshKeyState, string> = {
  ready: '키 사용 가능',
  locked: '키 잠김 · 암호 필요',
  missing: '키 파일 없음',
  invalid: '키 파일을 읽을 수 없음',
  unknown: '키 상태 확인 불가',
};

const editableKey = (server: SshServerItem | undefined) => (server
  ? JSON.stringify([server.label, server.host, server.port, server.username, server.keyPath, server.defaultCwd ?? '', server.shell ?? 'posix', server.encoding])
  : '');

const inputClass = 'mt-1 w-full rounded-lg border border-line bg-panel px-2.5 py-2 font-mono text-xs text-text outline-none focus:border-accent disabled:opacity-60';
const draftInputClass = 'mt-1 w-full rounded-lg border border-line bg-ink/60 px-2.5 py-2 font-mono text-xs text-text outline-none focus:border-accent disabled:opacity-60';

export function SettingsSshPage({ readOnly }: SettingsSshPageProps) {
  const [servers, setServers] = useState<SshServerItem[]>([]);
  /** Last state confirmed by the core; used to detect unsaved edits. */
  const [saved, setSaved] = useState<SshServerItem[]>([]);
  const [draft, setDraft] = useState<ServerDraft>(EMPTY_DRAFT);
  const [probes, setProbes] = useState<Record<string, ProbeResult>>({});
  const [testNotes, setTestNotes] = useState<Record<string, string>>({});
  const [passphrase, setPassphrase] = useState('');
  /** 「이 PC에 기억」: off by default, chosen per unlock. */
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [activeSection, setActiveSection] = useState<'installed' | 'add'>('installed');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const applyServerState = (next: SshServerItem[]) => {
    setServers(next);
    setSaved(next);
  };

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const next = await listSshServers();
      setServers(next);
      setSaved(next);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'SSH 설정을 불러오지 못했습니다.');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (selectedId && servers.some((server) => server.id === selectedId)) return;
    setSelectedId(servers[0]?.id ?? null);
  }, [servers, selectedId]);

  useEffect(() => {
    setPassphrase('');
    setRemember(false);
  }, [selectedId]);

  const run = async (work: () => Promise<SshServerItem[]>, successMessage: string, failMessage: string): Promise<boolean> => {
    setBusy(true);
    setMessage('');
    try {
      applyServerState(await work());
      setMessage(successMessage);
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : failMessage);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const validate = (server: { host: string; username: string; keyPath: string; port: number }): string | null => {
    if (!server.host.trim() || !server.username.trim() || !server.keyPath.trim()) return '호스트, 계정, 키 파일 경로를 입력하세요.';
    if (!Number.isInteger(server.port) || server.port < 1 || server.port > 65535) return '포트는 1~65535 사이 숫자여야 합니다.';
    return null;
  };

  const updateServer = (id: string, patch: Partial<SshServerItem>) => {
    setServers((current) => current.map((server) => (server.id === id ? { ...server, ...patch } : server)));
  };

  const saveServer = async (server: SshServerItem) => {
    const problem = validate(server);
    if (problem) {
      setMessage(problem);
      return;
    }
    const before = saved.find((item) => item.id === server.id);
    const addressChanged = Boolean(before?.trusted) && (before?.host !== server.host || before?.port !== server.port);
    const ok = await run(() => saveSshServers(servers), `저장됨 · ${server.label || server.id}${addressChanged ? ' · 주소가 바뀌어 지문 신뢰가 해제됐습니다' : ''}`, 'SSH 저장 실패');
    if (ok && addressChanged) {
      setProbes((current) => {
        const next = { ...current };
        delete next[server.id];
        return next;
      });
    }
  };

  const removeServer = async (server: SshServerItem) => {
    const ok = await confirmDialog({
      title: 'SSH 서버 삭제',
      message: `${server.label || server.id}을(를) SSH 서버 목록에서 삭제할까요?\n\n키 파일은 삭제하지 않습니다.`,
      confirmLabel: '삭제',
      cancelLabel: '취소',
      danger: true,
    });
    if (!ok) return;
    await run(() => saveSshServers(saved.filter((current) => current.id !== server.id)), `삭제됨 · ${server.label || server.id}`, 'SSH 삭제 실패');
  };

  const testServer = async (server: SshServerItem) => {
    setTestingId(server.id);
    setTestNotes((current) => ({ ...current, [server.id]: '테스트 중...' }));
    try {
      const result = await testSshServer(server.id);
      setProbes((current) => ({ ...current, [server.id]: result }));
      setTestNotes((current) => ({
        ...current,
        [server.id]: result.changed
          ? '주의 · 서버 지문이 신뢰한 값과 다릅니다'
          : result.trusted ? '연결됨 · 신뢰한 지문과 일치' : '연결됨 · 지문을 확인하고 신뢰해 주세요',
      }));
    } catch (error) {
      setTestNotes((current) => ({
        ...current,
        [server.id]: `실패 · ${error instanceof Error ? error.message : '응답 없음'}`,
      }));
    } finally {
      setTestingId(null);
    }
  };

  const trustServer = async (server: SshServerItem, probe: ProbeResult) => {
    const ok = await confirmDialog({
      title: probe.changed ? '서버 지문이 바뀌었습니다' : '이 지문 신뢰',
      message: [
        `${server.label || server.id} (${server.username}@${server.host}:${server.port})`,
        '',
        `지문: ${probe.fingerprint}`,
        '',
        probe.changed
          ? '이전에 신뢰한 지문과 다릅니다. 서버를 다시 설치했거나 키를 바꾼 적이 없다면 다른 서버가 응답한 것일 수 있습니다. 서버 관리자에게 확인한 뒤에만 신뢰하세요.'
          : '서버 관리자가 알려 준 지문과 같은지 확인하세요. 신뢰한 뒤에는 이 지문을 가진 서버에만 연결합니다.',
      ].join('\n'),
      confirmLabel: '이 지문 신뢰',
      cancelLabel: '취소',
      danger: probe.changed,
    });
    if (!ok) return;
    const done = await run(() => trustSshServer(server.id, probe.fingerprint), `지문 신뢰됨 · ${server.label || server.id}`, '지문 신뢰 실패');
    if (done) {
      setProbes((current) => ({ ...current, [server.id]: { ...probe, trusted: true, changed: false } }));
      setTestNotes((current) => ({ ...current, [server.id]: '연결됨 · 신뢰한 지문과 일치' }));
    }
  };

  const unlockServer = async (server: SshServerItem) => {
    const name = server.label || server.id;
    setBusy(true);
    setMessage('');
    try {
      const next = await unlockSshServer(server.id, passphrase, remember);
      applyServerState(next);
      const stored = next.find((item) => item.id === server.id)?.remembered === true;
      setMessage(stored
        ? `키 잠금 해제됨 · ${name} · 암호를 이 PC에 기억했습니다`
        : remember
          ? `키 잠금 해제됨 · ${name} · 이 PC에 기억하지는 못했습니다 (앱을 다시 시작하면 다시 입력해야 합니다)`
          : `키 잠금 해제됨 · ${name} (앱을 다시 시작하면 다시 입력해야 합니다)`);
      setPassphrase('');
      setRemember(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '키 잠금 해제 실패');
    } finally {
      setBusy(false);
    }
  };

  const forgetServer = async (server: SshServerItem) => {
    await run(() => forgetSshServer(server.id), `기억한 암호를 지웠습니다 · ${server.label || server.id} (앱을 다시 시작하면 다시 입력해야 합니다)`, '기억 지우기 실패');
  };

  const addServer = async () => {
    const id = draft.id.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(id)) {
      setMessage('ID는 영문·숫자·_·- 만 쓸 수 있습니다 (최대 40자).');
      return;
    }
    if (saved.some((server) => server.id === id)) {
      setMessage(`이미 존재하는 서버 ID입니다: ${id}`);
      return;
    }
    const next: SshServerItem = {
      id,
      label: draft.label.trim() || id,
      host: draft.host.trim(),
      port: Number(draft.port.trim() || '22'),
      username: draft.username.trim(),
      keyPath: draft.keyPath.trim(),
      defaultCwd: draft.defaultCwd.trim() || undefined,
      shell: draft.shell,
      encoding: draft.encoding,
    };
    const problem = validate(next);
    if (problem) {
      setMessage(problem);
      return;
    }
    const ok = await run(() => saveSshServers([...saved, next]), `추가됨 · ${next.label} · 이제 연결 테스트로 지문을 확인하세요`, 'SSH 서버 추가 실패');
    if (!ok) return;
    setDraft(EMPTY_DRAFT);
    setSelectedId(id);
    setActiveSection('installed');
  };

  const selectedServer = selectedId ? servers.find((server) => server.id === selectedId) ?? null : null;
  const savedSelected = selectedServer ? saved.find((server) => server.id === selectedServer.id) : undefined;
  const dirty = Boolean(selectedServer) && editableKey(selectedServer ?? undefined) !== editableKey(savedSelected);
  const probe = selectedServer ? probes[selectedServer.id] : undefined;
  const keyState: SshKeyState = savedSelected?.keyState ?? 'unknown';
  const remembered = savedSelected?.remembered === true;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-ink px-8 py-7">
      <header className="mb-6 pr-12">
        <h2 className="text-xl font-semibold">SSH 서버</h2>
        <p className="mt-1 text-sm text-muted">원격 서버를 등록하고 지문을 신뢰하면, 폴더가 연결된 에이전트 대화에서 AI가 명령 1개를 제안하고 사용자가 승인한 뒤에만 실행합니다.</p>
      </header>

      {message ? <p className="mb-5 rounded-xl border border-line bg-panel px-4 py-3 text-sm text-muted">{message}</p> : null}

      <div className="mb-5 flex max-w-3xl gap-1 rounded-xl border border-line bg-panel p-1" role="tablist" aria-label="SSH 서버 관리 범주">
        <button
          type="button"
          role="tab"
          aria-selected={activeSection === 'installed'}
          onClick={() => setActiveSection('installed')}
          className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium ${activeSection === 'installed' ? 'bg-ink text-text shadow-sm' : 'text-muted hover:text-text'}`}
        >
          등록된 서버 <span className="ml-1 text-xs text-muted">{servers.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeSection === 'add'}
          onClick={() => setActiveSection('add')}
          className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium ${activeSection === 'add' ? 'bg-ink text-text shadow-sm' : 'text-muted hover:text-text'}`}
        >
          서버 추가
        </button>
      </div>

      {activeSection === 'installed' ? <section className="max-w-3xl rounded-2xl border border-line bg-panel p-5 shadow-sm">
        <div className="mb-4 flex items-center gap-2">
          <TerminalWindow size={21} className="text-accent" />
          <div>
            <h3 className="font-semibold">등록된 SSH 서버</h3>
            <p className="mt-0.5 text-xs text-muted">서버 주소와 키 파일 경로를 저장합니다. 키 내용은 저장하지 않고, 키 암호는 「이 PC에 기억」을 켠 서버만 암호화해 저장합니다.</p>
          </div>
        </div>
        {busy && servers.length === 0 ? <p className="py-4 text-sm text-muted">불러오는 중...</p> : null}
        {!busy && servers.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line px-4 py-8 text-center">
            <p className="text-sm text-muted">등록된 SSH 서버가 없습니다.</p>
            <button type="button" onClick={() => setActiveSection('add')} className="mt-3 rounded-lg bg-accent/15 px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/25">서버 추가</button>
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
            <div className="space-y-1 rounded-xl border border-line bg-ink/35 p-2">
              {servers.map((server) => {
                const stored = saved.find((item) => item.id === server.id);
                return (
                  <button
                    key={server.id}
                    type="button"
                    onClick={() => setSelectedId(server.id)}
                    className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-left ${selectedId === server.id ? 'bg-panel text-text shadow-sm' : 'text-muted hover:bg-panel/70 hover:text-text'}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">{server.label || server.id}</span>
                      <span className="block truncate text-[10px] text-muted">{shellLabel(server.shell)}</span>
                    </span>
                    <span className={`h-2 w-2 shrink-0 rounded-full ${stored?.trusted ? 'bg-accent' : 'bg-muted/40'}`} title={stored?.trusted ? '지문 신뢰됨' : '지문 미신뢰'} />
                  </button>
                );
              })}
            </div>

            {selectedServer ? (
              <div className="rounded-xl border border-line bg-ink/25 p-3">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <p className="min-w-0 truncate text-sm font-medium text-text">{selectedServer.label || selectedServer.id}</p>
                  <span className="rounded-md bg-line px-2 py-1 font-mono text-[10px] text-muted">{selectedServer.id}</span>
                  {savedSelected?.trusted ? (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-accent/15 px-2 py-1 text-[10px] text-accent"><CheckCircle size={12} weight="fill" /> 지문 신뢰됨</span>
                  ) : <span className="rounded-md bg-line px-2 py-1 text-[10px] text-muted">지문 미신뢰</span>}
                  <span className={`rounded-md px-2 py-1 text-[10px] ${keyState === 'ready' ? 'bg-accent/15 text-accent' : 'bg-line text-muted'}`}>{keyState === 'ready' && remembered ? '키 사용 가능 · 기억됨' : KEY_STATE_LABEL[keyState]}</span>
                  <span className="rounded-md bg-line px-2 py-1 text-[10px] text-muted">{shellLabel(savedSelected?.shell)}</span>
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  <label className="text-[11px] text-muted">
                    이름
                    <input value={selectedServer.label} onChange={(event) => updateServer(selectedServer.id, { label: event.target.value })} disabled={readOnly || busy} placeholder="개발 서버" className={inputClass} />
                  </label>
                  <label className="text-[11px] text-muted">
                    계정
                    <input value={selectedServer.username} onChange={(event) => updateServer(selectedServer.id, { username: event.target.value })} disabled={readOnly || busy} placeholder="deploy" className={inputClass} />
                  </label>
                  <label className="text-[11px] text-muted">
                    호스트
                    <input value={selectedServer.host} onChange={(event) => updateServer(selectedServer.id, { host: event.target.value })} disabled={readOnly || busy} placeholder="192.168.0.10" className={inputClass} />
                  </label>
                  <label className="text-[11px] text-muted">
                    포트
                    <input value={String(selectedServer.port)} onChange={(event) => updateServer(selectedServer.id, { port: Number(event.target.value.replace(/\D/g, '') || '0') })} disabled={readOnly || busy} inputMode="numeric" placeholder="22" className={inputClass} />
                  </label>
                  <label className="text-[11px] text-muted md:col-span-2">
                    키 파일 경로 (이 PC)
                    <input value={selectedServer.keyPath} onChange={(event) => updateServer(selectedServer.id, { keyPath: event.target.value })} disabled={readOnly || busy} placeholder="C:\Users\사용자\.ssh\id_ed25519" className={inputClass} />
                  </label>
                  <label className="text-[11px] text-muted md:col-span-2">
                    기본 폴더 (서버, 선택)
                    <input value={selectedServer.defaultCwd ?? ''} onChange={(event) => updateServer(selectedServer.id, { defaultCwd: event.target.value || undefined })} disabled={readOnly || busy} placeholder="/srv/app" className={inputClass} />
                  </label>
                  <label className="text-[11px] text-muted md:col-span-2">
                    서버 종류 (Windows는 폴더 이동 방식과 한글 출력 해석이 달라집니다)
                    <select value={selectedServer.shell ?? 'posix'} onChange={(event) => updateServer(selectedServer.id, { shell: event.target.value as SshShell })} disabled={readOnly || busy} className={inputClass}>
                      {SHELL_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </label>
                  <label className="text-[11px] text-muted">출력 인코딩<select className={inputClass} disabled={readOnly || busy} value={selectedServer.encoding ?? ''} onChange={e => updateServer(selectedServer.id, { encoding: e.target.value as SshServerItem['encoding'] || undefined })}><option value="">자동</option><option value="utf8">UTF-8</option><option value="cp949">한글 Windows</option></select></label>
                </div>

                {dirty ? <p className="mt-2 text-xs text-muted">저장하지 않은 변경이 있습니다. 저장한 뒤 연결 테스트·지문 신뢰·키 잠금 해제를 할 수 있습니다.</p> : null}
                {testNotes[selectedServer.id] ? <p className="mt-2 text-xs text-muted">{testNotes[selectedServer.id]}</p> : null}

                {probe && !dirty ? (
                  <div className={`mt-2 rounded-lg border px-3 py-2 ${probe.changed ? 'border-red-400/50' : 'border-line'}`}>
                    <p className="flex items-center gap-1 text-[11px] text-muted">
                      {probe.changed ? <Warning size={13} className="text-red-400" /> : <ShieldCheck size={13} />}
                      서버가 보낸 지문
                    </p>
                    <p className="mt-1 break-all font-mono text-xs text-text">{probe.fingerprint}</p>
                    {probe.changed && savedSelected?.hostKeySha256 ? <p className="mt-1 break-all font-mono text-[11px] text-muted">신뢰한 지문: {savedSelected.hostKeySha256}</p> : null}
                    {!probe.trusted ? (
                      <button type="button" disabled={readOnly || busy} onClick={() => void trustServer(selectedServer, probe)} className="mt-2 inline-flex items-center gap-1 rounded-lg bg-accent/15 px-2.5 py-1.5 text-xs font-medium text-accent hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-45">
                        <ShieldCheck size={13} /> 이 지문 신뢰
                      </button>
                    ) : null}
                  </div>
                ) : null}

                {!dirty && (keyState === 'locked' || keyState === 'ready') ? (
                  <div className="mt-2">
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="min-w-[200px] flex-1 text-[11px] text-muted">
                      키 암호
                      <input type="password" autoComplete="off" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} disabled={readOnly || busy} placeholder={keyState === 'ready' ? '이미 사용 가능 · 다시 입력할 때만' : '키 암호'} className={inputClass} />
                    </label>
                    <button type="button" disabled={readOnly || busy || !passphrase} onClick={() => void unlockServer(selectedServer)} className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-2 text-xs text-muted enabled:hover:border-accent/50 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-45">
                      <Key size={13} /> 키 잠금 해제
                    </button>
                  </div>
                    <label className="mt-2 flex items-start gap-2 text-[11px] text-muted">
                      <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} disabled={readOnly || busy} className="mt-0.5" />
                      <span>
                        <span className="text-text">이 PC에 기억</span>
                        <span className="block">이 Windows 계정으로 로그인했을 때만 풀리게 암호화해 저장합니다. 켜지 않으면 앱을 다시 시작할 때 다시 입력합니다.</span>
                      </span>
                    </label>
                  </div>
                ) : null}

                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" disabled={testingId === selectedServer.id || busy || dirty} onClick={() => void testServer(selectedServer)} className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted enabled:hover:border-accent/50 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-45">
                    <Wrench size={13} />
                    {testingId === selectedServer.id ? '테스트 중...' : '연결 테스트'}
                  </button>
                  {!dirty && savedSelected?.rememberState === 'unreadable' && <div className="text-xs text-muted">기억한 암호를 이 PC·이 Windows 계정에서 열 수 없습니다. <button disabled={readOnly || busy} onClick={() => void run(() => retrySshRecall(selectedServer.id), '암호 기억 상태를 다시 확인했습니다.', '다시 시도 실패')}>다시 시도</button></div>}
                  {!dirty && keyState === 'ready' && <button disabled={readOnly || busy} className="rounded-lg border border-line px-2 text-xs" onClick={() => void run(() => lockSshServer(selectedServer.id), '메모리와 저장된 암호를 지웠습니다.', '잠금 실패')}>지금 잠그기</button>}
                  {remembered && !dirty ? (
                    <button type="button" disabled={readOnly || busy} onClick={() => void forgetServer(selectedServer)} className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted enabled:hover:border-accent/50 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-45">
                      <Key size={13} /> 기억 지우기
                    </button>
                  ) : null}
                  <button type="button" disabled={readOnly || busy} onClick={() => void saveServer(selectedServer)} className="rounded-lg bg-accent/15 px-2.5 py-1.5 text-xs font-medium text-accent hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-45">저장</button>
                  <button type="button" disabled={readOnly || busy} onClick={() => void removeServer(selectedServer)} className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted enabled:hover:border-red-400/50 enabled:hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-45">
                    <Trash size={13} /> 삭제
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </section> : null}

      {activeSection === 'add' ? <section className="max-w-3xl rounded-2xl border border-line bg-panel p-5 shadow-sm">
        <div className="mb-4 flex items-center gap-2">
          <Plus size={19} className="text-accent" />
          <div>
            <h3 className="font-semibold">서버 추가</h3>
            <p className="mt-0.5 text-xs text-muted">등록한 뒤 연결 테스트 → 「이 지문 신뢰」 → 키 잠금 해제 순서로 준비합니다. 키 파일은 이 PC에 있는 개인키 경로만 적습니다.</p>
          </div>
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          <label className="text-[11px] text-muted">
            ID (영문·숫자, 나중에 바꿀 수 없음)
            <input value={draft.id} onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value }))} disabled={readOnly || busy} placeholder="dev" className={draftInputClass} />
          </label>
          <label className="text-[11px] text-muted">
            이름
            <input value={draft.label} onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))} disabled={readOnly || busy} placeholder="개발 서버" className={draftInputClass} />
          </label>
          <label className="text-[11px] text-muted">
            호스트
            <input value={draft.host} onChange={(event) => setDraft((current) => ({ ...current, host: event.target.value }))} disabled={readOnly || busy} placeholder="192.168.0.10" className={draftInputClass} />
          </label>
          <label className="text-[11px] text-muted">
            포트
            <input value={draft.port} onChange={(event) => setDraft((current) => ({ ...current, port: event.target.value.replace(/\D/g, '') }))} disabled={readOnly || busy} inputMode="numeric" placeholder="22" className={draftInputClass} />
          </label>
          <label className="text-[11px] text-muted">
            계정
            <input value={draft.username} onChange={(event) => setDraft((current) => ({ ...current, username: event.target.value }))} disabled={readOnly || busy} placeholder="deploy" className={draftInputClass} />
          </label>
          <label className="text-[11px] text-muted">
            기본 폴더 (서버, 선택)
                    <input value={draft.defaultCwd} onChange={(event) => setDraft((current) => ({ ...current, defaultCwd: event.target.value }))} disabled={readOnly || busy} placeholder="/srv/app" className={draftInputClass} />
          </label>
          <label className="text-[11px] text-muted md:col-span-2">
            서버 종류
            <select value={draft.shell} onChange={(event) => setDraft((current) => ({ ...current, shell: event.target.value as SshShell }))} disabled={readOnly || busy} className={draftInputClass}>
              {SHELL_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className="text-[11px] text-muted">출력 인코딩<select className={draftInputClass} disabled={readOnly || busy} value={draft.encoding ?? ''} onChange={e => setDraft({ ...draft, encoding: e.target.value as SshServerItem['encoding'] || undefined })}><option value="">자동</option><option value="utf8">UTF-8</option><option value="cp949">한글 Windows</option></select></label>
          <label className="text-[11px] text-muted md:col-span-2">
            키 파일 경로 (이 PC)
            <input value={draft.keyPath} onChange={(event) => setDraft((current) => ({ ...current, keyPath: event.target.value }))} disabled={readOnly || busy} placeholder="C:\Users\사용자\.ssh\id_ed25519" className={draftInputClass} />
          </label>
        </div>
        <button type="button" disabled={readOnly || busy} onClick={() => void addServer()} className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-45">
          <Plus size={14} weight="bold" />
          서버 등록
        </button>
      </section> : null}
    </div>
  );
}
