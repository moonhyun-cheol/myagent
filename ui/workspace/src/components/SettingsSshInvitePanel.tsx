import { useEffect, useState } from 'react';
import { getSshInvites, inspectInviteKey, issueSshInvite, prepareSshInvite, removeSshInvite, type SshInviteRecord, type SshServerItem } from '../api/myAgentClient';
import { confirmDialog } from '../lib/confirmDialog';
import { button, CopyText, field, shareError } from './SettingsSshCodePanel';

export function SettingsSshInvitePanel({server,readOnly}:{server:SshServerItem;readOnly:boolean}) {
  const [keyCode,setKey]=useState(''),[account,setAccount]=useState(''),[issued,setIssued]=useState('');
  const [key,inspect]=useState<{device_label:string;key_fp:string}>(),[prep,prepare]=useState<Awaited<ReturnType<typeof prepareSshInvite>>>();
  const [installed,check]=useState(false),[busy,working]=useState(false),[msg,message]=useState(''),[rows,setRows]=useState<SshInviteRecord[]>([]);
  useEffect(()=>{let active=true;void getSshInvites(server.id).then(r=>{if(active)setRows(r.invites);}).catch(e=>{if(active)message(shareError(e));});return()=>{active=false;};},[server.id]);
  const input={serverId:server.id,keyCode,account};const reset=()=>{prepare(undefined);check(false);setIssued('');};
  async function act(f:()=>Promise<void>) {working(true);message('');try{await f();}catch(e){message(shareError(e));}finally{working(false);}}
  const disabled=readOnly||busy;
  return <div className="mt-3 space-y-3 rounded-xl border border-line p-3 text-xs">
    <details><summary className="cursor-pointer font-medium">팀원 초대</summary><fieldset disabled={disabled} className="mt-2 space-y-2">
      <label>팀원이 보낸 열쇠 코드<textarea className={field} maxLength={4096} value={keyCode} onChange={e=>{setKey(e.target.value);inspect(undefined);reset();}}/></label>
      <button className={button} type="button" disabled={!keyCode} onClick={()=>void act(async()=>inspect(await inspectInviteKey(keyCode)))}>열쇠 코드 확인</button>
      {key&&<><p aria-live="polite">{key.device_label} · 지문 끝 6자리 <b>{key.key_fp.slice(-6)}</b>를 팀원과 맞춰 보세요.</p>
        <label>팀원이 쓸 서버 계정<input className={field} value={account} onChange={e=>{setAccount(e.target.value);reset();}}/></label>
        <button className={button} type="button" disabled={!account.trim()} onClick={()=>void act(async()=>{reset();prepare(await prepareSshInvite(input));})}>서버에 넣을 명령 준비</button></>}
      {prep&&<><p>서버 또는 웹 콘솔에 <b>{account}</b> 계정으로 로그인해 직접 실행하세요.</p>
        <label>열쇠 한 줄<textarea className={field} readOnly value={prep.keyLine}/></label><CopyText label="열쇠 줄 복사" value={prep.keyLine}/>
        <label className="block">넣는 명령<textarea className={field} readOnly value={prep.addCommand}/></label><CopyText label="서버에 넣을 명령 복사" value={prep.addCommand}/>
        <label className="block"><input type="checkbox" checked={installed} disabled={!!issued} onChange={e=>check(e.target.checked)}/> 넣었습니다</label>
        <button className={button} type="button" disabled={!installed||!!issued} onClick={()=>void act(async()=>{setIssued((await issueSshInvite(input,prep.invite_id,installed)).code);setRows((await getSshInvites(server.id)).invites);})}>초대 코드 만들기</button></>}
      {issued&&<><label>초대 코드<textarea className={field} readOnly value={issued}/></label><CopyText value={issued}/></>}
    </fieldset></details>
    <details><summary className="cursor-pointer font-medium">초대한 팀원 ({rows.length})</summary><p className="my-2">해당 팀원 계정에서 빼는 명령을 직접 실행하세요. 기록만 지워도 서버의 열쇠는 남습니다. 이미 열린 접속은 서버에서 별도로 끊으세요.</p>
      {rows.map(r=><div key={r.invite_id} className="my-2"><p>{r.device_label} · {r.account} · {new Date(r.issued_at).toLocaleDateString()}</p><CopyText label="빼는 명령 복사" value={r.removeCommand}/> <button className={button} type="button" disabled={disabled} onClick={()=>void act(async()=>{if(await confirmDialog({title:'초대 기록 지우기',message:'서버의 열쇠는 지워지지 않습니다. 이 목록의 기록만 지울까요?',confirmLabel:'기록 지우기',danger:true}))setRows((await removeSshInvite(r.invite_id,server.id)).invites);})}>기록 지우기</button></div>)}
    </details><p aria-live="polite">{msg}</p>
  </div>;
}
