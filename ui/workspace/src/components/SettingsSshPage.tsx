import { ArrowCounterClockwise, Buildings, CaretDown, CaretRight, CheckCircle, FolderOpen, Key, LockSimple, Plus, ShieldCheck, TerminalWindow, Trash, Warning, Wrench } from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  forgetSshServer,
  listSshKeyCandidates,
  listSshServers,
  lockSshServer,
  retrySshRecall,
  saveManagedSshAccount,
  saveSshServers,
  testSshServer,
  trustSshServer,
  unlockSshServer,
  type SshKeyCandidate,
  type SshServerItem,
  type SshShell,
} from '../api/myAgentClient';
import { confirmDialog } from '../lib/confirmDialog';

interface SettingsSshPageProps {
  readOnly: boolean;
}

type SshAuth = 'password' | 'key';

type AddDraft = {
  label: string;
  host: string;
  username: string;
  auth: SshAuth;
  /** Password, or the key passphrase when the key needs one. Kept in memory only. */
  secret: string;
  remember: boolean;
  keyPath: string;
  port: string;
  shell: SshShell;
  encoding?: SshServerItem['encoding'];
  defaultCwd: string;
  jumpServerId?: string;
};

type ProbeResult = { fingerprint: string; trusted: boolean; changed: boolean };

const SHELL_OPTIONS: Array<{ value: SshShell; label: string }> = [
  { value: 'posix', label: '리눅스·맥' },
  { value: 'cmd', label: 'Windows(cmd)' },
  { value: 'powershell', label: 'Windows(PowerShell)' },
];

const FOLDER_PLACEHOLDER: Record<SshShell, string> = {
  posix: '/srv/app',
  cmd: 'C:\\work',
  powershell: 'C:\\work',
};

const shellLabel = (shell: SshShell | undefined) => SHELL_OPTIONS.find((option) => option.value === (shell ?? 'posix'))?.label ?? '리눅스·맥';

const EMPTY_DRAFT: AddDraft = {
  label: '',
  host: '',
  username: '',
  auth: 'password',
  secret: '',
  remember: false,
  keyPath: '',
  port: '22',
  shell: 'posix',
  defaultCwd: '',
};

/** Error codes from the core, in words a non-developer can act on. */
const FRIENDLY_ERRORS: Record<string, string> = {
  SSH_AUTH_FAILED: '서버가 계정 또는 비밀번호를 거부했습니다. 다시 확인해 주세요.',
  SSH_KEY_PASSPHRASE_WRONG: '키 암호가 맞지 않습니다.',
  SSH_KEY_INVALID: '이 키 파일은 쓸 수 없습니다. 다른 키 파일을 고르세요.',
  SSH_KEY_NOT_FOUND: '키 파일을 찾을 수 없습니다. 키 파일을 다시 고르세요.',
  SSH_CONNECT_FAILED: '서버에 연결하지 못했습니다. 서버 주소와 네트워크를 확인하세요.',
  SSH_HOST_KEY_CHANGED: '서버 지문이 확인한 값과 달라 연결하지 않았습니다.',
  SSH_HOST_NOT_TRUSTED: '먼저 「연결 준비」로 서버를 확인하세요.',
  SSH_ACCOUNT_REQUIRED: '계정을 입력하세요.',
  SSH_RUNTIME_MISSING: '이 설치본에는 SSH 구성 요소가 없습니다. 앱을 업데이트하세요.',
  SSH_MANAGED_READONLY: '조직이 배포한 연결은 바꿀 수 없습니다.',
  SSH_FINGERPRINT_NOT_PROBED: '서버 확인을 다시 시작해 주세요.',
};

function friendlyError(error: unknown, fallback: string): string {
  const text = error instanceof Error ? error.message : '';
  const [code, ...rest] = text.split(' · ');
  return FRIENDLY_ERRORS[(code ?? '').trim()] ?? ((rest.length ? rest.join(' · ') : text) || fallback);
}

/** ID from the name (or account+address when the name is non-ASCII): letters, digits and `-`, unique on this PC. */
function makeServerId(label: string, username: string, host: string, taken: Set<string>): string {
  const slug = (value: string) => value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  const accountHost = slug(username) && slug(host)
    ? `${slug(username)}-${slug(host)}`.slice(0, 32).replace(/-+$/g, '')
    : '';
  const root = slug(label) || accountHost || slug(host) || 'server';
  let id = root;
  for (let n = 2; taken.has(id); n += 1) id = `${root}-${n}`;
  return id;
}

const editableKey = (server: SshServerItem | undefined) => (server
  ? JSON.stringify([server.label, server.host, server.port, server.username, server.keyPath, server.defaultCwd ?? '', server.shell ?? 'posix', server.encoding, server.auth, server.jumpServerId])
  : '');

const isReady = (server: SshServerItem | undefined) => Boolean(server?.trusted && server.username && server.keyState === 'ready');

const inputClass = 'mt-1 w-full rounded-lg border border-line bg-panel px-2.5 py-2 text-xs text-text outline-none focus:border-accent disabled:opacity-60';
const monoInputClass = `${inputClass} font-mono`;
const secondaryButton = 'inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted enabled:hover:border-accent/50 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-45';
const primaryButton = 'inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-45';

