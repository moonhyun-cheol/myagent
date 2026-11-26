import { Desktop, FolderOpen, Info, PencilSimple, Plugs, Power, ShieldWarning } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { changeSshHost, getSshHost, type SshHostState } from '../api/myAgentClient';
import { confirmDialog } from '../lib/confirmDialog';
import { FolderBrowserModal } from './FolderBrowserModal';
import { CodeBox, Collapse, CopyText, dangerBtn, field, fpBadge, Notice, primaryBtn, secondaryBtn, shareError } from './SettingsSshCodePanel';

const WARNING = '연결한 기기는 이 PC에서 MY Agent를 실행한 Windows 계정과 같은 권한으로 명령을 실행합니다. 시작 폴더는 처음 위치일 뿐 울타리가 아닙니다. 내 PC는 내 기기만, 공용 PC는 공용 계정으로 쓰세요.';

const clock = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

export function SettingsSshHostPanel({ readOnly, onGeneral }: { readOnly: boolean; onGeneral: () => void }) {
  const [h, status] = useState<SshHostState>(), [msg, message] = useState(''), [busy, working] = useState(false), [folder, browse] = useState(false);
  const [label, setLabel] = useState(''), [cwd, setCwd] = useState(''), [shell, setShell] = useState<'powershell' | 'cmd'>('powershell'), [port, setPort] = useState('');
  const [ticket, setTicket] = useState<{ code: string; expires: string }>(), [editing, setEditing] = useState<{ id: string; name: string }>();
  const [warnOpen, setWarnOpen] = useState(false), [now, setNow] = useState(() => Date.now());
  const seq = useRef(0);
  useEffect(() => {
    let active = true, first = true;
    async function tick() {
      const rev = seq.current;
      try {
        const { status: s } = await getSshHost();
        if (!active || rev !== seq.current) return;
        status(s);
        if (first) { first = false; setLabel(s.label); setCwd(s.defaultCwd); setPort(s.port ? String(s.port) : ''); setShell(s.shell); }
      } catch (e) { if (active) message(shareError(e)); }
    }
    void tick();
    const timer = setInterval(() => void tick(), 3000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  // One-second clock only while a code is waiting, so the countdown moves smoothly.
  useEffect(() => {
    if (!ticket) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticket]);
  async function act(op: Parameters<typeof changeSshHost>[0], body: object = {}) {
    working(true); message(''); seq.current++;
    try {
      if (op === 'open') await changeSshHost('settings', { label, defaultCwd: cwd, shell, ...(port ? { port: Number(port) } : {}) });
      const r = await changeSshHost(op, body); status(r.status); if (r.status.port) setPort(String(r.status.port));
      if (r.code && r.status.expiresAt) setTicket({ code: r.code, expires: r.status.expiresAt }); else if (!r.status.expiresAt) setTicket(undefined);
      return true;
    } catch (e) { message(shareError(e)); return false; } finally { seq.current++; working(false); }
  }
  const revoke = async (id: string, name: string) => {
    if (await confirmDialog({ title: '이 기기 끊기', message: `${name}의 연결을 끊고 실행 중인 명령도 중단합니다. 다시 연결하려면 새 코드가 필요합니다.`, confirmLabel: '끊기', cancelLabel: '취소', danger: true })) void act('devices', { id, action: 'revoke' });
  };
  const rename = async () => {
    if (!editing?.name.trim()) return;
    if (await act('devices', { id: editing.id, action: 'rename', label: editing.name.trim() })) setEditing(undefined);
  };
  const disabled = busy || readOnly;
  const address = h?.open && h.endpoints[0] ? `${h.endpoints[0].host}:${h.port}` : '';
  const live = ticket && h && ticket.expires === h.expiresAt;
  const left = live ? Date.parse(ticket.expires) - now : 0;
  return (
    <section className="max-w-3xl space-y-4 rounded-2xl border border-line bg-panel p-5 text-sm shadow-sm">
      <div className="flex flex-wrap items-center gap-3">
        <Desktop size={21} className="text-accent" />
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">이 PC 서버</h3>
          <p className="mt-0.5 text-xs text-muted">같은 사내망이나 Tailscale에 있는 다른 PC가 이 PC에 연결합니다. 연결하는 PC에도 MY Agent가 필요합니다.</p>
        </div>
        <span aria-live="polite" className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs ${h?.open ? 'bg-accent/15 text-accent' : 'bg-line text-muted'}`}>
          <span className={`h-2 w-2 rounded-full ${h?.open ? 'bg-accent' : 'bg-muted/60'}`} />
          {!h ? '상태 확인 중…' : h.open ? `열림 · ${address}` : '닫힘'}
        </span>
        {h?.open ? <button className={secondaryBtn} disabled={disabled} type="button" onClick={() => void act('close')}><Power size={13} /> 서버 닫기</button> : null}
      </div>

      {h?.open ? (
        <div className="rounded-lg border border-amber-400/40 bg-amber-400/5 px-3 py-2 text-xs text-amber-200">
          <p className="flex items-center gap-2"><ShieldWarning size={14} className="shrink-0" /> <span className="flex-1">연결한 기기는 이 Windows 계정과 같은 권한을 가집니다.</span>
            <button type="button" className="underline underline-offset-2" aria-expanded={warnOpen} onClick={() => setWarnOpen((v) => !v)}>{warnOpen ? '접기' : '자세히'}</button></p>
          {warnOpen ? <p className="mt-1.5 pl-6">{WARNING}</p> : null}
        </div>
      ) : <p className="flex gap-2 rounded-lg border border-amber-400/50 bg-amber-400/5 p-3 text-xs text-amber-200"><ShieldWarning size={15} className="mt-px shrink-0" />{WARNING}</p>}

      {h && !h.open ? (
        <fieldset disabled={disabled} className="space-y-3">
          <div className="grid gap-2 md:grid-cols-2">
            <label className="text-[11px] text-muted">이 PC 이름<input className={field} value={label} onChange={(e) => setLabel(e.target.value)} /></label>
            <div className="text-[11px] text-muted"><label htmlFor="ssh-host-cwd">시작 폴더</label>
              <span className="mt-1 flex gap-2"><input id="ssh-host-cwd" className={`${field} mt-0 font-mono`} value={cwd} onChange={(e) => setCwd(e.target.value)} /><button type="button" className={secondaryBtn} onClick={() => browse(true)}><FolderOpen size={13} /> 폴더 선택</button></span>
            </div>
          </div>
          <Collapse label="고급 설정 (명령 창 종류·포트)">
            <div className="grid gap-2 md:grid-cols-2">
              <label className="text-[11px] text-muted">명령 창 종류<select value={shell} className={field} onChange={(e) => setShell(e.target.value as typeof shell)}><option value="powershell">PowerShell</option><option value="cmd">cmd</option></select></label>
              <label className="text-[11px] text-muted">포트<input className={`${field} font-mono`} type="number" min="1" max="65535" value={port} placeholder="처음에는 자동 선택" onChange={(e) => setPort(e.target.value)} /></label>
            </div>
            <p className="text-[11px] text-muted">포트를 바꾸면 연결한 기기에 새 코드가 필요합니다.</p>
          </Collapse>
          <Notice>방화벽 창에는 ‘Node.js’로 보일 수 있습니다. 회사 네트워크가 ‘공용’으로 잡힌 경우 IT에 확인하고 해당 네트워크에도 허용하세요.</Notice>
          <button className={primaryBtn} type="button" onClick={() => void act('open')}><Power size={14} weight="bold" /> 서버 열기</button>
        </fieldset>
      ) : null}

      {h?.configured ? (
        <label className="flex items-center gap-2 text-xs text-text">
          <input type="checkbox" disabled={disabled} checked={h.autoStart} onChange={(e) => void act('settings', { autoStart: e.target.checked })} />
          MY Agent가 켜질 때 자동으로 열기
        </label>
      ) : null}

      {h?.open ? (
        <div className="space-y-2 rounded-xl border border-accent/40 bg-accent/5 p-3.5" data-testid="ssh-host-code">
          <div className="flex flex-wrap items-center gap-2">
            <p className="flex-1 text-sm font-medium text-text">연결 코드</p>
            <span className="text-[11px] text-muted">10분·1회용 · 받을 사람에게만</span>
            <button type="button" className={live ? secondaryBtn : primaryBtn} disabled={disabled} onClick={() => void act('code')}>{live ? '새 코드 만들기' : '+ 연결 코드 만들기'}</button>
          </div>
          {live && ticket && left > 0 ? <>
            <CodeBox label="연결 코드" value={ticket.code} />
            <p className="text-[11px] text-muted">남은 시간 <b className={fpBadge} aria-live="off">{clock(left)}</b> · 새 코드를 만들면 이 코드는 쓸 수 없습니다.</p>
          </> : ticket ? <p className="text-[11px] text-muted">코드를 이미 썼거나 시간이 지났습니다. 새 코드를 만드세요.</p> : null}
        </div>
      ) : null}

      {h?.configured ? <>
        <div>
          <div className="mb-2 flex items-center gap-2">
            <h4 className="flex-1 text-sm font-semibold">연결된 기기 ({h.devices.length})</h4>
            {h.devices.length > 1 ? <button className={dangerBtn} type="button" disabled={disabled} onClick={() => void confirmDialog({ title: '모든 기기 끊기', message: '실행 중인 명령도 중단합니다. 다시 연결하려면 새 코드가 필요합니다.', confirmLabel: '모두 끊기', danger: true }).then((ok) => { if (ok) void act('devices', { id: '*', action: 'revoke' }); })}><Plugs size={13} /> 모두 끊기</button> : null}
          </div>
          {!h.devices.length ? <p className="text-xs text-muted">아직 연결된 기기가 없습니다.</p> : (
            <ul className="space-y-1.5">
              {h.devices.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-ink/30 px-3 py-2 text-xs">
                  {editing?.id === d.id ? (
                    <form className="flex min-w-0 flex-1 gap-2" onSubmit={(e) => { e.preventDefault(); void rename(); }}>
                      <input aria-label="기기 이름" autoFocus className={`${field} mt-0`} disabled={disabled} maxLength={80} value={editing.name} onChange={(e) => setEditing({ id: d.id, name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Escape') setEditing(undefined); }} />
                      <button className={secondaryBtn} disabled={disabled || !editing.name.trim()}>저장</button>
                      <button type="button" className={secondaryBtn} onClick={() => setEditing(undefined)}>취소</button>
                    </form>
                  ) : <>
                    <span className="min-w-0 flex-1">
                      <b className="block truncate text-text">{d.label}</b>
                      <span className="text-[11px] text-muted">지문 끝 <span className={fpBadge}>{d.fingerprint.slice(-6)}</span> · 마지막 사용 {new Date(d.lastSeenAt).toLocaleString()}</span>
                    </span>
                    <button type="button" className={secondaryBtn} disabled={disabled} onClick={() => setEditing({ id: d.id, name: d.label })}><PencilSimple size={13} /> 이름 변경</button>
                    <button type="button" className={dangerBtn} disabled={disabled} onClick={() => void revoke(d.id, d.label)}><Plugs size={13} /> 끊기</button>
                  </>}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h4 className="mb-2 text-sm font-semibold">최근 실행 기록</h4>
          {!h.audit.length ? <p className="text-xs text-muted">아직 실행 기록이 없습니다.</p> : (
            <ol className="max-h-60 space-y-1.5 overflow-y-auto rounded-lg border border-line bg-ink/30 p-2 text-[11px]">
              {h.audit.map((a, i) => (
                <li key={i} className="rounded-md px-2 py-1.5 odd:bg-panel/40">
                  <p className="flex flex-wrap items-center gap-1.5 text-muted"><b className="text-text">{a.device}</b> · {new Date(a.time).toLocaleString()} · {a.ip}
                    <span className={`rounded px-1.5 py-0.5 ${a.exitCode === 0 ? 'bg-accent/15 text-accent' : 'bg-amber-400/15 text-amber-300'}`}>{a.result} · {a.exitCode ?? '—'} · {a.durationMs}ms</span></p>
                  <code className="mt-1 block break-all font-mono text-text">{a.command}</code>
                  <span className="block break-all text-muted">{a.cwd}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
        {h.blockedExternal > 0 ? <Notice tone="warning">사설망 밖에서 온 접속을 {h.blockedExternal}회 막았습니다.</Notice> : null}
      </> : null}

      {address ? <p className="text-[11px] text-muted">이 PC 주소 <span className="font-mono text-text">{address}</span> <CopyText value={address} label="주소 복사" /></p> : null}
      <div className="flex gap-2 rounded-lg border border-line bg-ink/30 p-3 text-[11px] text-muted">
        <Info size={14} className="mt-px shrink-0" />
        <ul className="space-y-0.5">
          <li>창을 닫아도 서버를 유지하려면 <button className="underline underline-offset-2 hover:text-text" type="button" onClick={onGeneral}>일반 → 종료 시 트레이에서 계속 실행</button>을 켜세요.</li>
          <li>PC가 절전 모드면 연결되지 않습니다.</li>
          <li>PC를 다시 켜면 MY Agent를 실행해야 서버가 열립니다.</li>
        </ul>
      </div>
      <Notice tone="error">{msg}</Notice>
      <FolderBrowserModal open={folder} onClose={() => browse(false)} onSelect={(v) => { setCwd(v); browse(false); }} />
    </section>
  );
}
