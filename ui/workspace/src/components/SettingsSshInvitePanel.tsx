import { CheckCircle, Trash, UserPlus, Users } from '@phosphor-icons/react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { getSshInvites, inspectInviteKey, issueSshInvite, prepareSshInvite, removeSshInvite, type SshInviteRecord, type SshServerItem } from '../api/myAgentClient';
import { confirmDialog } from '../lib/confirmDialog';
import { CodeBox, Collapse, CopyText, dangerBtn, field, fpBadge, Notice, primaryBtn, secondaryBtn, shareError } from './SettingsSshCodePanel';

function Step({ n, title, done, active, children }: { n: number; title: string; done: boolean; active: boolean; children?: ReactNode }) {
  return (
    <li className={`rounded-lg border p-3 ${active ? 'border-accent/40 bg-accent/5' : 'border-line/70'}`}>
      <p className={`flex items-center gap-2 text-xs font-medium ${active || done ? 'text-text' : 'text-muted'}`}>
        {done ? <CheckCircle size={15} weight="fill" className="shrink-0 text-accent" /> : <span className="inline-flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full border border-line text-[9px]">{n}</span>}
        {title}
      </p>
      {children && (active || done) ? <div className="mt-2 space-y-2 pl-6">{children}</div> : null}
    </li>
  );
}

