import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from '../ui/workspace/node_modules/vite/dist/node/index.js';
const chromiumPath = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => p && existsSync(p));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = `import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MessageMarkdown} from '/src/components/MessageMarkdown.tsx';
function App(){const [text,setText]=useState(''); window.fixture=setText;
return React.createElement(MessageMarkdown,{text,onOpenUrl:u=>window.opened=u,copyText:async t=>{if(window.failCopy)throw Error('denied');window.copied=t;return true;}});}
createRoot(document.getElementById('root')).render(React.createElement(App));`;
const server = await createServer({ root:path.join(root,'ui/workspace'),configFile:false,logLevel:'error',server:{host:'127.0.0.1',port:0},plugins:[{
name:'markdown-test',resolveId(id){if(id==='/test-entry.js')return '\0test-entry';},load(id){if(id==='\0test-entry')return entry;},configureServer(s){s.middlewares.use((req,res,next)=>{if(req.url!=='/test')return next();res.setHeader('Content-Type','text/html');res.end('<html><body style="margin:8px"><div id="root"></div><script type="module" src="/test-entry.js"></script></body></html>');});}}]});
let browser;
try {
await server.listen();browser=await chromium.launch({headless:true,...(chromiumPath?{executablePath:chromiumPath}:{})});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/test`);await page.waitForFunction(()=>!!window.fixture);
const render=async text=>{await page.evaluate(t=>window.fixture(t),text);await page.waitForTimeout(100);};
await render('3~5일, 10~20개, ~강조 아님~ 그리고 ~~취소~~\n\n# 제목\n\n**굵게** `inline`\n\n|항목|값|\n|---|---|\n|A|B|\n\n1. 설명\n2. 목차\n\n- [x] 표시만');
assert.equal(await page.locator('del').count(),1);assert.equal(await page.locator('del').innerText(),'취소');assert.match(await page.locator('body').innerText(),/3~5일, 10~20개, ~강조 아님~/);assert.equal(await page.locator('table').count(),1);assert.equal(await page.locator('h1').innerText(),'제목');assert.equal(await page.locator('input:disabled').count(),1);
const block='  들여쓰기\n\n3~5일  ';
await render('```text\n'+block+'\n```');assert.equal(await page.locator('pre code').textContent(),block);await page.getByRole('button').click();assert.equal(await page.evaluate(()=>window.copied),block);
await page.evaluate(()=>window.failCopy=true);await page.getByRole('button').click();assert.match(await page.getByRole('button').innerText(),/실패/);await page.evaluate(()=>window.failCopy=false);await page.getByRole('button').click();assert.equal(await page.getByRole('button').innerText(),'복사됨');
await render('```text\n미완성 ~ 범위');assert.equal(await page.locator('pre').count(),1);await render('```text\n미완성 ~ 범위\n```\n\n완료');assert.equal(await page.locator('pre').count(),1);assert.match(await page.locator('p').innerText(),/완료/);
await render('<script>window.pwned=true</script>\n\n<img src=x onerror="window.pwned=true">\n\n[위험](javascript:alert%281%29) ![외부](https://example.invalid/tracker.png) [링크](https://example.com/path)');assert.equal(await page.locator('.message-markdown script,.message-markdown img').count(),0);assert.equal(await page.evaluate(()=>window.pwned),undefined);assert.equal(await page.locator('a').count(),1);await page.locator('a').click();assert.equal(await page.evaluate(()=>window.opened),'https://example.com/path');
await page.setViewportSize({width:375,height:700});await render('```text\n'+'x'.repeat(1000)+'\n```');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));assert.deepEqual(errors,[]);
console.log('PASS Markdown: Korean single tilde, explicit double-tilde, table/list, exact block copy/retry, streaming fences, safe HTML/links/images, narrow viewport');
} finally {await browser?.close();await server.close();}
