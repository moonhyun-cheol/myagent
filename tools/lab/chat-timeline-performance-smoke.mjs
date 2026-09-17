#!/usr/bin/env node
/** Real ChatPane/ToolActivityLog/CSS with isolated HTTP fixtures. No user data or LLM calls. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const workspace=path.join(root,'ui/workspace');
const {createServer}=await import(pathToFileURL(path.join(workspace,'node_modules/vite/dist/node/index.js')).href);
const html=`<!doctype html><html lang="ko"><body><div id="root"></div><script type="module">
import React from 'react';import{createRoot}from'react-dom/client';import{ChatPane}from'/src/components/ChatPane.tsx';import{useWorkspaceStore as store}from'/src/store/workspaceStore.ts';import'/src/index.css';
window.testStore=store;const capability={supported_efforts:['low','high'],auto_behavior:'app_resolved',source:'fallback'};
store.setState({activeSessionId:'timeline-session',activeProjectId:null,activeWorkspaceProjectId:null,chat:[],busy:false,apiError:null,skillMode:null,skillLabel:null,selectedModel:'fixture',modelOptions:[{id:'fixture',label:'Fixture',reasoning_capability:capability}],activeExecutionPolicy:{reasoning:'auto',workspace_behavior:'agent',approval:'delegate',autopilot:'auto'},effectiveExecutionPolicy:{reasoning:'high',workspace_behavior:'agent',approval:'delegate'},previewPaneOpen:false});
createRoot(document.getElementById('root')).render(React.createElement(ChatPane));
</script></body></html>`;
const server=await createServer({root:workspace,server:{host:'127.0.0.1',port:0},plugins:[{name:'timeline-performance-fixture',configureServer(vite){vite.middlewares.use('/__timeline_performance_test',async(req,res,next)=>{if(req.url?.includes('html-proxy'))return next();try{res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml('/__timeline_performance_test',html));}catch(error){next(error);}});}}]});
const executablePath=[process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p=>p&&existsSync(p));
let browser;
try{
  await server.listen();browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(15000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>{const pathname=new URL(route.request().url()).pathname;if(['/src/','/node_modules/','/@','/__timeline_performance_test'].some(prefix=>pathname.startsWith(prefix)))return route.continue();return route.fulfill({json:{}});});
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__timeline_performance_test`);
  const turn={id:'timeline-answer',role:'assistant',text:'최종 응답',thought:'중간 응답',startedAt:new Date(Date.now()-1500).toISOString(),toolActivity:[{id:'tool-1',tool:'read_file',state:'running',startedAt:Date.now()-1200,updatedAt:Date.now()-100,activityGroupId:'group-1'}],workTimeline:[{kind:'response',text:'중간 응답'},{kind:'tool',id:'tool-1'}]};
  await page.evaluate(value=>testStore.setState({chat:[value],busy:true}),turn);
  const timeline=page.locator('[data-work-timeline]');await timeline.waitFor();
  const response=timeline.locator('[data-timeline-kind="response"]'),work=timeline.locator('[data-timeline-kind="tool-group"]');
  assert.equal(await timeline.evaluate(el=>el.open),true);assert.equal(await response.evaluate(el=>el.open),true);assert.equal(await work.evaluate(el=>el.open),false);
  await page.evaluate(()=>testStore.setState({busy:false,chat:testStore.getState().chat.map(item=>({...item,completedAt:new Date().toISOString(),toolActivity:item.toolActivity?.map(row=>({...row,state:'success',finishedAt:Date.now(),updatedAt:Date.now()}))}))}));
  assert.equal(await timeline.evaluate(el=>el.open),false);
  await timeline.locator('summary').first().click();
  assert.equal(await response.evaluate(el=>el.open),true);assert.equal(await work.evaluate(el=>el.open),false);
  await response.locator('summary').click();await work.locator('summary').click();
  await page.evaluate(()=>testStore.setState({activeSessionId:'other-session'}));await page.evaluate(()=>testStore.setState({activeSessionId:'timeline-session'}));
  assert.equal(await timeline.evaluate(el=>el.open),false);
  await timeline.locator('summary').first().click();
  assert.equal(await response.evaluate(el=>el.open),false);assert.equal(await work.evaluate(el=>el.open),true);
  const renderTimings=[];
  for(const count of [100,500,1000]){const ms=await page.evaluate(async n=>{const turns=Array.from({length:n},(_,i)=>({id:`perf-${n}-${i}`,role:i%2?'assistant':'user',text:`합성 대화 ${i}`}));const start=performance.now();testStore.setState({activeSessionId:'perf-session',chat:turns,busy:false});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return performance.now()-start;},count);assert.equal(await page.locator('[data-chat-bubble="true"]').count(),count);assert.ok(ms<5000,`${count} turns: ${ms}ms`);renderTimings.push({count,ms:Math.round(ms)});}
  assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,timeline:'outer open while live/closed on completion; response-open/work-closed defaults; inner user choice survives re-entry',renderTimings},null,2));
}finally{await browser?.close();await server.close();}
