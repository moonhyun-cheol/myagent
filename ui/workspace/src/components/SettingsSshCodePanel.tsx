import { useEffect, useState } from 'react';
import { makeSshDeviceCode, SshPendingInvite, useSshCode, type SshServerItem } from '../api/myAgentClient';

export const field = 'mt-1 block w-full rounded-lg border border-line bg-ink p-2 text-xs text-text';
export const button = 'rounded-lg border border-line px-3 py-1.5 text-xs text-text enabled:hover:border-accent disabled:opacity-45';
export function shareError(e:unknown) { return e instanceof Error ? e.message.replace(/^SSH_[A-Z_]+ · /,'') : '작업을 마치지 못했습니다. 다시 시도하세요.'; }
export function CopyText({value,label='복사'}:{value:string;label?:string}) {
  const [notice,setNotice] = useState(''); useEffect(()=>setNotice(''),[value]);
  return <><button type="button" className={button} disabled={!value} onClick={()=>void navigator.clipboard.writeText(value).then(()=>setNotice('복사했습니다.'),()=>setNotice('텍스트를 선택해 복사하세요.'))}>{label}</button> <span aria-live="polite">{notice}</span></>;
}
export function SettingsSshCodePanel({readOnly,expectedId,onConnected,onPending}:{readOnly:boolean;expectedId?:string;onConnected:(s:SshServerItem[],id:string)=>void;onPending:(e:SshPendingInvite)=>void}) {
  const [code,setCode] = useState(''), [msg,message] = useState(''), [busy,working] = useState(false);
  const [own,setOwn] = useState(false), [label,setLabel] = useState(''), [fp,setFp] = useState(''), [keyCode,setKeyCode] = useState('');
  useEffect(()=>{
    if(!own || readOnly) return;
    let active=true; working(true);
    void makeSshDeviceCode().then(r=>{if(active){setLabel(r.deviceKey.device_label);setFp(r.deviceKey.key_fp);setKeyCode(r.code);}}).catch(e=>{if(active)message(shareError(e));}).finally(()=>{if(active)working(false);});
    return ()=>{active=false;working(false);};
  },[own,readOnly]);
  async function connect() {
    working(true);message('서버 찾는 중 → 지문 확인 → 등록');
    try { const r=await useSshCode(code,expectedId);setCode('');if(r.kind==='key-request') message('팀원이 보낸 열쇠 코드입니다 · 서버의 「팀원 초대」에 붙여 넣으세요.');else onConnected(r.servers,r.id); }
    catch(e){if(e instanceof SshPendingInvite){setCode('');onPending(e);}else message(shareError(e));} finally{working(false);}
  }
  async function myKey() { working(true);message('');try{const r=await makeSshDeviceCode(label.trim()||undefined);setLabel(r.deviceKey.device_label);setFp(r.deviceKey.key_fp);setKeyCode(r.code);}catch(e){message(shareError(e));}finally{working(false);}}
  return <section className="mb-4 space-y-3 rounded-xl border border-line p-4 text-xs">
    <form onSubmit={e=>{e.preventDefault();if(!readOnly&&!busy&&code.trim())void connect();}}>
      <label className="block font-medium">{expectedId?'새 코드로 주소 갱신':'연결 코드 또는 초대 코드'}<input className={field} value={code} type="password" placeholder="코드 붙여 넣기" autoComplete="off" spellCheck={false} maxLength={4096} disabled={busy||readOnly} onChange={e=>setCode(e.target.value)} /></label>
      <button className={`${button} mt-2`} disabled={busy||readOnly||!code.trim()}>연결</button>
    </form>
    <details onToggle={e=>setOwn(e.currentTarget.open)}><summary className="cursor-pointer font-medium">팀원 초대 받기 · 내 열쇠 코드</summary>
      <label className="mt-2 block">이 PC 이름<input className={field} value={label} placeholder="비워 두면 이 컴퓨터 이름" maxLength={80} onChange={e=>{setLabel(e.target.value);setKeyCode('');}} disabled={readOnly||busy}/></label>
      <button type="button" className={`${button} my-2`} disabled={readOnly||busy} onClick={()=>void myKey()}>내 열쇠 코드 보기</button>
      {keyCode && <><p>비밀이 아닙니다 · 서버 관리자에게 보내세요. 지문 끝 6자리: <b>{fp.slice(-6)}</b></p><label>내 열쇠 코드<textarea className={field} readOnly value={keyCode}/></label><CopyText value={keyCode}/></>}
    </details><p aria-live="polite">{msg}</p>
  </section>;
}
