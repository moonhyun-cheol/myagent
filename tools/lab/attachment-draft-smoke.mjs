#!/usr/bin/env node
/** Real composer + store + API client in Chromium. HTTP fixtures only; no user data/LLM calls. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workspace = path.join(root, 'ui/workspace');
const { createServer } = await import(pathToFileURL(path.join(workspace, 'node_modules/vite/dist/node/index.js')).href);
const html = `<!doctype html><html><body><div id="root" style="height:100vh"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ChatPane} from '/src/components/ChatPane.tsx';
import {ImagePreviewModal} from '/src/components/ImagePreviewModal.tsx';
import {useWorkspaceStore as store} from '/src/store/workspaceStore.ts';
import '/src/index.css';
window.testStore=store;
store.setState({licenseMode:'full',apiOnline:true,activeSessionId:'A'});
localStorage.setItem('my-agent-workspace-session','A');
createRoot(document.getElementById('root')).render(React.createElement(React.Fragment,null,React.createElement(ChatPane),React.createElement(ImagePreviewModal)));
</script></body></html>`;
const server = await createServer({root:workspace,server:{host:'127.0.0.1',port:0,strictPort:false},plugins:[{
  name:'attachment-draft-smoke',
  configureServer(vite) { vite.middlewares.use('/__attachment_draft_test',async(req,res,next)=>{
    if(req.url?.includes('html-proxy'))return next();
    try {res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml('/__attachment_draft_test',html));}catch(e){next(e);}
  }); }
}]});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
let browser;
try {
  await server.listen();
  const executablePath=[process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p=>p&&existsSync(p));
  browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
  const page=await browser.newPage({viewport:{width:1100,height:900}});
  page.setDefaultTimeout(12000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const uploads=[],deletes=[],sends=[],created=[],stored=new Map();
  let holdUploads=false,holdCreation=false,failUpload=false,failRefresh=false;
  const delayedUploads=[],delayedCreations=[];
  let releaseStream=null;
  await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url()),p=url.pathname;
    if(['/src/','/node_modules/','/@','/__attachment_draft_test'].some(prefix=>p.startsWith(prefix)))return route.continue();
    if(p==='/sessions'&&req.method()==='POST') {
      const id=`new-${created.length+1}`;created.push(id);
      if(holdCreation)await new Promise(resolve=>delayedCreations.push(resolve));
      return route.fulfill({json:{id}});
    }
    if(p.startsWith('/sessions/')) {
      if(failRefresh)return route.fulfill({status:503,json:{error:'fixture unavailable'}});
      return route.fulfill({json:{id:p.split('/')[2],messages:[],project_id:null}});
    }
    if(p==='/attachments'&&req.method()==='POST') {
      const sid=req.headers()['x-cqr-session'];
      const names=[...(req.postDataBuffer()?.toString()??'').matchAll(/filename="([^"]+)"/g)].map(m=>m[1]);
      uploads.push({sid,names});
      if(holdUploads)await new Promise(resolve=>delayedUploads.push(resolve));
      if(failUpload)return route.fulfill({status:500,json:{message:'fixture upload failed'}});
      const attachments=names.map(name=>{
        const id=`file-${stored.size+1}`,mime=name.endsWith('.png')?'image/png':'text/plain';
        const item={id,name,mime,sid};stored.set(id,item);return item;
      });
      return route.fulfill({json:{attachments}});
    }
    if(p.startsWith('/attachments/')) {
      const id=p.split('/')[2],item=stored.get(id);
      assert.equal(url.searchParams.get('session'),item?.sid,'attachment requests stay scoped to their owner');
      if(req.method()==='DELETE') {deletes.push({id,sid:url.searchParams.get('session')});return route.fulfill({json:{ok:true}});}
      return route.fulfill({contentType:'image/png',body:png});
    }
    if(p==='/chat/stream') {
      sends.push({sid:req.headers()['x-cqr-session'],...req.postDataJSON()});
      await new Promise(resolve=>{releaseStream=resolve;});
      return route.fulfill({contentType:'text/event-stream',body:'data: {"type":"token","text":"fixture answer"}\n\ndata: {"type":"done","model":"fixture"}\n\n'});
    }
    return route.fulfill({json:{models:[{id:'auto',label:'auto'}],skills:[],workspace_trees:[],projects:[]}});
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__attachment_draft_test`,{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForFunction(()=>Boolean(window.testStore));
  const ids=()=>page.evaluate(()=>testStore.getState().pendingAttachments.map(a=>a.id));
  const switchTo=sid=>page.evaluate(id=>testStore.getState().loadChatSession(id),sid);
  const upload=name=>page.evaluate(async name=>{await testStore.getState().uploadFiles([new File(['fixture'],name,{type:'text/plain'})]);},name);
  const waitForCount=async(get,n)=>{for(let i=0;i<240&&get().length<n;i++)await new Promise(r=>setTimeout(r,50));assert.equal(get().length,n);};
  const input=page.locator('textarea').first();
  await input.fill('A text draft');
  await page.locator('input[type=file]').setInputFiles([{name:'image.png',mimeType:'image/png',buffer:png},{name:'note.txt',mimeType:'text/plain',buffer:Buffer.from('fixture')}]);
  await page.waitForFunction(()=>testStore.getState().pendingAttachments.length===2);
  const aIds=await ids();assert.equal(uploads[0].sid,'A');
  await switchTo('B');assert.deepEqual(await ids(),[]);await input.fill('B text draft');
  await upload('B.txt');const bIds=await ids();
  await switchTo('A');assert.deepEqual(await ids(),aIds);assert.equal(await input.inputValue(),'A text draft');
  const thumb=page.getByRole('img',{name:'image.png',exact:true});
  await thumb.waitFor();await page.waitForFunction(()=>[...document.images].some(i=>i.alt==='image.png'&&i.complete&&i.naturalWidth>0));
  await page.getByRole('button',{name:'image.png 크게 보기',exact:true}).click();
  const modal=page.getByRole('dialog',{name:'이미지 미리보기'});await modal.waitFor();
  assert((await modal.locator('img').getAttribute('src')).includes('session=A'));
  await modal.getByRole('button',{name:'닫기',exact:true}).click();
  await switchTo('A');assert.deepEqual(await ids(),aIds,'reselecting same chat retains draft');
  await page.evaluate(()=>testStore.getState().clearActiveChat());assert.deepEqual(await ids(),[]);
  await switchTo('A');assert.deepEqual(await ids(),aIds);
  await page.evaluate(()=>testStore.getState().startNewChat());assert.deepEqual(await ids(),[]);
  await switchTo('B');assert.deepEqual(await ids(),bIds);assert.equal(await input.inputValue(),'B text draft');
  assert.deepEqual(deletes,[],'navigation never deletes server attachments');

  // Only explicit removal clears the selected draft, never another session's files.
  await switchTo('A');await page.getByRole('button',{name:'첨부 제거',exact:true}).first().click();
  await waitForCount(()=>deletes,1);assert.deepEqual(deletes[0],{id:aIds[0],sid:'A'});
  await switchTo('B');assert.deepEqual(await ids(),bIds);
  await switchTo('A');assert.deepEqual(await ids(),[aIds[1]]);

  // In-flight upload completes in the initiating chat, even while B is visible.
  holdUploads=true;
  await page.evaluate(()=>{window.uploadDone=false;testStore.getState().uploadFiles([new File(['slow'],'slow.txt')]).then(()=>window.uploadDone=true);});
  await waitForCount(()=>delayedUploads,1);await switchTo('B');
  delayedUploads.shift()();holdUploads=false;
  await page.waitForFunction(()=>window.uploadDone);assert.deepEqual(await ids(),bIds);
  await switchTo('A');assert.equal((await ids()).length,2);assert.equal(uploads.at(-1).sid,'A');
  failRefresh=true;await switchTo('B');await switchTo('A');assert.equal((await ids()).length,2);failRefresh=false;
  const beforeFailure=await ids();failUpload=true;
  assert.equal(await page.evaluate(async()=>{try{await testStore.getState().uploadFiles([new File(['x'],'bad.txt')]);return false;}catch{return true;}}),true);
  failUpload=false;assert.deepEqual(await ids(),beforeFailure);

  // Send consumes attachments only from A. New draft survives queued-message dispatch.
  await page.evaluate(()=>testStore.getState().sendAiMessage('send A'));
  await waitForCount(()=>sends,1);assert.deepEqual(sends[0].attachments,beforeFailure);assert.equal(sends[0].sid,'A');assert.deepEqual(await ids(),[]);
  await upload('queued.txt');const queuedIds=await ids();
  await page.evaluate(()=>testStore.getState().sendAiMessage('queued A'));assert.deepEqual(await ids(),[]);
  await upload('next-draft.txt');const nextDraft=await ids();
  await switchTo('B');assert.deepEqual(await ids(),bIds);await switchTo('A');assert.deepEqual(await ids(),nextDraft);
  releaseStream();await waitForCount(()=>sends,2);
  assert.deepEqual(sends[1].attachments,queuedIds);assert.deepEqual(await ids(),nextDraft,'queue dispatch preserves unsent composer');
  releaseStream();await page.waitForFunction(()=>!testStore.getState().busy);
  await switchTo('B');await switchTo('A');assert.deepEqual(await ids(),nextDraft);

  // First attachment creates one session without losing text; parallel uploads share it.
  await page.evaluate(()=>testStore.getState().clearActiveChat());await input.fill('new text draft');
  const beforeCreated=created.length;
  await page.evaluate(async()=>Promise.all(['first.txt','second.txt'].map(name=>testStore.getState().uploadFiles([new File(['new'],name)]))));
  assert.equal(created.length,beforeCreated+1);const freshSid=await page.evaluate(()=>testStore.getState().activeSessionId);
  assert.equal(await input.inputValue(),'new text draft');assert.equal((await ids()).length,2);
  assert(uploads.slice(-2).every(u=>u.sid===freshSid));
  await switchTo('B');await switchTo(freshSid);assert.equal((await ids()).length,2);

  // Even a delayed first-session creation cannot steal navigation or pollute B.
  await page.evaluate(()=>testStore.getState().clearActiveChat());holdCreation=true;
  await page.evaluate(()=>{window.uploadDone=false;testStore.getState().uploadFiles([new File(['late'],'late.txt')]).then(()=>window.uploadDone=true);});
  await waitForCount(()=>delayedCreations,1);const lateSid=created.at(-1);await switchTo('B');
  delayedCreations.shift()();holdCreation=false;await page.waitForFunction(()=>window.uploadDone);
  assert.equal(await page.evaluate(()=>testStore.getState().activeSessionId),'B');
  assert.equal(await page.evaluate(()=>localStorage.getItem('my-agent-workspace-session')),'B');assert.deepEqual(await ids(),bIds);
  await switchTo(lateSid);assert.equal((await ids()).length,1);assert.equal(uploads.at(-1).sid,lateSid);
  assert.equal(deletes.length,1);assert.deepEqual(errors,[]);
  console.log('PASS: real composer retains text/files across A/B, same-chat, clear/new chat, preview, explicit removal, refresh/upload failure, in-flight switching, send, queue/new-draft isolation, first-session parallel upload and late creation. HTTP/LLM fixtures; no installed-app or restart persistence claim.');
} finally {await browser?.close();await server.close();}
