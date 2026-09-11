import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from '../ui/workspace/node_modules/vite/dist/node/index.js';
import tailwindcss from '../ui/workspace/node_modules/@tailwindcss/vite/dist/index.mjs';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const playwrightBrowsers = path.join(root, 'runtime', 'playwright', 'browsers');
const headlessShell = readdirSync(playwrightBrowsers)
  .filter((name) => name.startsWith('chromium_headless_shell-'))
  .sort()
  .at(-1);
assert.ok(headlessShell, 'bundled Playwright headless shell is required');
const browserExecutable = path.join(playwrightBrowsers, headlessShell, 'chrome-win', 'headless_shell.exe');
const errors = [];
const cancelled = [];
let browser;
const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ToolActivityLog } from '/src/components/ToolActivityLog.tsx';
import '/src/index.css';
const now = Date.now();
const initialRows = [
  { id:'a', activityGroupId:'batch-1', tool:'run_terminal', target:'one', state:'running', cancelSessionId:'session', startedAt:now-3000, updatedAt:now, output:'first output', truncated:false },
  { id:'b', activityGroupId:'batch-1', tool:'run_tests', target:'two', state:'running', cancelSessionId:'session', startedAt:now-2000, updatedAt:now, output:'second output', truncated:false },
  { id:'c', activityGroupId:'batch-2', tool:'list_directory', target:'.', state:'success', startedAt:now-1000, updatedAt:now, finishedAt:now, output:'listed', truncated:false },
];
const timeline = [
  { kind:'response', text:'확인 중' },
  { kind:'tool', id:'a' }, { kind:'tool', id:'b' }, { kind:'tool', id:'c' },
];
function App() {
  const [rows,setRows] = useState(initialRows);
  const [live,setLive] = useState(true);
  window.complete = () => { setRows(old => old.map(row => ({...row,state:'success',finishedAt:Date.now(),updatedAt:Date.now()}))); setLive(false); };
  return React.createElement('main', {style:{width:'720px',padding:'12px'}},
    React.createElement(ToolActivityLog, {rows,timeline,live,modelResponse:'확인 중'}));
}
createRoot(document.getElementById('root')).render(React.createElement(App));
`;
const server = await createServer({
  root: path.join(root, 'ui', 'workspace'),
  configFile: false,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
  plugins: [tailwindcss(), {
    name: 'grouped-tool-activity-ui',
    resolveId(id) { if (id === '/grouped-tool-entry.js') return '\0grouped-tool-entry'; },
    load(id) { if (id === '\0grouped-tool-entry') return entry; },
    configureServer(vite) {
      vite.middlewares.use((req,res,next) => {
        if (req.url === '/grouped-tool-test') {
          res.setHeader('Content-Type','text/html; charset=utf-8');
          res.end('<!doctype html><html><body><div id="root"></div><script type="module" src="/grouped-tool-entry.js"></script></body></html>');
          return;
        }
        if (req.url === '/fs/tool-execution/cancel' && req.method === 'POST') {
          let raw=''; req.on('data',chunk=>{raw+=chunk;}); req.on('end',()=>{cancelled.push(JSON.parse(raw).id);res.statusCode=200;res.setHeader('Content-Type','application/json');res.end('{"ok":true}');});
          return;
        }
        next();
      });
    },
  }],
});
try {
  await server.listen();
  const address = server.httpServer.address();
  browser = await chromium.launch({
    headless: true,
    executablePath: browserExecutable,
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/grouped-tool-test`);
  const details = page.locator('[data-work-timeline]');
  await details.waitFor();
  assert.equal(await details.getAttribute('open'), '');
  assert.match(await details.locator('summary').innerText(), /응답 1 · 작업 2 · 진행 중/);
  assert.equal(await details.locator('[data-timeline-kind="tool-group"]').count(), 2);
  assert.equal(await details.locator('[data-activity-group-id="batch-1"] [data-timeline-kind="tool"]').count(), 2);
  const groupCancel = details.getByRole('button', { name: '작업 1 중단 후 이어가기' });
  await groupCancel.click();
  await page.waitForFunction(() => document.body.innerText.includes('중단 요청 중'));
  for (let tries=0; tries<20 && cancelled.length<2; tries+=1) await page.waitForTimeout(50);
  assert.deepEqual([...cancelled].sort(), ['a','b']);
  await page.evaluate(() => window.complete());
  await page.waitForFunction(() => !document.querySelector('[data-work-timeline]')?.open);
  assert.match(await details.locator('summary').innerText(), /응답 1 · 작업 2 · 완료/);
  await details.locator('summary').click();
  assert.match(await details.innerText(), /first output/);
  assert.deepEqual(errors, []);
  console.log('PASS grouped tool batches, unified auto-collapse, and group subtask cancellation UI');
} finally {
  await browser?.close();
  await server.close();
}
