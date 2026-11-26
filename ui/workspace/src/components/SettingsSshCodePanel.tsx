import { CaretDown, CaretRight, Check, CheckCircle, Copy, Eye, EyeSlash, Info, Warning, WarningCircle } from '@phosphor-icons/react';
import { useEffect, useState, type ReactNode } from 'react';
import { makeSshDeviceCode, SshPendingInvite, useSshCode, type SshServerItem } from '../api/myAgentClient';

/* Shared look for the SSH settings panels: same input, three button weights, read-only code box. */
export const field = 'mt-1 block w-full rounded-lg border border-line bg-panel px-2.5 py-2 text-xs text-text outline-none focus:border-accent disabled:opacity-60';
export const primaryBtn = 'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-45';
export const secondaryBtn = 'inline-flex shrink-0 items-center justify-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted enabled:hover:border-accent/50 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-45';
export const dangerBtn = 'inline-flex shrink-0 items-center justify-center gap-1 rounded-lg border border-red-400/30 bg-red-500/5 px-2.5 py-1.5 text-xs text-red-300 enabled:hover:border-red-400/60 enabled:hover:bg-red-500/15 disabled:cursor-not-allowed disabled:opacity-45';
/** Kept for older call sites: the secondary weight. */
export const button = secondaryBtn;
export const fpBadge = 'rounded-md bg-accent/15 px-1.5 py-0.5 font-mono text-[11px] text-accent';

export function shareError(e: unknown) { return e instanceof Error ? e.message.replace(/^SSH_[A-Z_]+ · /, '') : '작업을 마치지 못했습니다. 다시 시도하세요.'; }

function useCopy(value: string) {
  const [state, setState] = useState<'' | 'ok' | 'fail'>('');
  useEffect(() => setState(''), [value]);
  useEffect(() => {
    if (!state) return;
    const timer = setTimeout(() => setState(''), 2000);
    return () => clearTimeout(timer);
  }, [state]);
  const copy = () => void navigator.clipboard.writeText(value).then(() => setState('ok'), () => setState('fail'));
  return [state, copy] as const;
}

export function CopyText({ value, label = '복사' }: { value: string; label?: string }) {
  const [state, copy] = useCopy(value);
  return (
    <span className="inline-flex items-center gap-1.5">
      <button type="button" className={secondaryBtn} disabled={!value} onClick={copy}>
        {state === 'ok' ? <Check size={13} weight="bold" className="text-accent" /> : <Copy size={13} />}
        {state === 'ok' ? '복사됨' : label}
      </button>
      <span aria-live="polite" className="text-[11px] text-muted">{state === 'fail' ? '텍스트를 선택해 복사하세요.' : ''}</span>
    </span>
  );
}

/** Read-only code/command with its copy button. No resize handle, long values wrap. */
export function CodeBox({ value, label, copyLabel = '복사' }: { value: string; label: string; copyLabel?: string }) {
  const [state, copy] = useCopy(value);
  return (
    <div className="text-[11px] text-muted">
      <span>{label}</span>
      <div className="mt-1 flex items-start gap-2 rounded-lg border border-line bg-ink/80 px-3 py-2">
        <code aria-label={label} tabIndex={0} className="max-h-24 min-w-0 flex-1 select-all overflow-y-auto break-all font-mono text-[11px] leading-relaxed text-text">{value}</code>
        <button type="button" className={secondaryBtn} onClick={copy} aria-label={`${label} ${copyLabel}`}>
          {state === 'ok' ? <Check size={13} weight="bold" className="text-accent" /> : <Copy size={13} />}
          {state === 'ok' ? '복사됨' : copyLabel}
        </button>
      </div>
      <span aria-live="polite">{state === 'fail' ? '텍스트를 선택해 복사하세요.' : ''}</span>
    </div>
  );
}

/** Folding box with the same caret style as the rest of the settings screens. */
export function Collapse({ label, children, defaultOpen = false, open: openProp, onToggle, className = '' }: { label: ReactNode; children: ReactNode; defaultOpen?: boolean; open?: boolean; onToggle?: (open: boolean) => void; className?: string }) {
  const [own, setOwn] = useState(defaultOpen);
  const open = openProp ?? own;
  const toggle = () => { const next = !open; if (openProp === undefined) setOwn(next); onToggle?.(next); };
  return (
    <div className={`rounded-lg border border-line/70 ${className}`}>
      <button type="button" onClick={toggle} aria-expanded={open} className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs text-muted hover:text-text">
        {open ? <CaretDown size={12} /> : <CaretRight size={12} />}
        {label}
      </button>
      {open ? <div className="space-y-2 border-t border-line/70 p-3 text-xs">{children}</div> : null}
    </div>
  );
}

