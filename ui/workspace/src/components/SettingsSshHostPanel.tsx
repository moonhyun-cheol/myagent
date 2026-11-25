import { useEffect, useRef, useState } from 'react';
import { changeSshHost, getSshHost, type SshHostState } from '../api/myAgentClient';
import { confirmDialog } from '../lib/confirmDialog';
import { FolderBrowserModal } from './FolderBrowserModal';
import { button, CopyText, field, shareError } from './SettingsSshCodePanel';

export function SettingsSshHostPanel({readOnly,onGeneral}:{readOnly:boolean;onGeneral:()=>void}) {
  const [h,status]=useState<SshHostState>(),[msg,message]=useState(''),[busy,working]=useState(false),[folder,browse]=useState(false);
  const [label,setLabel]=useState(''),[cwd,setCwd]=useState(''),[shell,setShell]=useState<'powershell'|'cmd'>('powershell'),[port,setPort]=useState('');
  const [ticket,setTicket]=useState<{code:string;expires:string}>(),[names,rename]=useState<Record<string,string>>({});
  const seq=useRef(0);
  useEffect(()=>{let active=true,first=true;async function tick(){const rev=seq.current;try{const {status:s}=await getSshHost();if(!active||rev!==seq.current)return;status(s);if(first){first=false;setLabel(s.label);setCwd(s.defaultCwd);setPort(s.port?String(s.port):'');setShell(s.shell);}}catch(e){if(active)message(shareError(e));}}void tick();const timer=setInterval(()=>void tick(),3000);return()=>{active=false;clearInterval(timer);};},[]);
  async function act(op:Parameters<typeof changeSshHost>[0],body:object={}) {
    working(true);message('');seq.current++;
    try{if(op==='open')await changeSshHost('settings',{label,defaultCwd:cwd,shell,...(port?{port:Number(port)}:{})});
      const r=await changeSshHost(op,body);status(r.status);if(r.status.port)setPort(String(r.status.port));
      if(r.code && r.status.expiresAt)setTicket({code:r.code,expires:r.status.expiresAt});else if(!r.status.expiresAt)setTicket(undefined);
    }catch(e){message(shareError(e));}finally{seq.current++;working(false);}
  }
  const disabled=busy||readOnly;
  return <section className="max-w-3xl space-y-3 rounded-xl border border-line bg-panel p-5 text-sm"><h3 className="font-semibold">이 PC 서버</h3>
    <p>같은 사내망이나 Tailscale에 있는 다른 PC를 연결합니다.<br/>연결 코드를 받을 PC에도 MY Agent가 필요합니다.</p>
    <p className="rounded-lg border border-amber-400/50 p-3">연결한 기기는 이 PC에서 MY Agent를 실행한 Windows 계정과 같은 권한으로 명령을 실행합니다. 시작 폴더는 처음 위치일 뿐 울타리가 아닙니다. 내 PC는 내 기기만, 공용 PC는 공용 계정으로 쓰세요.</p>
    <p aria-live="polite" className={h?.open?'text-accent':'text-muted'}>{!h?'상태 확인 중…':h.open?`열림 · ${h.endpoints[0]?.host}:${h.port}`:'닫힘'}</p>
    {h && (!h.open ? <fieldset disabled={disabled} className="space-y-2"><label>이 PC 이름<input className={field} value={label} onChange={e=>setLabel(e.target.value)}/></label>
      <label>시작 폴더<input className={field} value={cwd} onChange={e=>setCwd(e.target.value)}/></label><button type="button" className={button} onClick={()=>browse(true)}>폴더 선택</button>
      <details><summary>고급 설정</summary><label>명령 창 종류<select value={shell} className={field} onChange={e=>setShell(e.target.value as typeof shell)}><option value="powershell">PowerShell</option><option value="cmd">cmd</option></select></label><label>포트<input className={field} type="number" min="1" max="65535" value={port} placeholder="처음에는 자동 선택" onChange={e=>setPort(e.target.value)}/></label><p>포트를 바꾸면 연결한 기기에 새 코드가 필요합니다.</p></details>
      <p>방화벽 창에는 ‘Node.js’로 보일 수 있습니다. 회사 네트워크가 ‘공용’으로 잡힌 경우 IT에 확인하고 해당 네트워크에도 허용하세요.</p>
      <button className={button} type="button" onClick={()=>void act('open')}>서버 열기</button></fieldset> : <><button className={button} disabled={disabled} type="button" onClick={()=>void act('close')}>서버 닫기</button>
      <div><button type="button" className={button} disabled={disabled} onClick={()=>void act('code')}>연결 코드 만들기</button> <span>10분·1회용 · 받을 사람에게만</span></div>
      {ticket && ticket.expires===h.expiresAt && <div><label>연결 코드<textarea className={field} value={ticket.code} readOnly/></label><CopyText value={ticket.code}/> · 남은 시간 {Math.max(0,Math.ceil((Date.parse(ticket.expires)-Date.now())/1000))}초</div>}
    </>)}
    {h?.configured && <><label className="block"><input type="checkbox" disabled={disabled} checked={h.autoStart} onChange={e=>void act('settings',{autoStart:e.target.checked})}/> MY Agent가 켜질 때 자동으로 열기</label>
      <h4 className="font-semibold">연결된 기기 ({h.devices.length})</h4>{h.devices.map(d=><div key={d.id} className="space-y-1"><label>기기 이름<input className={field} disabled={disabled} value={names[d.id]??d.label} onChange={e=>rename({...names,[d.id]:e.target.value})}/></label>
        <span>지문 끝 {d.fingerprint.slice(-6)} · {new Date(d.lastSeenAt).toLocaleString()}</span> <button type="button" className={button} disabled={disabled||!names[d.id]?.trim()} onClick={()=>void act('devices',{id:d.id,action:'rename',label:names[d.id]})}>이름 바꾸기</button> <button className={button} disabled={disabled} type="button" onClick={()=>void act('devices',{id:d.id,action:'revoke'})}>끊기</button></div>)}
      <button className={button} type="button" disabled={disabled||!h.devices.length} onClick={()=>void confirmDialog({title:'모든 기기 끊기',message:'실행 중인 명령도 중단합니다. 다시 연결하려면 새 코드가 필요합니다.',confirmLabel:'모두 끊기',danger:true}).then(ok=>{if(ok)void act('devices',{id:'*',action:'revoke'});})}>모두 끊기</button>
      <h4 className="font-semibold">최근 실행 기록</h4>{!h.audit.length?<p>아직 실행 기록이 없습니다.</p>:<ol>{h.audit.map((a,i)=><li key={i} className="mb-2 break-all"><b>{a.device}</b> · {new Date(a.time).toLocaleString()} · {a.ip} · {a.result} ({a.exitCode??'—'}, {a.durationMs}ms)<br/>{a.cwd} · <code>{a.command}</code></li>)}</ol>}
      {h.blockedExternal>0 && <p>사설망 밖 접속 차단 {h.blockedExternal}회</p>}</>}
    <p className="text-xs text-muted">창을 닫아도 서버를 유지하려면 <button className="underline" type="button" onClick={onGeneral}>일반 → 종료 시 트레이에서 계속 실행</button>을 켜세요.<br/>PC가 절전 모드면 연결되지 않습니다.<br/>PC를 다시 켜면 MY Agent를 실행해야 서버가 열립니다.</p>
    <p aria-live="polite">{msg}</p><FolderBrowserModal open={folder} onClose={()=>browse(false)} onSelect={v=>{setCwd(v);browse(false);}}/>
  </section>;
}
