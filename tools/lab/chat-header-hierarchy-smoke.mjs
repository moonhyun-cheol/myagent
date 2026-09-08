#!/usr/bin/env node
/** Real conversation component + CSS, isolated store actions and API fixtures. Never uses user data. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workspace = path.join(root, 'ui/workspace');
const { createServer } = await import(pathToFileURL(path.join(workspace, 'node_modules/vite/dist/node/index.js')).href);
const server = await createServer({ root: workspace, server: { host: '127.0.0.1', port: 0, strictPort: false }, plugins: [{
  name: 'isolated-chat-header-fixture',
  configureServer(vite) {
    vite.middlewares.use('/__chat_header_test', async (req, res, next) => {
      if (req.url?.includes('html-proxy')) return next();
      try { res.setHeader('Content-Type', 'text/html'); res.end(await vite.transformIndexHtml('/__chat_header_test', html)); } catch(error) { next(error); }
    });
  },
}] });
const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatPane } from '/src/components/ChatPane.tsx';
import { useWorkspaceStore as store } from '/src/store/workspaceStore.ts';
import '/src/index.css';
window.testStore = store;
window.changes = [];
const capability = {supported_efforts: ['minimal','low','medium','high','xhigh','max'], auto_behavior:'app_resolved', source:'fallback'};
store.setState({ activeSessionId:null, activeProjectId:null, activeWorkspaceProjectId:null, chat:[], busy:false, apiError:null, skillMode:null, skillLabel:null,
 selectedModel:'astra', modelOptions:[{id:'astra',label:'gpt-6-astra',access_mode:'managed',reasoning_capability:capability},{id:'sol',label:'Sol',access_mode:'byok',reasoning_capability:capability}],
 activeExecutionPolicy:{reasoning:'auto',workspace_behavior:'agent',approval:'delegate',autopilot:'auto'},
 effectiveExecutionPolicy:{reasoning:'high',workspace_behavior:'agent',approval:'delegate'},
 setSelectedModel:async (id)=>{window.changes.push(['model',id]);store.setState({selectedModel:id});},
 setExecutionPolicy:async (patch)=>{window.changes.push(['policy',patch]);store.setState({activeExecutionPolicy:{...store.getState().activeExecutionPolicy,...patch}});if(window.createPolicySession)store.setState({activeSessionId:'created-fixture'});if(window.delayPolicy)await new Promise((resolve)=>window.finishPolicy=resolve);if(window.failPolicy)throw Error('정책 저장 실패 테스트');},
 setSessionWorkspaceProject:async (id)=>{if(window.failWorkspace)throw Error('연결 저장 실패 테스트');window.changes.push(['workspace',id]);store.setState({activeWorkspaceProjectId:id});},
 setSkillMode:(mode,label)=>store.setState({skillMode:mode,skillLabel:label??null}),
 refreshModelPicker:async ()=>{window.changes.push(['refresh']);},
 setPreviewPaneOpen:(value)=>store.setState({previewPaneOpen:value}), previewPaneOpen:false
});
createRoot(document.getElementById('root')).render(React.createElement(ChatPane));
</script></body></html>`;

const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => p && existsSync(p));
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless:true, ...(executablePath ? {executablePath} : {}) });
  const page = await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[];
  page.on('pageerror',(error)=>{errors.push(error.message); console.error('Browser error:', error.message);});
  page.on('console',(message)=>{if(message.type()==='error')console.error('Browser console:',message.text());});
  page.on('requestfailed',(request)=>console.error('Request failed:',request.url(),request.failure()));
  await page.route('**/*', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (['/src/', '/node_modules/', '/@', '/__chat_header_test'].some((prefix)=>pathname.startsWith(prefix))) return route.continue();
    return route.fulfill({json:{}}); // No live API, files, or user sessions may be accessed.
  });
  await page.route('**/workspace?*', (route)=>route.fulfill({json:{workspace_trees:[{id:'workspace-fixture',kind:'workspace_root',title:'MY_CUSTOM_CODEX',folder_path:'C:/fixture/MY_CUSTOM_CODEX',children:[]}],projects:[]}}));
  await page.route('**/skills/selectable',(route)=>route.fulfill({json:{skills:[{mode:'org:design',label:'디자인 검토',description:'검증용 스킬'}]}}));
  const address=server.httpServer.address();
  await page.goto(`http://127.0.0.1:${address.port}/__chat_header_test`);
  const header=page.getByTestId('chat-settings-header');
  await header.waitFor();
  const test=(id)=>page.getByTestId(id);
  const dialog=test('chat-policy-popover');
  const assertChoiceFocused=async(id)=>assert.equal(await test(id).locator('[aria-checked="true"]').evaluate((el)=>el===document.activeElement),true);
  const choice=(id,value)=>test(id).locator(`[data-value="${value}"]`);
  const assertAnchored=async(trigger)=>{
    const anchor=await test(trigger).boundingBox(), panel=await dialog.boundingBox();
    const width=page.viewportSize().width;
    assert.ok(Math.abs(panel.x-Math.max(8,Math.min(anchor.x,width-panel.width-8)))<=1,'popup must align with clicked control');
    assert.ok(Math.abs(panel.y-(anchor.y+anchor.height+6))<=1,'popup must open directly below trigger');
  };
  const assertFocused=async (id)=>assert.equal(await test(id).evaluate((el)=>el===document.activeElement),true,`${id} should receive focus`);
  const close=async()=>{await page.getByRole('button',{name:'설정 닫기',exact:true}).click();await dialog.waitFor({state:'hidden'});};
  assert.equal(await test('skill-status-bar').count(),0);
  assert.match(await test('chat-reasoning-button').innerText(),/자동/,'show selected auto, not last effective high');
  assert.ok((await header.boundingBox()).height<=56,'desktop header must stay compact');
  assert.equal(await page.evaluate(()=>Boolean(window.testStore)),true,'isolated fixture must be mounted');
  await test('chat-model-select').selectOption('sol', {timeout:5000});
  assert.equal(await page.evaluate(()=>testStore.getState().selectedModel),'sol');
  for(const [trigger,target,value] of [['chat-execution-policy','chat-workspace-behavior','plan'],['chat-reasoning-button','chat-reasoning-level','xhigh'],['chat-approval-button','chat-approval-level','ask']]){
    await test(trigger).click();await assertChoiceFocused(target);await assertAnchored(trigger);
    assert.equal(await dialog.getByRole('menu').count(),1,'only requested setting is shown');
    await choice(target,value).click();await dialog.waitFor({state:'hidden'});await assertFocused(trigger);
  }
  assert.deepEqual(await page.evaluate(()=>testStore.getState().activeExecutionPolicy),{reasoning:'xhigh',workspace_behavior:'plan',approval:'ask',autopilot:'off'});
  await test('chat-reasoning-button').focus();await page.keyboard.press('Enter');await assertChoiceFocused('chat-reasoning-level');
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});await assertFocused('chat-reasoning-button');
  const focusStyle=await test('chat-reasoning-button').evaluate((el)=>getComputedStyle(el).outlineWidth);
  assert.equal(focusStyle,'2px');
  await test('chat-execution-policy').click();await page.locator('textarea').first().click();await dialog.waitFor({state:'hidden'});
  // One popup only; repeated clicks toggle, switching controls follows the new anchor.
  await test('chat-execution-policy').click();await test('chat-reasoning-button').click();
  assert.equal(await dialog.count(),1);assert.equal(await test('chat-workspace-behavior').count(),0);
  await assertAnchored('chat-reasoning-button');await test('chat-reasoning-button').click();await dialog.waitFor({state:'hidden'});
  // Menu arrows move focus without saving; Enter commits and restores trigger focus.
  await test('chat-execution-policy').click();await page.keyboard.press('Home');
  assert.equal(await choice('chat-workspace-behavior','agent').evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('ArrowDown');await page.keyboard.press('End');await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');await dialog.waitFor({state:'hidden'});await assertFocused('chat-execution-policy');
  await test('chat-execution-policy').click();await page.keyboard.press('Tab');await dialog.waitFor({state:'hidden'});
  await assertFocused('chat-reasoning-button');
  // Optimistic store failures must roll back, stay open, and allow retry.
  await page.evaluate(()=>window.failPolicy=true);
  await test('chat-execution-policy').click();await choice('chat-workspace-behavior','ask').click();
  await dialog.getByRole('alert').waitFor();
  assert.equal(await page.evaluate(()=>testStore.getState().activeExecutionPolicy.workspace_behavior),'plan');
  assert.equal(await choice('chat-workspace-behavior','plan').getAttribute('aria-checked'),'true');
  await page.evaluate(()=>window.failPolicy=false);
  await choice('chat-workspace-behavior','ask').click();await dialog.waitFor({state:'hidden'});
  // Approval mapping and required safety explanation are preserved.
  for(const [value,autopilot] of [['autopilot','on'],['delegate','auto'],['ask','off']]){
    await test('chat-approval-button').click();
    assert.match(await dialog.innerText(),/外部|외부 쓰기·삭제·롤백/);
    await choice('chat-approval-level',value).click();await dialog.waitFor({state:'hidden'});
    assert.equal(await page.evaluate(()=>testStore.getState().activeExecutionPolicy.autopilot),autopilot);
  }
  // Late completion must not dismiss a newly opened popup or steal focus.
  await page.evaluate(()=>window.delayPolicy=true);
  await test('chat-execution-policy').click();await choice('chat-workspace-behavior','agent').click();
  await dialog.getByRole('status').waitFor();
  assert.equal(await choice('chat-workspace-behavior','plan').isDisabled(),true);
  await page.keyboard.press('Escape');await test('chat-reasoning-button').click();
  await page.evaluate(()=>{window.delayPolicy=false;window.finishPolicy();});
  await dialog.getByRole('status').waitFor({state:'hidden'});
  assert.equal(await dialog.getAttribute('aria-label'),'추론 수준');await close();
  // Creating a first session during save must not hide a subsequent error.
  await page.evaluate(()=>{window.createPolicySession=true;window.delayPolicy=true;window.failPolicy=true;});
  await test('chat-execution-policy').click();await choice('chat-workspace-behavior','ask').click();
  await dialog.getByRole('status').waitFor();
  await page.evaluate(()=>{window.delayPolicy=false;window.finishPolicy();});
  await dialog.getByRole('alert').waitFor();
  assert.equal(await page.evaluate(()=>testStore.getState().activeExecutionPolicy.workspace_behavior),'agent');
  await page.evaluate(()=>{window.createPolicySession=false;window.failPolicy=false;});
  await choice('chat-workspace-behavior','ask').click();await dialog.waitFor({state:'hidden'});
  await test('chat-execution-policy').click();
  await page.evaluate(()=>testStore.setState({activeSessionId:'another-fixture'}));
  await dialog.waitFor({state:'hidden'});
  // Model capability, rather than a fixed list, determines the choices.
  await page.evaluate(()=>testStore.setState({modelOptions:[{id:'sol',label:'Sol',access_mode:'byok',reasoning_capability:{supported_efforts:['low','high'],auto_behavior:'app_resolved',source:'fallback'}}]}));
  await test('chat-reasoning-button').click();
  assert.deepEqual(await test('chat-reasoning-level').getByRole('menuitemradio').evaluateAll(items=>items.map(el=>el.dataset.value)),['auto','low','high']);
  await close();
  await test('chat-workspace-button').click();await assertFocused('chat-workspace-select');
  await test('chat-workspace-select').selectOption('workspace-fixture');await close();
  assert.match(await test('chat-workspace-button').innerText(),/MY_CUSTOM_CODEX/);
  assert.equal(await test('chat-workspace-button').getAttribute('title'),'C:/fixture/MY_CUSTOM_CODEX');
  await test('chat-workspace-button').click();
  await page.evaluate(()=>{window.failWorkspace=true;});
  await test('chat-workspace-select').selectOption('');
  await page.getByText('연결 저장 실패 테스트',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>testStore.getState().activeWorkspaceProjectId),'workspace-fixture');
  await page.evaluate(()=>{window.failWorkspace=false;});
  await test('chat-workspace-select').selectOption('');await close();
  assert.equal(await test('chat-workspace-button').innerText(),'작업폴더 연결');
  await test('organization-skill-button').click();
  await test('organization-skill-menu').getByRole('button',{name:'디자인 검토',exact:false}).click();
  await test('skill-status-bar').waitFor();assert.match(await test('skill-status-bar').innerText(),/디자인 검토/);
  assert.ok((await test('skill-status-bar').boundingBox()).height<=44);
  await test('skill-status-bar').getByRole('button',{name:'변경',exact:true}).click();
  await test('organization-skill-menu').waitFor();
  assert.equal(await test('organization-skill-clear').evaluate((el)=>el===document.activeElement),true);
  await test('organization-skill-clear').click();await test('skill-status-bar').waitFor({state:'hidden'});
  await assertFocused('organization-skill-button');
  await test('organization-skill-button').focus();await page.keyboard.press('Enter');
  await test('organization-skill-menu').waitFor();await page.keyboard.press('Escape');
  await test('organization-skill-menu').waitFor({state:'hidden'});await assertFocused('organization-skill-button');
  await page.evaluate(()=>testStore.getState().setSkillMode('org:design','디자인 검토'));
  await test('skill-status-action').click();await test('skill-status-bar').waitFor({state:'hidden'});await assertFocused('organization-skill-button');
  await page.getByRole('button',{name:'모델 목록 새로고침',exact:true}).click();
  await page.getByRole('button',{name:'Preview 열기',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'Preview 닫기',exact:true}).getAttribute('aria-pressed'),'true');
  await page.evaluate(()=>testStore.setState({busy:true}));
  assert.equal(await test('chat-model-select').isDisabled(),true);
  for(const [trigger,id] of [['chat-execution-policy','chat-workspace-behavior'],['chat-reasoning-button','chat-reasoning-level'],['chat-approval-button','chat-approval-level']]){
    await test(trigger).click();
    for(const item of await test(id).getByRole('menuitemradio').all())assert.equal(await item.isDisabled(),true);
    await close();
  }
  await page.evaluate(()=>testStore.setState({busy:false,skillMode:'image',skillLabel:'이미지'}));
  assert.match(await test('chat-reasoning-button').innerText(),/미사용/);
  await test('chat-reasoning-button').click();
  for(const item of await test('chat-reasoning-level').getByRole('menuitemradio').all())assert.equal(await item.isDisabled(),true);
  await close();
  await page.evaluate(()=>testStore.setState({skillMode:'org:design',skillLabel:'아주 긴 조직 스킬 이름 '.repeat(6),selectedModel:'long',modelOptions:[{id:'long',label:'아주 긴 모델 이름 '.repeat(10),access_mode:'managed'}]}));
  const reflow=[];
  assert.equal(await test('chat-model-select').getAttribute('title'),'아주 긴 모델 이름 '.repeat(10));
  // 720x450 is the CSS viewport of a 1440x900 window at 200% browser zoom.
  for(const [width,height] of [[1440,900],[720,450],[480,720],[320,640]]){
    await page.setViewportSize({width,height});
    await test('chat-approval-button').click();await dialog.waitFor();await assertAnchored('chat-approval-button');
    const geometry=await page.evaluate(()=>{
      const header=document.querySelector('[data-testid="chat-settings-header"]');
      const panel=document.querySelector('[data-testid="chat-policy-popover"]');
      const rect=panel.getBoundingClientRect();
      return {headerOverflow:header.scrollWidth>header.clientWidth, left:rect.left,right:rect.right,bottom:rect.bottom,
        controls:[...header.querySelectorAll('button,select')].filter((el)=>!panel.contains(el)).map((el)=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,height:r.height};})};
    });
    assert.equal(geometry.headerOverflow,false,`header overflow at ${width}`);
    assert.ok(geometry.left>=0&&geometry.right<=width+1&&geometry.bottom<=height+1,`popup outside viewport: ${JSON.stringify(geometry)}`);
    for(const rect of geometry.controls)assert.ok(rect.left>=0&&rect.right<=width+1&&rect.height>=32,`control clipping at ${width}`);
    reflow.push({width,height,ok:true});await close();
  }
  // Resize with the menu still open; follow the trigger rather than the old coordinates.
  await page.setViewportSize({width:1440,height:900});await test('chat-execution-policy').click();
  await page.setViewportSize({width:480,height:720});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await assertAnchored('chat-execution-policy');await close();
  // Sidebar / split-pane movement can move the header without a window resize.
  await page.setViewportSize({width:1440,height:900});await test('chat-execution-policy').click();
  await page.evaluate(()=>{const el=document.getElementById('root');el.style.width='480px';el.style.marginLeft='200px';});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await assertAnchored('chat-execution-policy');await close();
  await page.evaluate(()=>{document.getElementById('root').removeAttribute('style');});
  // A short viewport constrains scrolling; keyboard still reaches the final reasoning choice.
  await page.setViewportSize({width:480,height:260});await test('chat-reasoning-button').click();
  await page.keyboard.press('End');
  const bounds=await dialog.boundingBox();assert.ok(bounds.y>=0&&bounds.y+bounds.height<=260);
  assert.equal(await test('chat-reasoning-level').getByRole('menuitemradio').last().evaluate(el=>el===document.activeElement),true);
  await close();
  // Verify actual palette pairs used by compact settings and active state.
  const contrast=(a,b)=>{const lum=(hex)=>{const c=hex.match(/\w\w/g).map((n)=>parseInt(n,16)/255).map((n)=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4);return c[0]*.2126+c[1]*.7152+c[2]*.0722;};const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
  for(const [fg,bg] of [['17211d','f4f5f2'],['4f5d57','f4f5f2'],['0b7068','f4f5f2'],['0b7068','e0efeb']])assert.ok(contrast(fg,bg)>=4.5,`${fg}/${bg} contrast`);
  assert.deepEqual(errors,[]);
  assert.ok(await page.evaluate(()=>changes.some(([type])=>type==='refresh')));
  console.log(JSON.stringify({ok:true,checks:['model change','single-setting menus anchored to each trigger','auto label and model capabilities','focus/arrows/Home/End/Enter/Escape/Tab/outside click','policy failure rollback/retry','approval mapping and safety explanation','pending save and late completion','first session creation and session switch','workspace bind/unbind/failure','skill select/change/clear','refresh and Preview','busy/image state','live resize and split pane','short viewport scrolling','long labels','text contrast'],reflow},null,2));
} finally { await browser?.close();await server.close(); }