export type NoticeTone = 'info' | 'success' | 'warning' | 'error';
const NOTICE_STYLE: Record<NoticeTone, string> = {
  info: 'border-line bg-ink/40 text-muted',
  success: 'border-accent/40 bg-accent/5 text-text',
  warning: 'border-amber-400/40 bg-amber-400/5 text-amber-200',
  error: 'border-red-400/40 bg-red-500/5 text-red-200',
};
/** Status line. Renders nothing when there is nothing to say, so it never leaves an empty gap. */
export function Notice({ tone = 'info', children, className = '' }: { tone?: NoticeTone; children?: ReactNode; className?: string }) {
  if (!children) return <span role="status" aria-live="polite" className="sr-only" />;
  const Icon = tone === 'success' ? CheckCircle : tone === 'warning' ? Warning : tone === 'error' ? WarningCircle : Info;
  return (
    <p role="status" aria-live="polite" className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${NOTICE_STYLE[tone]} ${className}`}>
      <Icon size={14} className="mt-px shrink-0" weight={tone === 'success' ? 'fill' : 'regular'} />
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
}

/**
 * One code box. Without expectedId it is the top bar of 「연결한 서버」; with expectedId it
 * refreshes the address of that shared connection in place.
 */
export function SettingsSshCodePanel({ readOnly, expectedId, onConnected, onPending, onCancel }: { readOnly: boolean; expectedId?: string; onConnected: (s: SshServerItem[], id: string) => void; onPending: (e: SshPendingInvite) => void; onCancel?: () => void }) {
  const [code, setCode] = useState(''), [show, setShow] = useState(false);
  const [msg, setMsg] = useState<{ tone: NoticeTone; text: string }>(), [busy, working] = useState(false);
  async function connect() {
    working(true); setMsg({ tone: 'info', text: '서버 찾는 중 → 지문 확인 → 등록' });
    try {
      const r = await useSshCode(code.trim(), expectedId);
      setCode('');
      if (r.kind === 'key-request') setMsg({ tone: 'warning', text: '팀원이 보낸 열쇠 코드입니다 · 서버의 「팀원 초대」에 붙여 넣으세요.' });
      else { setMsg(undefined); onConnected(r.servers, r.id); }
    } catch (e) {
      if (e instanceof SshPendingInvite) { setCode(''); setMsg(undefined); onPending(e); } else setMsg({ tone: 'error', text: shareError(e) });
    } finally { working(false); }
  }
  const label = expectedId ? '새 연결 코드 또는 초대 코드' : '받은 연결 코드 또는 초대 코드';
  return (
    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (!readOnly && !busy && code.trim()) void connect(); }}>
      <label className="block text-[11px] text-muted" htmlFor={expectedId ? `ssh-code-${expectedId}` : 'ssh-code'}>{label}</label>
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <input id={expectedId ? `ssh-code-${expectedId}` : 'ssh-code'} className={`${field} mt-0 pr-9 font-mono`} value={code} type={show ? 'text' : 'password'} placeholder="MYAGENT-SSH1. 로 시작하는 코드 붙여 넣기" autoComplete="off" spellCheck={false} maxLength={4096} disabled={busy || readOnly} autoFocus={Boolean(expectedId)} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape' && onCancel && !busy) onCancel(); }} />
          <button type="button" className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted hover:text-text" aria-label={show ? '코드 가리기' : '코드 보기'} aria-pressed={show} onClick={() => setShow((v) => !v)}>
            {show ? <EyeSlash size={15} /> : <Eye size={15} />}
          </button>
        </div>
        <button className={primaryBtn} disabled={busy || readOnly || !code.trim()}>{busy ? '연결 중…' : expectedId ? '갱신' : '연결'}</button>
        {onCancel ? <button type="button" className={secondaryBtn} disabled={busy} onClick={onCancel}>취소</button> : null}
      </div>
      <Notice tone={msg?.tone}>{msg?.text}</Notice>
    </form>
  );
}

/** 「내 열쇠 코드」: shown right away; the name button appears only after the name is edited. */
export function SettingsSshMyKeyPanel({ readOnly }: { readOnly: boolean }) {
  const [label, setLabel] = useState(''), [saved, setSaved] = useState(''), [fp, setFp] = useState(''), [keyCode, setKeyCode] = useState('');
  const [busy, working] = useState(false), [msg, setMsg] = useState('');
  async function load(name?: string) {
    working(true); setMsg('');
    try { const r = await makeSshDeviceCode(name); setLabel(r.deviceKey.device_label); setSaved(r.deviceKey.device_label); setFp(r.deviceKey.key_fp); setKeyCode(r.code); }
    catch (e) { setMsg(shareError(e)); } finally { working(false); }
  }
  useEffect(() => { if (!readOnly) void load(); }, [readOnly]);
  const renamed = label.trim() !== '' && label.trim() !== saved;
  return (
    <div className="space-y-3 rounded-xl border border-line bg-ink/25 p-3.5 text-xs" data-testid="ssh-my-key">
      <div>
        <p className="text-sm font-medium text-text">팀원 초대 받기 · 내 열쇠 코드</p>
        <p className="mt-0.5 text-[11px] text-muted">리눅스·NAS·클라우드 서버의 관리자에게 이 코드를 보내면, 관리자가 초대 코드를 돌려줍니다.</p>
      </div>
      <div className="text-[11px] text-muted"><label htmlFor="ssh-my-key-name">이 PC 이름</label>
        <span className="mt-1 flex gap-2">
          <input id="ssh-my-key-name" className={`${field} mt-0`} value={label} placeholder="비워 두면 이 컴퓨터 이름" maxLength={80} onChange={(e) => setLabel(e.target.value)} disabled={readOnly || busy} />
          {renamed ? <button type="button" className={secondaryBtn} disabled={readOnly || busy} onClick={() => void load(label.trim())}>이름 적용</button> : null}
        </span>
      </div>
      {busy && !keyCode ? <p className="text-muted">열쇠 코드를 준비하는 중…</p> : null}
      {keyCode ? <>
        <p className="flex flex-wrap items-center gap-2 text-[11px] text-muted"><span>비밀이 아닙니다 · 서버 관리자에게 보내세요.</span><span>지문 끝 6자리 <b className={fpBadge}>{fp.slice(-6)}</b></span></p>
        <CodeBox label="내 열쇠 코드" value={keyCode} />
      </> : null}
      <Notice tone="error">{msg}</Notice>
    </div>
  );
}
