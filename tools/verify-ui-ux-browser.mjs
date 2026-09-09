#!/usr/bin/env node
// Isolated Chromium fixture: real UI/store, intercepted API; never touches a live session or process.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../ui/workspace/', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const { chromium } = require('playwright');
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
const { default: react } = await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href);
const { default: tailwindcss } = await import(pathToFileURL(require.resolve('@tailwindcss/vite')).href);
const fixture = mkdtempSync(path.join(root, '.ux-fixture-'));
writeFileSync(path.join(fixture, 'index.html'), '<html lang="ko"><head><meta charset="utf-8"/></head><body><div id="root"></div><script type="module" src="./fixture.tsx"></script></body></html>');
writeFileSync(path.join(fixture, 'fixture.tsx'), `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import '../src/index.css';
import { initializeTheme } from '../src/lib/theme';
import { ThemeSettings } from '../src/components/ThemeSettings';
import { MainWorkspaceContainer } from '../src/components/MainWorkspaceContainer';
import { useWorkspaceStore as store } from '../src/store/workspaceStore';
window.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });
initializeTheme();
window.__ux = { store, saved: 0, recovery: 0 };
const tab = { id:'ux-doc', title:'UX 검증 문서', path:'ux.md', source:'workspace', content:'# 검증 제목\\n\\n**중요 내용**\\n\\n- 첫 항목\\n- 둘째 항목', dirty:false, selection:'', view:'preview', status:null, lastDumpPath:null, lastDumpContent:null, memos:[] };
store.setState({ activeSessionId:'ux-session', activeProjectId:null, activeWorkspaceProjectId:null,
  mode:'document', previewPaneOpen:true, terminalOpen:false, terminalBusy:false, terminalLog:'',
  filesRoot:'C:/fixture/project', files:[], chat:[], assets:[], browserHistory:[], browserLoadedUrl:null,
  documentTabs:[tab], activeDocumentTabId:tab.id,
  refreshExplorer:async()=>{}, refreshSessions:async()=>{}, refreshProjects:async()=>{},
  saveDocumentRecovery:async()=>{window.__ux.recovery++;},
  saveDocument:async()=>{ window.__ux.saved++; store.setState(s=>({documentTabs:s.documentTabs.map(t=>({...t,dirty:false}))})); return true; }
});
createRoot(document.getElementById('root')).render(<div style={{height:'100%',display:'flex',flexDirection:'column'}}><div style={{flexShrink:0}}><ThemeSettings/></div><div style={{flex:1,minHeight:0}}><MainWorkspaceContainer/></div></div>);
`);
let server, browser;
const errors = [];
const requests = [];
let jobs = [], cancelStatus = 200, cancelDelay = 0;
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p => p && existsSync(p));
try {
  server = await createServer({ root, configFile:false, plugins:[react(), tailwindcss()], server:{ host:'127.0.0.1', port:0 }, logLevel:'error' });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const url = `${origin}/${path.basename(fixture)}/index.html`;
  browser = await chromium.launch({headless:true, ...(executablePath ? {executablePath} : {})});
  const context = await browser.newContext({ viewport:{width:1440,height:1000}, colorScheme:'light' });
  await context.route('**/*', async route => {
    const request = route.request(), u = new URL(request.url());
    if (u.origin === origin && !['fetch','xhr'].includes(request.resourceType())) return route.continue();
    if (u.origin !== origin) return route.abort();
    requests.push({path:u.pathname, method:request.method(), body:request.postData()});
    let body = {ok:true};
    if (u.pathname === '/fs/run-terminal/jobs') body = {ok:true,jobs};
    else if (u.pathname === '/fs/run-terminal/cancel') {
      const status = cancelStatus;
      if (cancelDelay) await new Promise(resolve => setTimeout(resolve, cancelDelay));
      return route.fulfill({status,json:{ok:status===200,cancelled:status===200}});
    }
    else if (u.pathname === '/sessions') body = {sessions:[]};
    else if (u.pathname === '/projects') body = {projects:[]};
    else if (u.pathname === '/models/picker') body = {models:[],groups:[]};
    else if (u.pathname === '/skills/selectable') body = {skills:[]};
    else if (u.pathname.includes('/todos')) body = {items:[],todos:[]};
    else if (u.pathname.includes('/automations')) body = {ok:true,tasks:[],items:[],feed:[]};
    else if (u.pathname.startsWith('/documents')) body = {ok:true,documents:[],items:[],workspaces:[]};
    else if (u.pathname === '/config') body = {ui:{},providers:{}};
    else if (u.pathname === '/fs/workspace-tree') body = {root:'C:/fixture/project',tree:[]};
    return route.fulfill({status:200,json:body});
  });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.setDefaultTimeout(15000);
  await page.goto(url);
  await page.getByTestId('markdown-document').waitFor();
  await page.getByRole('heading',{name:'검증 제목'}).waitFor();
  const setState = async state => page.evaluate(state => window.__ux.store.setState(state),state);
  const theme = page.getByRole('combobox',{name:'화면 테마',exact:true});
  assert.equal(await theme.inputValue(),'system');
  await page.emulateMedia({colorScheme:'dark'});
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
  await theme.selectOption('light');
  await page.emulateMedia({colorScheme:'dark'});
  assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
  await theme.selectOption('dark');
  await page.reload();
  await page.getByTestId('markdown-document').waitFor();
  assert.equal(await theme.inputValue(),'dark');
  const second = await context.newPage();
  await second.goto(url);
  await second.getByRole('combobox',{name:'화면 테마',exact:true}).selectOption('light');
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');
  await second.close();
  console.log('PASS theme: system changes, explicit preference, reload, cross-window sync');

  const contrasts = [];
  for (const mode of ['light','dark']) {
    await theme.selectOption(mode);
    contrasts.push(...await page.evaluate(mode => {
      const css=getComputedStyle(document.documentElement);
      const rgb=token=>{const el=document.createElement('span');el.style.color=css.getPropertyValue(token);document.body.append(el);const c=getComputedStyle(el).color.match(/[\d.]+/g).slice(0,3).map(Number);el.remove();return c;};
      const lum=rgb=>rgb.map(n=>n/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4).reduce((s,n,i)=>s+n*[.2126,.7152,.0722][i],0);
      const rows=[];
      for(const fg of ['--color-text','--color-muted','--color-accent','--color-danger','--color-warning','--color-info','--color-success']) for(const bg of ['--color-panel','--color-ink','--surface-raised','--surface-terminal']) {const a=lum(rgb(fg)),b=lum(rgb(bg));rows.push({mode,fg,bg,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)});}
      const a=lum(rgb('--color-on-accent')),b=lum(rgb('--color-accent'));rows.push({mode,fg:'button text',bg:'accent',ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)});
      for (const className of ['bg-accent text-ink','bg-accent-dim text-white']) {
        const el=document.createElement('button');el.className=className;el.textContent='대비';document.body.append(el);
        const style=getComputedStyle(el),parse=value=>value.match(/[\d.]+/g).slice(0,3).map(Number);
        const a=lum(parse(style.color)),b=lum(parse(style.backgroundColor));rows.push({mode,fg:className,bg:'rendered button',ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)});el.remove();
      }
      return rows;
    },mode));
  }
  assert.ok(contrasts.every(row=>row.ratio>=4.5),JSON.stringify(contrasts.filter(row=>row.ratio<4.5)));
  console.log(`PASS contrast: ${contrasts.length} text/surface pairs >= 4.5:1; minimum ${Math.min(...contrasts.map(r=>r.ratio)).toFixed(2)}:1`);

  assert.equal(await page.getByTestId('document-save-state').innerText(),'프로젝트 파일 · 변경 없음');
  await page.evaluate(()=>window.__ux.store.setState(s=>({documentTabs:s.documentTabs.map(t=>({...t,dirty:true}))})));
  assert.match(await page.getByTestId('document-save-state').innerText(),/저장되지 않은 변경/);
  await page.getByTestId('document-primary-save').click();
  assert.equal(await page.evaluate(()=>window.__ux.saved),1);
  const views = page.getByRole('tablist',{name:'문서 보기',exact:true});
  await views.getByRole('tab',{name:'읽기',exact:true}).focus();
  await page.keyboard.press('ArrowRight');
  await page.locator('.monaco-editor').first().waitFor();
  assert.equal(await views.getByRole('tab',{name:'편집',exact:true}).getAttribute('aria-selected'),'true');
  assert.ok(await page.locator('.monaco-editor.vs-dark').count());
  await theme.selectOption('light');
  await page.locator('.monaco-editor.vs').first().waitFor();
  await views.getByRole('tab',{name:'읽기',exact:true}).click();
  await page.getByRole('button',{name:'더보기',exact:true}).click();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('button',{name:'더보기',exact:true}).getAttribute('aria-expanded'),'false');
  assert.equal(await page.evaluate(()=>document.activeElement.textContent),'더보기');
  console.log('PASS document: rendered headings/lists, dirty state, primary save delegation, tab keyboard, Monaco theme, menu Escape/focus');

  const input = page.getByRole('textbox',{name:'메시지 입력',exact:true});
  await input.fill('지워지면 안 되는 입력 초안');
  const split = page.getByRole('separator',{name:'작업 패널 너비'});
  await split.focus(); const before=Number(await split.getAttribute('aria-valuenow'));
  await page.keyboard.press('ArrowLeft');
  assert.equal(Number(await split.getAttribute('aria-valuenow')),before+16);
  const preferred=await page.evaluate(()=>localStorage.getItem('my-agent.work-panel-width.v1'));
  await input.focus();
  await page.getByRole('button',{name:'작업 패널 확대',exact:true}).click();
  await page.getByRole('button',{name:'분할 보기로 복원',exact:true}).click();
  assert.equal(await input.inputValue(),'지워지면 안 되는 입력 초안');
  await page.locator('[data-work-panel]').getByRole('button',{name:'작업 패널 닫기',exact:true}).click();
  assert.equal(await input.inputValue(),'지워지면 안 되는 입력 초안');
  await page.waitForFunction(()=>document.activeElement.getAttribute('aria-label')==='메시지 입력');
  await setState({previewPaneOpen:true});
  await page.setViewportSize({width:700,height:900});
  const nav=page.getByRole('navigation',{name:'대화와 작업 화면 전환'});
  await nav.waitFor();
  await nav.getByRole('button',{name:'작업 화면',exact:true}).click();
  await page.getByRole('heading',{name:'검증 제목'}).waitFor();
  await nav.getByRole('button',{name:'대화',exact:true}).click();
  assert.equal(await input.inputValue(),'지워지면 안 되는 입력 초안');
  await page.setViewportSize({width:1440,height:1000});
  await split.waitFor();
  assert.equal(await page.evaluate(()=>localStorage.getItem('my-agent.work-panel-width.v1')),preferred);
  console.log('PASS layout: keyboard resize, persisted width, expand/close focus restoration, narrow switch, draft retained');

  jobs=[{id:'ux-job',command:'fixture-command (not executed)',kind:'ui',age_ms:3000,started_at:Date.now()-3000}];
  await setState({terminalBusy:true,terminalJobId:'ux-job',terminalOpen:false,terminalLog:'running'});
  const summary=page.locator('.terminal-summary');
  await page.waitForFunction(()=>document.querySelector('.terminal-summary').textContent.includes('실행 중 1개'));
  await summary.click();
  cancelStatus=500;
  await page.getByRole('button',{name:'직접 실행 명령 중지',exact:true}).click();
  await page.getByRole('status').filter({hasText:'정지 요청 실패'}).waitFor();
  cancelStatus=200;
  await page.getByRole('button',{name:'직접 실행 명령 중지',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.terminal-summary').textContent.includes('정지 결과 대기'));
  assert.doesNotMatch(await summary.innerText(),/실제 중단됨/);
  await page.getByRole('button',{name:'로그만 지우기',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.__ux.store.getState().terminalBusy),true);
  const cancelRequests=requests.filter(r=>r.path==='/fs/run-terminal/cancel');
  assert.equal(cancelRequests.length,2);
  assert.deepEqual(JSON.parse(cancelRequests[1].body),{job_id:'ux-job'});
  jobs=[];
  await setState({terminalBusy:false,terminalJobId:null,terminalLog:'[cancelled]'});
  await page.waitForFunction(()=>document.querySelector('.terminal-summary').textContent.includes('실제 중단됨'));
  await summary.click();
  assert.match(await summary.innerText(),/실제 중단됨/);
  console.log('PASS terminal: collapsed running count, failed request/retry, ACK != stopped, final cancellation, clear != kill');

  jobs=[{id:'ux-agent-job',command:'agent fixture (not executed)',kind:'agent',age_ms:1000,started_at:Date.now()-1000}];
  await setState({terminalOpen:true,terminalLog:''});
  const activeJobs=page.getByTestId('terminal-active-jobs');
  await activeJobs.locator('summary').click();
  const agentStop=activeJobs.getByRole('button',{name:'agent fixture (not executed) 중지',exact:true});
  cancelStatus=500;
  await agentStop.click();
  await page.waitForFunction(()=>document.querySelector('.terminal-summary').textContent.includes('정지 요청 실패'));
  await summary.click();
  assert.match(await summary.innerText(),/정지 요청 실패/);
  await summary.click();
  cancelStatus=200; cancelDelay=500;
  await agentStop.click();
  await page.waitForFunction(()=>document.querySelector('.terminal-summary').textContent.includes('정지 요청 중 1개'));
  await summary.click();
  await page.waitForFunction(()=>document.querySelector('.terminal-summary').textContent.includes('정지 결과 대기 1개'));
  assert.doesNotMatch(await summary.innerText(),/실제 중단됨/);
  jobs=[]; cancelDelay=0;
  await summary.click();
  await page.waitForFunction(()=>document.querySelector('.terminal-summary').textContent.includes('터미널 · 대기'));
  assert.doesNotMatch(await summary.innerText(),/정지 결과 대기|정지 요청 실패|실제 중단됨/);
  await setState({terminalAttention:true});
  await page.waitForFunction(()=>document.querySelector('.terminal-summary').dataset.attention==='true');
  await page.waitForFunction(()=>window.__ux.store.getState().terminalAttention===false);
  await page.getByRole('textbox',{name:'PowerShell 명령',exact:true}).focus();
  await page.keyboard.press('Escape');
  assert.equal(await summary.getAttribute('aria-expanded'),'false');
  assert.equal(await summary.evaluate(el=>el===document.activeElement),true);
  console.log('PASS terminal agent jobs: global folded request/failure summary, no false stopped state, stale status cleared, bounded attention, Escape focus');

  await page.setViewportSize({width:640,height:800}); // 1280px window at 200% effective CSS width
  await nav.getByRole('button',{name:'작업 화면',exact:true}).click();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  for(const selector of ['[data-testid="document-primary-save"]','[aria-label="채팅으로 돌아가기"]','.terminal-summary']) {
    const box=await page.locator(selector).boundingBox(); assert.ok(box&&box.x>=0&&box.x+box.width<=640,selector);
  }
  await page.getByRole('button',{name:'채팅으로 돌아가기',exact:true}).click();
  await input.waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.equal(errors.length,0,errors.join('\n'));
  assert.ok(!requests.some(r=>r.path==='/chat/stream'),'No real generation or work execution');
  console.log('PASS effective 200% viewport: no page overflow, save/close/summary reachable, return to chat');
  console.log('PASS UI/UX integration (isolated API fixture; native Windows/real process termination not exercised)');
} finally {
  await browser?.close();
  await server?.close();
  rmSync(fixture,{recursive:true,force:true});
}
