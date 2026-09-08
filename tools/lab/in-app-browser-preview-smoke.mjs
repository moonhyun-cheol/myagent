#!/usr/bin/env node
/** Real container/layout/browser/bridge/CSS; unrelated panes are inert fixtures.
 * No user API, sessions, external sites or installed app are touched. Native rendering
 * is tested separately by in-app-browser-smoke (real WPF/WebView2).
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workspace = path.join(root, 'ui/workspace');
const { createServer } = await import(pathToFileURL(path.join(workspace, 'node_modules/vite/dist/node/index.js')).href);
const inert = ['ImagePreviewModal', 'ConfirmModal', 'MarkdownDocument', 'MediaPane', 'SchedulerSurface', 'TerminalPane', 'WorkspaceObjectsPane'];
const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"></head><body><div id="root" style="height:100vh"></div><script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MainWorkspaceContainer } from '/src/components/MainWorkspaceContainer.tsx';
import { useWorkspaceStore as store } from '/src/store/workspaceStore.ts';
import '/src/index.css';
window.commands=[]; const listeners=new Set();
window.chrome.webview={postMessage:m=>commands.push(m),addEventListener:(t,fn)=>listeners.add(fn),removeEventListener:(t,fn)=>listeners.delete(fn)};
window.emit=state=>{for(const fn of listeners)fn({data:{type:'inAppBrowser.state',visible:false,url:'',loading:false,status:'닫힘',canGoBack:false,canGoForward:false,...state}});};
window.activate=url=>{for(const fn of listeners)fn({data:{type:'inAppBrowser.activate',url}});};
window.testStore=store;
store.setState({mode:'browser',previewPaneOpen:true,terminalOpen:false,activeSessionId:null,busy:false,browserInputUrl:'https://example.com',browserLoadedUrl:'https://example.com',browserHistory:['https://example.org','https://example.com'],browserHistoryIndex:1,browserReloadKey:0,
refreshExplorer:async()=>{},setBrowserInputUrl:url=>store.setState({browserInputUrl:url}),navigateBrowser:url=>store.setState({browserLoadedUrl:url,browserInputUrl:url}),reloadBrowser:()=>{},goBrowserBack:()=>{},goBrowserForward:()=>{}});
const view=createRoot(document.getElementById('root'));view.render(React.createElement(MainWorkspaceContainer));
</script></body></html>`;
const server = await createServer({root:workspace, server:{host:'127.0.0.1',port:0}, plugins:[{
  name:'isolated-work-panel', enforce:'pre',
  load(id) {
    const name=path.basename(id).replace(/\.tsx$/, '');
    if(!id.replaceAll('\\','/').includes('/src/components/'))return;
    if(inert.includes(name))return `import React from 'react'; export function ${name}(){return React.createElement('div',{'data-fixture':'${name}'},'${name}');}`;
    if(name==='ChatPane')return `import React from 'react';import {useWorkspaceStore as s} from '../store/workspaceStore';export function ChatPane(){return <div><textarea aria-label="채팅 초안"/><button onClick={()=>s.getState().setPreviewPaneOpen(true)}>작업 패널 열기</button></div>}`;
    if(name==='GeminiNavSidebar')return `import React from 'react';export function GeminiNavSidebar({onSurfaceChange}){return <aside style={{width:240,flexShrink:0}}><button onClick={()=>onSurfaceChange('scheduler')}>자동화 fixture</button><button onClick={()=>onSurfaceChange('chat')}>채팅 fixture</button></aside>}`;
  },
  configureServer(vite){vite.middlewares.use('/__browser_preview_test',async(req,res,next)=>{if(req.url?.includes('html-proxy'))return next();try{res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml('/__browser_preview_test',html));}catch(e){next(e);}});}
}]});
let browser;
try {
  await server.listen();
  const executablePath=[process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p=>p&&existsSync(p));
  browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{
    const pathname=new URL(route.request().url()).pathname;
    if(['/src/','/node_modules/','/@','/__browser_preview_test'].some(p=>pathname.startsWith(p)))return route.continue();
    return route.fulfill({json:{}});
  });
  const url=`http://127.0.0.1:${server.httpServer.address().port}/__browser_preview_test`;
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
  const separator=page.getByRole('separator',{name:'작업 패널 너비',exact:true});
  const address=page.getByRole('textbox',{name:'웹 주소'});
  const surface=async visible=>page.waitForFunction(v=>commands.filter(c=>c.type==='inAppBrowser.surface').at(-1)?.visible===v,visible);
  const width=async()=>Math.round((await page.locator('[data-work-panel]').boundingBox()).width);
  const hasCommand=async type=>page.evaluate(t=>commands.some(c=>c.type===t),type);
  await separator.waitFor();await surface(true);
  assert(await hasCommand('inAppBrowser.getState'));assert(await hasCommand('inAppBrowser.resume'));
  assert.equal(await page.getByTitle('뒤로',{exact:true}).isDisabled(),true);
  assert.equal(await address.count(),1);assert.equal(await page.locator('iframe').count(),0);
  assert.equal(await page.getByText('오른쪽 인앱 브라우저가 열려 있습니다',{exact:true}).count(),0);
  assert.equal(await page.getByRole('separator',{name:'터미널 높이'}).isVisible(),false);
  await page.getByRole('textbox',{name:'채팅 초안'}).fill('유지할 초안');
  const initial=await width();
  await separator.focus();await separator.press('ArrowLeft');assert.equal(await width(),initial+16);
  await separator.press('Home');assert.equal(await width(),360);
  await separator.press('End');assert.equal(await width(),774);
  await separator.press('Enter');assert.equal(await width(),initial);
  const rect=await separator.boundingBox();
  await page.mouse.move(rect.x+3,rect.y+100);await page.mouse.down();await surface(false);
  await page.mouse.move(rect.x-97,rect.y+100,{steps:8});await page.mouse.up();await surface(true);
  const saved=await width();assert(saved>initial+90);
  await page.reload();await separator.waitFor();assert.equal(await width(),saved,'width survives reload');
  await page.getByRole('textbox',{name:'채팅 초안'}).fill('유지할 초안');
  await page.getByRole('button',{name:'작업 패널 확대',exact:true}).click();
  assert.equal(await width(),1200);assert.equal(await separator.count(),0);
  await page.getByRole('button',{name:'분할 보기로 복원'}).click();assert.equal(await width(),saved);
  await page.getByRole('button',{name:'작업 패널 닫기',exact:true}).click();await surface(false);
  assert.equal(await address.isVisible(),false);
  assert.equal(await page.getByRole('textbox',{name:'채팅 초안'}).inputValue(),'유지할 초안');
  await page.getByRole('button',{name:'작업 패널 열기',exact:true}).click();await surface(true);assert.equal(await width(),saved);
  await page.getByRole('button',{name:'문서',exact:true}).click();await surface(false);
  await page.getByRole('button',{name:'웹',exact:true}).click();await surface(true);
  await page.getByRole('button',{name:'터미널',exact:true}).click();
  const terminalSeparator=page.getByRole('separator',{name:'터미널 높이'});await terminalSeparator.waitFor();
  await terminalSeparator.focus();await terminalSeparator.press('ArrowUp');assert.equal(await terminalSeparator.getAttribute('aria-valuenow'),'216');
  await page.getByRole('button',{name:'터미널',exact:true}).click();await surface(true);
  await page.getByRole('button',{name:'자동화 fixture'}).click();await surface(false);
  await page.evaluate(()=>activate('https://example.org'));await surface(true);await address.waitFor();
  assert.equal(await address.inputValue(),'https://example.org');
  await page.evaluate(()=>{const el=document.createElement('div');el.id='test-modal';el.setAttribute('aria-modal','true');el.style.cssText='position:fixed;inset:10px;z-index:100;background:white';document.body.append(el);});await surface(false);
  await page.evaluate(()=>document.getElementById('test-modal').remove());await surface(true);
  await address.fill('example.net');await address.press('Enter');
  await page.waitForFunction(()=>commands.some(c=>c.type==='inAppBrowser.open'&&c.url==='https://example.net/'));
  await page.evaluate(()=>emit({visible:true,url:'https://example.net/',loading:true,status:'페이지를 여는 중입니다.'}));
  await page.getByRole('status').filter({hasText:'여는 중'}).waitFor();
  await page.evaluate(()=>emit({visible:true,url:'https://example.net/',status:'페이지 응답 오류 (HTTP 404)'}));
  await page.getByRole('status').filter({hasText:'HTTP 404'}).waitFor();
  await page.getByRole('button',{name:'다시 시도'}).click();assert(await hasCommand('inAppBrowser.reload'));
  await page.evaluate(()=>emit({visible:true,url:'https://example.net/',canGoBack:true,canGoForward:true,status:'탐색 완료'}));
  assert.equal(await page.getByRole('status').count(),0);
  for(const [title,command] of [['뒤로','back'],['앞으로','forward'],['새로고침','reload']]){
    await page.getByTitle(title,{exact:true}).click();assert(await hasCommand(`inAppBrowser.${command}`));
  }
  await page.evaluate(()=>emit({visible:false,url:'about:blank',status:'브라우저를 열 수 없습니다: 테스트'}));
  await page.getByRole('status').filter({hasText:'열 수 없습니다'}).waitFor();assert.equal(await address.inputValue(),'https://example.net/');
  await page.getByRole('button',{name:'기본 브라우저에서 열기',exact:true}).click();assert(await hasCommand('inAppBrowser.openExternal'));
  for(const viewport of [{width:1000,height:800},{width:640,height:640},{width:1440,height:900}]){
    await page.setViewportSize(viewport);await page.waitForTimeout(100);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'no viewport overflow');
    const a=await address.boundingBox();assert(a.width>60,'address remains editable');
    const slot=await page.locator('[data-native-browser-slot]').boundingBox();assert(slot.width>0&&slot.height>0);
    if(viewport.width<1026){
      assert.equal(await separator.count(),0);await page.getByRole('button',{name:'채팅으로 돌아가기'}).click();await surface(false);
      await page.getByRole('button',{name:'작업 패널 열기',exact:true}).click();await surface(true);
    }else assert.equal(await width(),saved,'narrow window does not overwrite saved width');
  }
  assert.deepEqual(errors,[]);
  console.log('PASS integrated work panel: one slot/toolbar, drag/keyboard/reset, width persistence, expand/restore, close/reopen, draft retention, tabs, terminal toggle/keyboard, scheduler activation, modal hiding, native commands/errors, 640/1000/1440px. Unrelated panes and native host are fixtures.');
} finally {await browser?.close();await server.close();}
