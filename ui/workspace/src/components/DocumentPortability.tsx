import {useState} from 'react';
import {documentApi} from '../api/documentClient';
type Options={project:string|null;sessions:{id:string;title:string}[];attachments:{id:string;name:string}[]};
export function DocumentPortability({session,id,revision,disabled,readOnly,onChanged}:{session:string;id:string;revision:number;disabled:boolean;readOnly:boolean;onChanged:()=>void}) {
  const [options,setOptions]=useState<Options|null>(null),[target,setTarget]=useState(''),[asset,setAsset]=useState(''),[status,setStatus]=useState(''),[busy,setBusy]=useState(false);
  const run=async(action:()=>Promise<void>)=>{setBusy(true);try{await action();}catch(e){setStatus(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
  const post=async(action:string,body:unknown)=>{await documentApi(session,`/${id}/${action}`,'POST',body);setStatus('처리되었습니다.');onChanged();};
  const bundle=async()=>{const value=await documentApi(session,`/${id}/bundle`);const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`${id}.document-bundle.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setStatus('본문·참조·연결한 첨부 묶음을 다운로드했습니다.');};
  return <details><summary onClick={()=>{if(!options)void run(async()=>{setOptions(await documentApi<Options>(session));});}}>공유·이동·묶음 내보내기</summary>
    <p>공유는 읽기 전용입니다. 소유 챗을 삭제하면 공유 원본도 삭제됩니다. 프로젝트로 이동한 문서는 유지됩니다.</p>
    {options&&<><label>공유 대상 챗<select aria-label="문서 공유 대상" value={target} onChange={e=>setTarget(e.target.value)}><option value="">챗 선택</option>{options.sessions.filter(s=>s.id!==session).map(s=><option key={s.id} value={s.id}>{s.title}</option>)}</select></label>
    <button disabled={disabled||busy||readOnly||!target} onClick={()=>void run(()=>post('share',{targetSession:target}))}>읽기 전용 공유</button>
    <button disabled={disabled||busy||readOnly||!target} onClick={()=>void run(()=>post('share',{targetSession:target,remove:true}))}>공유 연결 해제</button>
    <button disabled={disabled||busy||readOnly||!options.project} onClick={()=>{if(window.confirm('문서 소유권을 현재 챗의 프로젝트로 이동합니다. 이후 이 챗을 삭제해도 문서는 유지됩니다. 계속할까요?'))void run(()=>post('move',{project:options.project,revision}));}}>현재 프로젝트로 이동</button>
    {!options.project&&<p>이동하려면 먼저 챗을 대상 프로젝트에 연결하세요.</p>}
    <label>문서에 보관할 첨부<select aria-label="문서 보관 첨부" value={asset} onChange={e=>setAsset(e.target.value)}><option value="">첨부 선택</option>{options.attachments.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
    <button disabled={disabled||busy||readOnly||!asset} onClick={()=>void run(()=>post('attachments',{attachmentId:asset}))}>첨부 사본 보관</button>
    <p>첨부는 선택한 파일의 사본을 문서와 함께 보관합니다. 외부 URL 파일은 자동 다운로드하지 않습니다. 묶음은 JSON 형식이며 첨부 원본을 Base64로 포함합니다.</p></>}
    <button disabled={disabled||busy} onClick={()=>void run(bundle)}>참조·첨부 묶음 다운로드</button><p role="status">{status}</p>
  </details>;
}