/** Admin side of 「팀원 초대」. The app only prepares text; the admin runs the commands on the server. */
export function SettingsSshInvitePanel({ server, readOnly, blockedReason }: { server: SshServerItem; readOnly: boolean; blockedReason?: string }) {
  const [keyCode, setKey] = useState(''), [account, setAccount] = useState(''), [issued, setIssued] = useState('');
  const [key, inspect] = useState<{ device_label: string; key_fp: string }>(), [prep, prepare] = useState<Awaited<ReturnType<typeof prepareSshInvite>>>();
  const [installed, check] = useState(false), [busy, working] = useState(false), [msg, message] = useState(''), [rows, setRows] = useState<SshInviteRecord[]>([]);
  useEffect(() => { let active = true; void getSshInvites(server.id).then((r) => { if (active) setRows(r.invites); }).catch((e) => { if (active) message(shareError(e)); }); return () => { active = false; }; }, [server.id]);
  const input = { serverId: server.id, keyCode: keyCode.trim(), account: account.trim() };
  const reset = () => { prepare(undefined); check(false); setIssued(''); };
  async function act(f: () => Promise<void>) { working(true); message(''); try { await f(); } catch (e) { message(shareError(e)); } finally { working(false); } }
  const disabled = readOnly || busy || Boolean(blockedReason);
  const uid = useId();
  return (
    <div className="mt-3 space-y-2">
      <Collapse label={<span className="inline-flex items-center gap-1.5"><UserPlus size={13} /> 팀원 초대</span>}>
        {blockedReason ? <Notice tone="warning">{blockedReason}</Notice> : null}
        <p className="text-[11px] text-muted">관리자 계정이나 키 파일을 주지 않고, 팀원 PC의 공개 열쇠만 팀원용 서버 계정에 넣습니다.</p>
        <fieldset disabled={disabled}>
          <ol className="space-y-2">
            <Step n={1} title="팀원이 보낸 열쇠 코드 확인" done={Boolean(key)} active={!key}>
              <div className="text-[11px] text-muted"><label htmlFor={`${uid}-key`}>팀원이 보낸 열쇠 코드</label>
                <span className="mt-1 flex gap-2">
                  <input id={`${uid}-key`} className={`${field} mt-0 font-mono`} maxLength={4096} spellCheck={false} autoComplete="off" value={keyCode} placeholder="MYAGENT-SSH1. 로 시작하는 코드" onChange={(e) => { setKey(e.target.value); inspect(undefined); reset(); }} />
                  <button className={secondaryBtn} type="button" disabled={!keyCode.trim()} onClick={() => void act(async () => inspect(await inspectInviteKey(keyCode.trim())))}>확인</button>
                </span>
              </div>
              {key ? <p aria-live="polite" className="text-[11px] text-muted"><b className="text-text">{key.device_label}</b> · 지문 끝 <span className={fpBadge}>{key.key_fp.slice(-6)}</span> — 팀원과 별도 경로(전화·메신저)로 맞춰 보세요.</p> : null}
            </Step>
            <Step n={2} title="팀원용 계정 입력 · 서버에서 명령 실행" done={installed} active={Boolean(key) && !installed}>
              <div className="text-[11px] text-muted"><label htmlFor={`${uid}-account`}>팀원이 쓸 서버 계정 (관리자 본인 계정은 쓸 수 없습니다)</label>
                <span className="mt-1 flex gap-2">
                  <input id={`${uid}-account`} className={`${field} mt-0 font-mono`} value={account} placeholder="team-minji" onChange={(e) => { setAccount(e.target.value); reset(); }} />
                  <button className={secondaryBtn} type="button" disabled={!account.trim()} onClick={() => void act(async () => { reset(); prepare(await prepareSshInvite(input)); })}>명령 준비</button>
                </span>
              </div>
              {prep ? <>
                <p className="text-[11px] text-muted">서버나 웹 콘솔에 <b className="text-text">{account.trim()}</b> 계정으로 로그인해 아래 명령을 직접 실행하세요. 앱과 AI는 서버에 넣지 않습니다.</p>
                <CodeBox label="서버에 넣을 명령" value={prep.addCommand} copyLabel="명령 복사" />
                <Collapse label="열쇠 한 줄만 보기"><CodeBox label="열쇠 한 줄" value={prep.keyLine} /></Collapse>
                <label className="flex items-center gap-2 text-xs text-text">
                  <input type="checkbox" checked={installed} disabled={Boolean(issued)} onChange={(e) => check(e.target.checked)} />
                  서버에서 명령을 실행해 열쇠를 넣었습니다
                </label>
              </> : null}
            </Step>
            <Step n={3} title="초대 코드 보내기" done={Boolean(issued)} active={installed && !issued}>
              {!issued ? <button className={primaryBtn} type="button" disabled={!installed || !prep} onClick={() => void act(async () => { if (!prep) return; setIssued((await issueSshInvite(input, prep.invite_id, installed)).code); setRows((await getSshInvites(server.id)).invites); })}>초대 코드 만들기</button>
                : <CodeBox label="초대 코드 (이 팀원에게만 보내세요)" value={issued} />}
            </Step>
          </ol>
        </fieldset>
      </Collapse>
      <Collapse label={<span className="inline-flex items-center gap-1.5"><Users size={13} /> 초대한 팀원 ({rows.length})</span>}>
        <p className="text-[11px] text-muted">빼는 명령은 해당 팀원 계정에서 직접 실행하세요. 기록만 지워도 서버의 열쇠는 남습니다. 이미 열린 접속은 서버에서 따로 끊으세요.</p>
        {!rows.length ? <p className="text-[11px] text-muted">아직 초대한 팀원이 없습니다.</p> : (
          <ul className="space-y-1.5">
            {rows.map((r) => (
              <li key={r.invite_id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-ink/30 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <b className="block truncate text-text">{r.device_label}</b>
                  <span className="text-[11px] text-muted"><span className="font-mono">{r.account}</span> · {new Date(r.issued_at).toLocaleDateString()}</span>
                </span>
                <CopyText label="빼는 명령 복사" value={r.removeCommand} />
                <button className={dangerBtn} type="button" disabled={readOnly || busy} onClick={() => void act(async () => { if (await confirmDialog({ title: '초대 기록 지우기', message: '서버의 열쇠는 지워지지 않습니다. 이 목록의 기록만 지울까요?', confirmLabel: '기록 지우기', danger: true })) setRows((await removeSshInvite(r.invite_id, server.id)).invites); })}><Trash size={13} /> 기록 지우기</button>
              </li>
            ))}
          </ul>
        )}
      </Collapse>
      <Notice tone="error">{msg}</Notice>
    </div>
  );
}