function AuthChoice({ value, onChange, disabled }: { value: SshAuth; onChange: (next: SshAuth) => void; disabled: boolean }) {
  return (
    <div className="mt-1 flex gap-1 rounded-lg border border-line p-0.5" role="radiogroup" aria-label="인증 방식">
      {([['password', '비밀번호'], ['key', '키 파일']] as const).map(([option, label]) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          disabled={disabled}
          onClick={() => onChange(option)}
          className={`flex-1 rounded-md px-2 py-1.5 text-xs ${value === option ? 'bg-accent/15 font-medium text-accent' : 'text-muted hover:text-text'}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Private keys found in ~/.ssh, picked by click. Only names and paths come from the core. */
function KeyPicker({ value, onChange, disabled }: { value: string; onChange: (path: string) => void; disabled: boolean }) {
  const [candidates, setCandidates] = useState<SshKeyCandidate[] | null>(null);
  const [dir, setDir] = useState('');
  const [manual, setManual] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void listSshKeyCandidates()
      .then((result) => {
        if (cancelled) return;
        setCandidates(result.candidates);
        setDir(result.dir);
      })
      .catch(() => { if (!cancelled) setCandidates([]); });
    return () => { cancelled = true; };
  }, []);

  const listed = candidates?.some((candidate) => candidate.path === value) === true;
  return (
    <div className="text-[11px] text-muted md:col-span-2">
      키 파일 <span className="text-muted/80">(이 PC의 {dir || '.ssh 폴더'})</span>
      {candidates === null ? <p className="mt-1">키 파일을 찾는 중...</p> : null}
      {candidates?.length === 0 ? <p className="mt-1">.ssh 폴더에서 개인 키를 찾지 못했습니다. 아래 「다른 위치의 파일」로 직접 지정하세요.</p> : null}
      {candidates?.length ? (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {candidates.map((candidate) => (
            <button
              key={candidate.path}
              type="button"
              disabled={disabled}
              title={candidate.path}
              onClick={() => { onChange(candidate.path); setManual(false); }}
              className={`rounded-lg border px-2.5 py-1.5 font-mono text-[11px] ${value === candidate.path ? 'border-accent bg-accent/15 text-accent' : 'border-line text-text hover:border-accent/50'}`}
            >
              {candidate.name}
            </button>
          ))}
        </div>
      ) : null}
      {value && !listed && !manual ? <p className="mt-1 break-all font-mono text-[11px] text-text">선택됨: {value}</p> : null}
      <button
        type="button"
        disabled={disabled}
        aria-expanded={manual}
        onClick={() => setManual((open) => !open)}
        className="mt-2 inline-flex items-center gap-1 rounded-md border border-dashed border-line px-2 py-1 text-[11px] text-muted enabled:hover:border-accent/50 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-45"
      >
        <FolderOpen size={12} />
        {manual ? '직접 입력 닫기' : '다른 위치의 파일 직접 입력'}
      </button>
      {manual ? (
        <input value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} placeholder="C:\Users\사용자\.ssh\id_ed25519" className={monoInputClass} />
      ) : null}
    </div>
  );
}

function Disclosure({ open, onToggle, label, children }: { open: boolean; onToggle: () => void; label: string; children: ReactNode }) {
  return (
    <div className="mt-3 rounded-lg border border-line/70">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs text-muted hover:text-text">
        {open ? <CaretDown size={12} /> : <CaretRight size={12} />}
        {label}
      </button>
      {open ? <div className="grid gap-2 border-t border-line/70 p-3 md:grid-cols-2">{children}</div> : null}
    </div>
  );
}

export function SettingsSshPage({ readOnly }: SettingsSshPageProps) {
  const [servers, setServers] = useState<SshServerItem[]>([]);
  /** Last state confirmed by the core; used to detect unsaved edits. */
  const [saved, setSaved] = useState<SshServerItem[]>([]);
  const [draft, setDraft] = useState<AddDraft>(EMPTY_DRAFT);
  const [showAddAdvanced, setShowAddAdvanced] = useState(false);
  const [showEditAdvanced, setShowEditAdvanced] = useState(false);
  /** Password / key passphrase for the selected server. Kept in memory only. */
  const [secret, setSecret] = useState('');
  /** 「이 PC에 기억」: off by default, chosen per unlock. */
  const [remember, setRemember] = useState(false);
  const [changingSecret, setChangingSecret] = useState(false);
  const [accountDraft, setAccountDraft] = useState('');
  const [managedKeyDraft, setManagedKeyDraft] = useState('');
  const [editPort, setEditPort] = useState('22');
  const [busy, setBusy] = useState(false);
  const [prepStep, setPrepStep] = useState<'check' | 'unlock' | null>(null);
  const [checkNotes, setCheckNotes] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [activeSection, setActiveSection] = useState<'installed' | 'add'>('installed');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const secretRef = useRef<HTMLInputElement>(null);
  const pendingCarryRef = useRef<{ id: string; secret: string; remember: boolean } | null>(null);

  const applyServerState = (next: SshServerItem[]) => {
    setServers(next);
    setSaved(next);
    if (selectedId) {
      const current = next.find((item) => item.id === selectedId);
      if (current) setEditPort(String(current.port));
    }
  };

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      applyServerState(await listSshServers());
    } catch (error) {
      setMessage(friendlyError(error, 'SSH 설정을 불러오지 못했습니다.'));
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

  const selectedSaved = selectedId ? saved.find((server) => server.id === selectedId) : undefined;
  useEffect(() => {
    const carry = pendingCarryRef.current;
    if (carry && carry.id === selectedId) {
      pendingCarryRef.current = null;
      setSecret(carry.secret);
      setRemember(carry.remember);
    } else {
      setSecret('');
      setRemember(false);
    }
    setChangingSecret(false);
    setShowEditAdvanced(false);
    setAccountDraft(selectedSaved?.managed ? selectedSaved.username : '');
    setManagedKeyDraft(selectedSaved?.managed ? selectedSaved.keyPath : '');
    setEditPort(String(selectedSaved?.port ?? 22));
    // Reset only when another server is selected, not on every refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const run = async (work: () => Promise<SshServerItem[]>, successMessage: string, failMessage: string): Promise<boolean> => {
    setBusy(true);
    setMessage('');
    try {
      applyServerState(await work());
      setMessage(successMessage);
      return true;
    } catch (error) {
      setMessage(friendlyError(error, failMessage));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const validate = (server: { host: string; username: string; keyPath: string; auth?: SshServerItem['auth']; port: number }): string | null => {
    if (!server.host.trim()) return '서버 주소를 입력하세요.';
    if (!server.username.trim()) return '계정을 입력하세요.';
    if (/[\s'"`$;|&<>\\]/.test(server.host.trim())) return '서버 주소에는 공백이나 따옴표·특수 기호를 쓸 수 없습니다.';
    if (/[\s'"`$;|&<>\\]/.test(server.username.trim())) return '계정에는 공백이나 따옴표·특수 기호를 쓸 수 없습니다.';
    if (server.auth === 'key' && !server.keyPath.trim()) return '키 파일을 고르세요.';
    if (!Number.isInteger(server.port) || server.port < 1 || server.port > 65535) return '포트는 1~65535 사이 숫자여야 합니다.';
    return null;
  };

  const updateServer = (id: string, patch: Partial<SshServerItem>) => {
    setServers((current) => current.map((server) => (server.id === id && !server.managed ? { ...server, ...patch } : server)));
  };

  const discardServerChanges = (stored: SshServerItem) => {
    setServers((current) => current.map((server) => (server.id === stored.id ? stored : server)));
    setEditPort(String(stored.port));
    setMessage('');
  };

  const confirmFingerprint = (server: SshServerItem, probe: ProbeResult) => confirmDialog({
    title: probe.changed ? '서버 지문이 바뀌었습니다' : '처음 연결하는 서버 확인',
    message: [
      `${server.label || server.id} (${server.username}@${server.host}:${server.port})`,
      '',
      `지문: ${probe.fingerprint}`,
      '',
      probe.changed
        ? '이전에 확인한 지문과 다릅니다. 서버를 다시 설치했거나 키를 바꾼 적이 없다면 다른 서버가 응답한 것일 수 있습니다. 서버 관리자에게 확인한 뒤에만 계속하세요.'
        : '서버 관리자가 알려 준 지문과 같은지 확인하세요. 계속하면 앞으로 이 지문을 가진 서버에만 연결합니다.',
    ].join('\n'),
    confirmLabel: '지문이 같습니다',
    cancelLabel: '취소',
    danger: probe.changed,
  });

  /**
   * 「연결 준비」: account (managed) → server check → unlock, in one click. A managed
   * connection compares the deployed fingerprint automatically; nothing is sent on a mismatch.
   */
  const prepare = async (
    target: SshServerItem,
    opts: { secret?: string; remember?: boolean; list?: SshServerItem[] } = {},
  ) => {
    const name = target.label || target.id;
    setBusy(true);
    setMessage('');
    let current = (opts.list ?? saved).find((server) => server.id === target.id) ?? target;
    const take = (next: SshServerItem[]) => {
      applyServerState(next);
      current = next.find((server) => server.id === target.id) ?? current;
    };
    try {
      if (current.managed) {
        const username = accountDraft.trim();
        const keyPath = current.auth === 'key' ? managedKeyDraft.trim() : undefined;
        if (!username) {
          setMessage('계정을 입력한 뒤 「연결 준비」를 누르세요.');
          return;
        }
        if (current.auth === 'key' && !keyPath) {
          setMessage('키 파일을 고른 뒤 「연결 준비」를 누르세요.');
          return;
        }
        if (username !== current.username || (current.auth === 'key' && keyPath !== current.keyPath)) {
          take(await saveManagedSshAccount(current.id, username, keyPath));
        }
      }
      if (!current.trusted || current.managed) {
        setPrepStep('check');
        const probe = await testSshServer(current.id);
        if (current.managed && !probe.trusted) {
          setCheckNotes((notes) => ({ ...notes, [current.id]: `서버가 보낸 지문: ${probe.fingerprint}` }));
          setMessage('서버 지문이 배포된 값과 달라 연결하지 않았습니다. 비밀번호는 보내지 않았습니다. 운영 담당자에게 알리세요.');
          return;
        }
        if (!current.managed && !probe.trusted) {
          if (!(await confirmFingerprint(current, probe))) {
            setMessage('서버 확인을 취소했습니다. 지문을 확인한 뒤 다시 「연결 준비」를 누르세요.');
            return;
          }
          take(await trustSshServer(current.id, probe.fingerprint));
        }
      }
      if (current.keyState === 'missing') {
        setMessage('키 파일을 찾을 수 없습니다. 키 파일을 다시 고른 뒤 저장하세요.');
        return;
      }
      if (current.keyState === 'invalid') {
        setMessage('이 키 파일은 쓸 수 없습니다. 다른 키 파일을 고르세요.');
        return;
      }
      if (current.keyState !== 'ready') {
        const value = opts.secret ?? secret;
        const label = current.auth === 'password' ? '비밀번호' : '키 암호';
        if (!value) {
          setMessage(`${label}를 입력한 뒤 「연결 준비」를 누르세요.`);
          secretRef.current?.focus();
          return;
        }
        setPrepStep('unlock');
        take(await unlockSshServer(current.id, value, opts.remember ?? remember));
        pendingCarryRef.current = null;
        setSecret('');
        setRemember(false);
      }
      setCheckNotes((notes) => ({ ...notes, [current.id]: '' }));
      setMessage(`연결 준비 완료 · ${name}${current.remembered ? ' · 이 PC에 기억했습니다' : ''}`);
    } catch (error) {
      setMessage(friendlyError(error, '연결 준비에 실패했습니다.'));
      secretRef.current?.focus();
    } finally {
      setPrepStep(null);
      setBusy(false);
    }
  };

  /** Ready server: re-read the fingerprint. A changed one is shown, never trusted silently. */
  const checkAgain = async (server: SshServerItem) => {
    setBusy(true);
    setMessage('');
    try {
      const probe = await testSshServer(server.id);
      if (probe.trusted) {
        setCheckNotes((notes) => ({ ...notes, [server.id]: '서버가 확인한 지문과 같습니다.' }));
        return;
      }
      setCheckNotes((notes) => ({ ...notes, [server.id]: `주의 · 서버가 다른 지문을 보냈습니다: ${probe.fingerprint}` }));
      if (server.managed) {
        setMessage('서버 지문이 배포된 값과 다릅니다. 이 연결로는 명령을 보내지 않습니다. 운영 담당자에게 알리세요.');
        return;
      }
      if (await confirmFingerprint(server, probe)) {
        applyServerState(await trustSshServer(server.id, probe.fingerprint));
        setCheckNotes((notes) => ({ ...notes, [server.id]: '새 지문으로 확인했습니다.' }));
      }
    } catch (error) {
      setMessage(friendlyError(error, '서버 확인에 실패했습니다.'));
    } finally {
      setBusy(false);
    }
  };

  const changeSecret = async (server: SshServerItem) => {
    const label = server.auth === 'password' ? '비밀번호' : '키 암호';
    setBusy(true);
    setMessage('');
    try {
      let next = await unlockSshServer(server.id, secret, remember);
      // Unticked: an older remembered copy must not come back after a restart.
      if (!remember && next.find((item) => item.id === server.id)?.remembered) next = await forgetSshServer(server.id);
      applyServerState(next);
      const stored = next.find((item) => item.id === server.id)?.remembered === true;
      setMessage(stored
        ? `${label}를 바꾸고 이 PC에 기억했습니다.`
        : remember
          ? `${label}를 바꿨지만 이 PC에 기억하지는 못했습니다. 앱을 다시 시작하면 다시 입력해야 합니다.`
          : `${label}를 바꿨습니다. 앱을 다시 시작하면 다시 입력해야 합니다.`);
      setSecret('');
      setChangingSecret(false);
    } catch (error) {
      setMessage(friendlyError(error, '암호 변경에 실패했습니다.'));
    } finally {
      setBusy(false);
    }
  };

  const saveServer = async (server: SshServerItem) => {
    const problem = validate(server);
    if (problem) {
      setMessage(problem);
      return;
    }
    const before = saved.find((item) => item.id === server.id);
    const addressChanged = Boolean(before?.trusted) && (before?.host !== server.host || before?.port !== server.port);
    await run(
      () => saveSshServers(servers),
      `저장됨 · ${server.label || server.id}${addressChanged ? ' · 주소가 바뀌어 「연결 준비」를 다시 해야 합니다' : ''}`,
      '저장에 실패했습니다.',
    );
  };

  const saveManagedAccount = async (server: SshServerItem) => {
    const username = accountDraft.trim();
    if (!username) {
      setMessage('계정을 입력하세요.');
      return;
    }
    await run(
      () => saveManagedSshAccount(server.id, username, server.auth === 'key' ? managedKeyDraft.trim() : undefined),
      `계정을 바꿨습니다 · ${server.label} · 「연결 준비」로 다시 잠금 해제하세요`,
      '계정 저장에 실패했습니다.',
    );
  };

  const removeServer = async (server: SshServerItem) => {
    const ok = await confirmDialog({
      title: 'SSH 서버 삭제',
      message: `${server.label || server.id}을(를) 목록에서 삭제할까요?\n\n키 파일은 삭제하지 않습니다.`,
      confirmLabel: '삭제',
      cancelLabel: '취소',
      danger: true,
    });
    if (!ok) return;
    await run(() => saveSshServers(saved.filter((current) => current.id !== server.id)), `삭제됨 · ${server.label || server.id}`, '삭제에 실패했습니다.');
  };

  const addServer = async () => {
    const id = makeServerId(draft.label, draft.username, draft.host, new Set(saved.map((server) => server.id)));
    const next: SshServerItem = {
      id,
      label: draft.label.trim() || draft.host.trim(),
      host: draft.host.trim(),
      port: Number(draft.port.trim() || '22'),
      username: draft.username.trim(),
      keyPath: draft.auth === 'key' ? draft.keyPath.trim() : '',
      defaultCwd: draft.defaultCwd.trim() || undefined,
      shell: draft.shell,
      encoding: draft.encoding,
      auth: draft.auth,
      jumpServerId: draft.jumpServerId,
    };
    const problem = validate(next);
    if (problem) {
      setMessage(problem);
      return;
    }
    if (draft.auth === 'password' && !draft.secret) {
      setMessage('비밀번호를 입력하세요.');
      return;
    }
    setBusy(true);
    setMessage('');
    let list: SshServerItem[];
    try {
      list = await saveSshServers([...saved, next]);
      applyServerState(list);
    } catch (error) {
      setMessage(friendlyError(error, '서버 등록에 실패했습니다.'));
      setBusy(false);
      return;
    }
    setBusy(false);
    const typed = { secret: draft.secret || undefined, remember: draft.remember };
    pendingCarryRef.current = { id, secret: draft.secret, remember: draft.remember };
    setDraft(EMPTY_DRAFT);
    setShowAddAdvanced(false);
    setSelectedId(id);
    setActiveSection('installed');
    const created = list.find((server) => server.id === id);
    if (created) await prepare(created, { ...typed, list });
  };

  const selectedServer = selectedId ? servers.find((server) => server.id === selectedId) ?? null : null;
  const managed = selectedSaved?.managed === true;
  const dirty = Boolean(selectedServer) && !managed && editableKey(selectedServer ?? undefined) !== editableKey(selectedSaved);
  const connectionDirty = Boolean(selectedServer && selectedSaved && (
    selectedServer.host !== selectedSaved.host
    || selectedServer.port !== selectedSaved.port
    || selectedServer.username !== selectedSaved.username
    || (selectedServer.auth ?? 'key') !== (selectedSaved.auth ?? 'key')
    || (selectedServer.auth !== 'password' && selectedServer.keyPath !== selectedSaved.keyPath)
  ));
  const ready = isReady(selectedSaved);
  const credentialLabel = selectedSaved?.auth === 'password' ? '비밀번호' : '키 암호';
  const remembered = selectedSaved?.rememberState === 'stored';
  const keyState = selectedSaved?.keyState ?? 'unknown';
  const accountChanged = managed && (
    accountDraft.trim() !== (selectedSaved?.username ?? '')
    || (selectedSaved?.auth === 'key' && managedKeyDraft.trim() !== (selectedSaved?.keyPath ?? ''))
  );
  const localServers = saved.filter((server) => !server.managed);

  const prepSteps = selectedSaved ? [
    ...(managed ? [{ label: '내 계정 입력', done: Boolean(accountDraft.trim()) }] : []),
    {
      label: managed ? '서버 확인 · 배포된 지문과 자동 대조' : '서버 확인 · 처음 한 번 지문 확인',
      done: managed || selectedSaved.trusted === true,
    },
    {
      label: selectedSaved.needsSecret === false ? '키 파일 확인' : `${credentialLabel} 확인`,
      done: keyState === 'ready',
    },
  ] : [];

  const readyText = !selectedSaved?.needsSecret
    ? '키 파일로 바로 연결됩니다.'
    : remembered
      ? `${credentialLabel}가 이 PC에 기억돼 있어 앱을 다시 시작해도 바로 연결됩니다.`
      : `이번 실행 동안만 연결할 수 있습니다. 앱을 다시 시작하면 ${credentialLabel}를 다시 입력합니다.`;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-ink px-8 py-7">
      <header className="mb-6 pr-12">
        <h2 className="text-xl font-semibold">SSH 서버</h2>
        <p className="mt-1 text-sm text-muted">서버를 연결해 두면 폴더가 연결된 에이전트 대화에서 AI가 명령 1개를 제안하고, 사용자가 승인한 뒤에만 실행합니다.</p>
      </header>

      {message ? <p className="mb-5 rounded-xl border border-line bg-panel px-4 py-3 text-sm text-muted" role="status">{message}</p> : null}

      <div className="mb-5 flex max-w-3xl gap-1 rounded-xl border border-line bg-panel p-1" role="tablist" aria-label="SSH 서버 관리 범주">
        <button
          type="button"
          role="tab"
          aria-selected={activeSection === 'installed'}
          onClick={() => setActiveSection('installed')}
          className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium ${activeSection === 'installed' ? 'bg-ink text-text shadow-sm' : 'text-muted hover:text-text'}`}
        >
          연결 목록 <span className="ml-1 text-xs text-muted">{servers.length}</span>
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
            <h3 className="font-semibold">연결 목록</h3>
            <p className="mt-0.5 text-xs text-muted">서버 주소와 키 파일 위치만 저장합니다. 비밀번호는 「이 PC에 기억」을 켠 경우에만 이 Windows 계정으로 암호화해 저장합니다.</p>
          </div>
        </div>
        {busy && servers.length === 0 ? <p className="py-4 text-sm text-muted">불러오는 중...</p> : null}
        {!busy && servers.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line px-4 py-8 text-center">
            <p className="text-sm text-muted">연결된 서버가 없습니다.</p>
            <button type="button" onClick={() => setActiveSection('add')} className="mt-3 rounded-lg bg-accent/15 px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/25">서버 추가</button>
          </div>
        ) : null}
        {servers.length > 0 ? (
          <div className="grid items-start gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
            <div className="space-y-1 rounded-xl border border-line bg-ink/35 p-2">
              {servers.map((server) => {
                const stored = saved.find((item) => item.id === server.id);
                const serverReady = isReady(stored);
                return (
                  <button
                    key={server.id}
                    type="button"
                    onClick={() => setSelectedId(server.id)}
                    className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-left ${selectedId === server.id ? 'bg-panel text-text shadow-sm' : 'text-muted hover:bg-panel/70 hover:text-text'}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">{server.label || server.host}</span>
                      <span className="block truncate text-[10px] text-muted">{server.managed ? '조직 배포 연결' : shellLabel(server.shell)}</span>
                    </span>
                    <span className={`h-2 w-2 shrink-0 rounded-full ${serverReady ? 'bg-accent' : 'bg-amber-400/80'}`} title={serverReady ? '연결 준비 완료' : '연결 준비 필요'} />
                  </button>
                );
              })}
              <div className="border-t border-line/60 pt-1">
                <button
                  type="button"
                  disabled={readOnly || busy}
                  onClick={() => setActiveSection('add')}
                  className="flex w-full items-center gap-1.5 rounded-lg px-3 py-2 text-left text-xs text-muted enabled:hover:bg-panel/70 enabled:hover:text-accent disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <Plus size={13} />
                  서버 추가
                </button>
              </div>
            </div>

            {selectedServer && selectedSaved ? (
              <div className="rounded-xl border border-line bg-ink/25 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="min-w-0 truncate text-sm font-medium text-text">{selectedSaved.label || selectedSaved.host}</p>
                  {ready
                    ? <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-accent/15 px-2 py-1 text-[10px] text-accent"><CheckCircle size={12} weight="fill" /> 연결 준비 완료</span>
                    : <span className="rounded-md bg-amber-400/15 px-2 py-1 text-[10px] text-amber-300">연결 준비 필요</span>}
                  {managed ? <span className="inline-flex items-center gap-1 rounded-md bg-line px-2 py-1 text-[10px] text-muted"><Buildings size={12} /> 조직 배포{selectedSaved.managedBy ? ` · ${selectedSaved.managedBy}` : ''}</span> : null}
                </div>

                {dirty ? (
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-400/35 bg-amber-400/5 px-3 py-2.5">
                    <p className="text-xs text-muted">
                      {!ready || connectionDirty
                        ? '저장하지 않은 변경이 있습니다. 먼저 저장해야 새 설정으로 연결을 준비할 수 있습니다.'
                        : '저장하지 않은 변경이 있습니다.'}
                    </p>
                    <div className="flex items-center gap-1.5">
                      <button type="button" disabled={readOnly || busy} onClick={() => void saveServer(selectedServer)} className="rounded-lg bg-accent/15 px-2.5 py-1 text-xs font-medium text-accent hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-45">저장</button>
                      <button type="button" disabled={busy} onClick={() => discardServerChanges(selectedSaved)} className={secondaryButton}><ArrowCounterClockwise size={12} /> 변경 취소</button>
                    </div>
                  </div>
                ) : null}

                {!ready && !dirty ? (
                  <div className="mt-3 rounded-xl border border-accent/40 bg-accent/5 p-3" data-testid="ssh-prep-banner">
                    <p className="text-sm font-medium text-text">연결 준비</p>
                    <p className="mt-0.5 text-[11px] text-muted">아래 단추 하나로 남은 단계를 차례로 끝냅니다.</p>
                    <ol className="mt-2 space-y-1">
                      {prepSteps.map((step, index) => (
                        <li key={step.label} className={`flex items-center gap-2 text-xs ${step.done ? 'text-text' : 'text-muted'}`}>
                          {step.done
                            ? <CheckCircle size={15} weight="fill" className="shrink-0 text-accent" />
                            : <span className="inline-flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full border border-line text-[9px]">{index + 1}</span>}
                          {step.label}
                        </li>
                      ))}
                    </ol>
                    {selectedSaved.rememberState === 'unreadable' ? (
                      <p className="mt-2 text-[11px] text-muted">
                        기억한 암호를 이 PC·이 Windows 계정에서 열 수 없습니다.{' '}
                        <button type="button" disabled={readOnly || busy} className="underline underline-offset-2 hover:text-text" onClick={() => void run(() => retrySshRecall(selectedSaved.id), '기억한 암호를 다시 확인했습니다.', '다시 확인에 실패했습니다.')}>다시 확인</button>
                      </p>
                    ) : null}
                    {managed ? (
                      <div className="mt-3 grid gap-2 md:grid-cols-2">
                        <label className="text-[11px] text-muted">
                          내 계정
                          <input value={accountDraft} onChange={(event) => setAccountDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !readOnly && !busy) void prepare(selectedSaved); }} disabled={readOnly || busy} placeholder="서버 로그인 계정" className={monoInputClass} />
                        </label>
                        {selectedSaved.auth === 'key' ? <KeyPicker value={managedKeyDraft} onChange={setManagedKeyDraft} disabled={readOnly || busy} /> : null}
                      </div>
                    ) : null}
                    {keyState !== 'ready' && selectedSaved.needsSecret !== false ? (
                      <div className="mt-3 flex flex-wrap items-end gap-3">
                        <label className="min-w-[220px] flex-1 text-[11px] text-muted">
                          {credentialLabel}
                          <input ref={secretRef} type="password" autoComplete="off" value={secret} onChange={(event) => setSecret(event.target.value)} disabled={readOnly || busy} placeholder={credentialLabel} className={inputClass} onKeyDown={(event) => { if (event.key === 'Enter' && secret) void prepare(selectedSaved); }} />
                        </label>
                        <label className="flex items-center gap-1.5 pb-2 text-[11px] text-muted" title="이 Windows 계정으로 로그인했을 때만 풀리게 암호화해 저장합니다.">
                          <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} disabled={readOnly || busy} />
                          이 PC에 기억
                        </label>
                      </div>
                    ) : null}
                    {checkNotes[selectedSaved.id] ? <p className="mt-2 break-all font-mono text-[11px] text-red-300">{checkNotes[selectedSaved.id]}</p> : null}
                    <button type="button" disabled={readOnly || busy} onClick={() => void prepare(selectedSaved)} className={`${primaryButton} mt-3`} data-testid="ssh-prepare">
                      <ShieldCheck size={14} weight="bold" />
                      {prepStep === 'check' ? '서버 확인 중...' : prepStep === 'unlock' ? '잠금 해제 중...' : '연결 준비'}
                    </button>
                  </div>
                ) : null}

                {ready && !dirty ? (
                  <div className="mt-3 rounded-xl border border-line bg-ink/30 p-3" data-testid="ssh-ready-panel">
                    <p className="flex items-center gap-1.5 text-sm text-text"><CheckCircle size={15} weight="fill" className="text-accent" /> 연결 준비 완료</p>
                    <p className="mt-1 text-xs text-muted">{readyText}</p>
                    {selectedSaved.needsSecret ? (changingSecret ? (
                      <div className="mt-3 flex flex-wrap items-end gap-3">
                        <label className="min-w-[220px] flex-1 text-[11px] text-muted">
                          새 {credentialLabel}
                          <input
                            type="password"
                            autoComplete="off"
                            autoFocus
                            value={secret}
                            onChange={(event) => setSecret(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' && secret && !readOnly && !busy) void changeSecret(selectedSaved);
                              if (event.key === 'Escape' && !busy) { setChangingSecret(false); setSecret(''); }
                            }}
                            disabled={readOnly || busy}
                            placeholder={credentialLabel}
                            className={inputClass}
                          />
                        </label>
                        <label className="flex items-center gap-1.5 pb-2 text-[11px] text-muted">
                          <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} disabled={readOnly || busy} />
                          이 PC에 기억
                        </label>
                        <button type="button" disabled={readOnly || busy || !secret} onClick={() => void changeSecret(selectedSaved)} className={secondaryButton}><Key size={13} /> 저장</button>
                        <button type="button" disabled={busy} onClick={() => { setChangingSecret(false); setSecret(''); }} className={secondaryButton}>취소</button>
                      </div>
                    ) : (
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button type="button" disabled={readOnly || busy} onClick={() => { setChangingSecret(true); setSecret(''); setRemember(remembered); }} className={secondaryButton}><Key size={13} /> 암호 변경</button>
                        <button type="button" disabled={readOnly || busy} onClick={() => void run(() => lockSshServer(selectedSaved.id), `잠갔습니다 · ${selectedSaved.label} · 메모리와 이 PC에 기억한 암호를 지웠습니다.`, '잠그기에 실패했습니다.')} className={secondaryButton}><LockSimple size={13} /> 지금 잠그기</button>
                      </div>
                    )) : null}
                  </div>
                ) : null}

                {managed ? (
                  <div className="mt-3 grid gap-2 rounded-xl border border-line/70 p-3 text-[11px] text-muted md:grid-cols-2">
                    <p>서버 주소<span className="mt-0.5 block font-mono text-xs text-text">{selectedSaved.host}:{selectedSaved.port}</span></p>
                    <p>서버 종류<span className="mt-0.5 block text-xs text-text">{shellLabel(selectedSaved.shell)}</span></p>
                    <p className="md:col-span-2">고정 지문 (배포된 값과 자동 대조)<span className="mt-0.5 block break-all font-mono text-[11px] text-text">{selectedSaved.hostKeySha256}</span></p>
                    {ready ? (
                      <>
                        <label className="text-[11px] text-muted">
                          내 계정
                          <input value={accountDraft} onChange={(event) => setAccountDraft(event.target.value)} disabled={readOnly || busy} className={monoInputClass} />
                        </label>
                        {selectedSaved.auth === 'key' ? <KeyPicker value={managedKeyDraft} onChange={setManagedKeyDraft} disabled={readOnly || busy} /> : null}
                        {accountChanged ? (
                          <div className="md:col-span-2">
                            <button type="button" disabled={readOnly || busy} onClick={() => void saveManagedAccount(selectedSaved)} className={secondaryButton}>계정 저장</button>
                          </div>
                        ) : null}
                      </>
                    ) : null}
                    <p className="md:col-span-2">주소와 지문은 조직이 배포해 바꿀 수 없습니다. 계정과 비밀번호는 이 PC에만 있습니다.</p>
                  </div>
                ) : (
                  <>
                    <div className="mt-3 grid gap-2 md:grid-cols-2">
                      <label className="text-[11px] text-muted">
                        이름
                        <input value={selectedServer.label} onChange={(event) => updateServer(selectedServer.id, { label: event.target.value })} disabled={readOnly || busy} placeholder="개발 서버" className={inputClass} />
                      </label>
                      <label className="text-[11px] text-muted">
                        서버 주소
                        <input value={selectedServer.host} onChange={(event) => updateServer(selectedServer.id, { host: event.target.value })} disabled={readOnly || busy} placeholder="192.168.0.10" className={monoInputClass} />
                      </label>
                      <label className="text-[11px] text-muted">
                        계정
                        <input value={selectedServer.username} onChange={(event) => updateServer(selectedServer.id, { username: event.target.value })} disabled={readOnly || busy} placeholder="deploy" className={monoInputClass} />
                      </label>
                      <div className="text-[11px] text-muted">
                        인증 방식
                        <AuthChoice value={selectedServer.auth === 'password' ? 'password' : 'key'} onChange={(auth) => updateServer(selectedServer.id, { auth })} disabled={readOnly || busy} />
                      </div>
                      {selectedServer.auth !== 'password' ? <KeyPicker value={selectedServer.keyPath} onChange={(keyPath) => updateServer(selectedServer.id, { keyPath })} disabled={readOnly || busy} /> : null}
                    </div>
                    <Disclosure open={showEditAdvanced} onToggle={() => setShowEditAdvanced((open) => !open)} label="고급 설정 (포트·서버 종류·인코딩·기본 폴더·경유 서버)">
                      <label className="text-[11px] text-muted">
                        포트
                        <input
                          value={editPort}
                          onChange={(event) => {
                            const raw = event.target.value.replace(/\D/g, '');
                            setEditPort(raw);
                            updateServer(selectedServer.id, { port: raw === '' ? 22 : Number(raw) });
                          }}
                          onBlur={() => { if (!editPort) setEditPort(String(selectedServer.port)); }}
                          disabled={readOnly || busy}
                          inputMode="numeric"
                          placeholder="22"
                          className={monoInputClass}
                        />
                      </label>
                      <label className="text-[11px] text-muted">
                        서버 종류
                        <select value={selectedServer.shell ?? 'posix'} onChange={(event) => updateServer(selectedServer.id, { shell: event.target.value as SshShell })} disabled={readOnly || busy} className={inputClass}>
                          {SHELL_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                      </label>
                      <label className="text-[11px] text-muted">
                        출력 인코딩
                        <select className={inputClass} disabled={readOnly || busy} value={selectedServer.encoding ?? ''} onChange={(event) => updateServer(selectedServer.id, { encoding: (event.target.value || undefined) as SshServerItem['encoding'] })}>
                          <option value="">자동</option>
                          <option value="utf8">UTF-8</option>
                          <option value="cp949">한글 Windows</option>
                        </select>
                      </label>
                      <label className="text-[11px] text-muted">
                        기본 폴더 (서버, 선택)
                        <input value={selectedServer.defaultCwd ?? ''} onChange={(event) => updateServer(selectedServer.id, { defaultCwd: event.target.value || undefined })} disabled={readOnly || busy} placeholder={FOLDER_PLACEHOLDER[selectedServer.shell ?? 'posix']} className={monoInputClass} />
                      </label>
                      <label className="text-[11px] text-muted md:col-span-2">
                        경유 서버
                        <select disabled={readOnly || busy} className={inputClass} value={selectedServer.jumpServerId ?? ''} onChange={(event) => updateServer(selectedServer.id, { jumpServerId: event.target.value || undefined })}>
                          <option value="">직접 연결</option>
                          {localServers.filter((item) => item.id !== selectedServer.id && !item.jumpServerId).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                        </select>
                      </label>
                    </Disclosure>
                  </>
                )}

                {checkNotes[selectedSaved.id] && ready ? <p className="mt-2 break-all text-[11px] text-muted">{checkNotes[selectedSaved.id]}</p> : null}

                <div className="mt-3 flex flex-wrap gap-2">
                  {ready && !dirty ? (
                    <button type="button" disabled={busy} onClick={() => void checkAgain(selectedSaved)} className={secondaryButton}>
                      <Wrench size={13} /> 서버 다시 확인
                    </button>
                  ) : null}
                  {!managed ? (
                    <>
                      <button type="button" disabled={readOnly || busy || !dirty} onClick={() => void saveServer(selectedServer)} className="rounded-lg bg-accent/15 px-2.5 py-1.5 text-xs font-medium text-accent hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-45">저장</button>
                      {dirty ? (
                        <button type="button" disabled={busy} onClick={() => discardServerChanges(selectedSaved)} className={secondaryButton}>
                          <ArrowCounterClockwise size={13} /> 변경 취소
                        </button>
                      ) : null}
                      <button type="button" disabled={readOnly || busy} onClick={() => void removeServer(selectedServer)} className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted enabled:hover:border-red-400/50 enabled:hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-45">
                        <Trash size={13} /> 삭제
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </section> : null}

      {activeSection === 'add' ? <section className="max-w-3xl rounded-2xl border border-line bg-panel p-5 shadow-sm">
        <div className="mb-4 flex items-center gap-2">
          <Plus size={19} className="text-accent" />
          <div>
            <h3 className="font-semibold">서버 추가</h3>
            <p className="mt-0.5 text-xs text-muted">이름·서버 주소·계정·비밀번호만 넣으면 등록과 연결 준비를 한 번에 합니다. 처음 연결할 때 서버 지문을 한 번 확인합니다.</p>
          </div>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!readOnly && !busy) void addServer();
          }}
          className="rounded-xl border border-line bg-ink/25 p-3.5"
        >
          <div className="grid gap-2 md:grid-cols-2">
            <label className="text-[11px] text-muted">
              이름
              <input value={draft.label} onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))} disabled={readOnly || busy} placeholder="개발 서버" className={inputClass} />
            </label>
            <label className="text-[11px] text-muted">
              서버 주소
              <input value={draft.host} onChange={(event) => setDraft((current) => ({ ...current, host: event.target.value }))} disabled={readOnly || busy} placeholder="192.168.0.10" className={monoInputClass} />
            </label>
            <label className="text-[11px] text-muted">
              계정
              <input value={draft.username} onChange={(event) => setDraft((current) => ({ ...current, username: event.target.value }))} disabled={readOnly || busy} placeholder="deploy" className={monoInputClass} />
            </label>
            <div className="text-[11px] text-muted">
              인증 방식
              <AuthChoice value={draft.auth} onChange={(auth) => setDraft((current) => ({ ...current, auth }))} disabled={readOnly || busy} />
            </div>
            {draft.auth === 'key' ? <KeyPicker value={draft.keyPath} onChange={(keyPath) => setDraft((current) => ({ ...current, keyPath }))} disabled={readOnly || busy} /> : null}
            <div className="flex flex-wrap items-end gap-3 md:col-span-2">
              <label className="min-w-[220px] flex-1 text-[11px] text-muted">
                {draft.auth === 'password' ? '비밀번호' : '키 암호 (키에 암호가 있을 때만)'}
                <input type="password" autoComplete="off" value={draft.secret} onChange={(event) => setDraft((current) => ({ ...current, secret: event.target.value }))} disabled={readOnly || busy} placeholder={draft.auth === 'password' ? '비밀번호' : '없으면 비워 두세요'} className={inputClass} />
              </label>
              <label className="flex items-center gap-1.5 pb-2 text-[11px] text-muted" title="이 Windows 계정으로 로그인했을 때만 풀리게 암호화해 저장합니다. 켜지 않으면 앱을 다시 시작할 때 다시 입력합니다.">
                <input type="checkbox" checked={draft.remember} onChange={(event) => setDraft((current) => ({ ...current, remember: event.target.checked }))} disabled={readOnly || busy} />
                이 PC에 기억
              </label>
            </div>
          </div>
          <Disclosure open={showAddAdvanced} onToggle={() => setShowAddAdvanced((open) => !open)} label="고급 설정 (포트·서버 종류·인코딩·기본 폴더·경유 서버)">
            <label className="text-[11px] text-muted">
              포트
              <input value={draft.port} onChange={(event) => setDraft((current) => ({ ...current, port: event.target.value.replace(/\D/g, '') }))} disabled={readOnly || busy} inputMode="numeric" placeholder="22" className={monoInputClass} />
            </label>
            <label className="text-[11px] text-muted">
              서버 종류
              <select value={draft.shell} onChange={(event) => setDraft((current) => ({ ...current, shell: event.target.value as SshShell }))} disabled={readOnly || busy} className={inputClass}>
                {SHELL_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label className="text-[11px] text-muted">
              출력 인코딩
              <select className={inputClass} disabled={readOnly || busy} value={draft.encoding ?? ''} onChange={(event) => setDraft((current) => ({ ...current, encoding: (event.target.value || undefined) as SshServerItem['encoding'] }))}>
                <option value="">자동</option>
                <option value="utf8">UTF-8</option>
                <option value="cp949">한글 Windows</option>
              </select>
            </label>
            <label className="text-[11px] text-muted">
              기본 폴더 (서버, 선택)
              <input value={draft.defaultCwd} onChange={(event) => setDraft((current) => ({ ...current, defaultCwd: event.target.value }))} disabled={readOnly || busy} placeholder={FOLDER_PLACEHOLDER[draft.shell]} className={monoInputClass} />
            </label>
            <label className="text-[11px] text-muted md:col-span-2">
              경유 서버
              <select disabled={readOnly || busy} className={inputClass} value={draft.jumpServerId ?? ''} onChange={(event) => setDraft((current) => ({ ...current, jumpServerId: event.target.value || undefined }))}>
                <option value="">직접 연결</option>
                {localServers.filter((item) => !item.jumpServerId).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
          </Disclosure>
          <button type="submit" disabled={readOnly || busy} className={`${primaryButton} mt-4`} data-testid="ssh-add-and-prepare">
            <Plus size={14} weight="bold" />
            등록하고 연결 준비
          </button>
        </form>
        {servers.some((server) => server.managed) ? (
          <p className="mt-3 flex items-center gap-1.5 text-[11px] text-muted"><Warning size={12} /> 조직이 배포한 연결은 「연결 목록」에서 계정과 비밀번호만 넣으면 됩니다.</p>
        ) : null}
      </section> : null}
    </div>
  );
}
