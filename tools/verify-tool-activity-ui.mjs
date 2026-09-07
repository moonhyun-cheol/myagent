import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from '../ui/workspace/node_modules/vite/dist/node/index.js';
import tailwindcss from '../ui/workspace/node_modules/@tailwindcss/vite/dist/index.mjs';
import { executeAgentTool } from '../core/dist/agent/agent-tool-execute.js';

// Isolated acceptance harness: real shell + real SSE client + real log component.
// No model call, product API process, saved user session, or deployment is touched.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(root, 'data', '_skill_tool_lab');
mkdirSync(base, { recursive: true });
const temp = mkdtempSync(path.join(base, 'activity-ui-'));
const errors = [];
let shellDone = false;
let shellTask;
let browser;
const abort = new AbortController();
const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ToolActivityLog } from '/src/components/ToolActivityLog.tsx';
import { streamChat } from '/src/api/myAgentClient.ts';
import '/src/index.css';
function App() {
  const [rows, setRows] = useState([]);
  const [live, setLive] = useState(true);
  window.fixture = (next, active = false) => { setRows(next); setLive(active); };
  window.startStream = () => streamChat({ message: 'isolated acceptance', sessionId: 'activity-test' }, {
    onToolActivity: row => setRows(old => { const next = old.filter(r => r.id !== row.id); return [...next, row]; }),
  }).then(() => { setLive(false); window.streamDone = true; });
  return React.createElement('main', { style: { width: '100%', maxWidth: 720, padding: 12 } },
    React.createElement('h1', null, 'Execution log acceptance'),
    React.createElement(ToolActivityLog, { rows, live }));
}
createRoot(document.getElementById('root')).render(React.createElement(App));
`;
const server = await createServer({
  root: path.join(root, 'ui', 'workspace'), configFile: false, logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
  plugins: [tailwindcss(), {
    name: 'isolated-tool-activity-acceptance',
    resolveId(id) { if (id === '/activity-test-entry.js') return '\0activity-test-entry'; },
    load(id) { if (id === '\0activity-test-entry') return entry; },
    configureServer(s) {
      s.middlewares.use((req, res, next) => {
        if (req.url === '/activity-test') {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/activity-test-entry.js"></script></body></html>');
          return;
        }
        if (req.url !== '/chat/stream') return next();
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.flushHeaders();
        shellTask = executeAgentTool(temp, { id: 'ui-shell', type: 'function', function: {
          name: 'run_terminal', arguments: JSON.stringify({ command: "[Console]::Out.WriteLine('first-live'); [Console]::Out.WriteLine('api_key=fixture-private'); Start-Sleep -Seconds 5; [Console]::Error.WriteLine('stderr-live'); [Console]::Out.WriteLine('last-live'); exit 0" }),
        } }, {}, { signal: abort.signal, onToolActivity: activity => {
          // Split each SSE event over writes to exercise the production parser.
          const event = `data: ${JSON.stringify({ type: 'tool_activity', activity })}\n\n`;
          const split = Math.floor(event.length / 2);
          res.write(event.slice(0, split)); res.write(event.slice(split));
        } }).then(result => {
          shellDone = true;
          assert.equal(JSON.parse(result.output).ok, true);
          res.end();
        }).catch(error => { errors.push(String(error)); res.end(); });
      });
    },
  }],
});
try {
  await server.listen();
  const address = server.httpServer.address();
  const url = `http://127.0.0.1:${address.port}/activity-test`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => typeof window.startStream === 'function');
  assert.equal(await page.locator('[data-tool-activity]').count(), 0);
  await page.evaluate(() => { window.startStream(); });
  await page.waitForFunction(() => document.querySelector('summary')?.textContent.includes('[REDACTED]'));
  assert.equal(shellDone, false, 'visible output must precede actual shell completion');
  assert.equal(await page.locator('[data-tool-activity]').getAttribute('open'), null);
  await page.locator('summary').click();
  await page.waitForFunction(() => document.querySelector('[data-tool-activity]')?.open);
  const before = await page.locator('summary').innerText();
  await page.waitForTimeout(1200);
  assert.notEqual(await page.locator('summary').innerText(), before, 'clock must advance without output');
  assert.match(await page.locator('[data-tool-activity]').innerText(), /first-live/);
  assert.ok(!(await page.locator('body').innerText()).includes('fixture-private'));
  await page.waitForFunction(() => window.streamDone === true);
  assert.match(await page.locator('[data-tool-activity]').innerText(), /완료.*종료 코드 0/s);
  assert.match(await page.locator('[data-tool-activity]').innerText(), /\[stderr\] stderr-live/);
  assert.match(await page.locator('[data-tool-activity]').innerText(), /last-live/);
  assert.equal(await page.locator('[data-tool-state]').count(), 1, 'snapshots replace, not duplicate');
  await page.locator('summary').click();
  assert.equal(await page.locator('[data-tool-activity]').getAttribute('open'), null);
  console.log('PASS real shell → HTTP SSE → production parser → collapsible UI, live clock, masking, completion');

  const now = Date.now();
  const row = { id: 'fixture', tool: 'run_tests', target: 'x'.repeat(900), state: 'failed', startedAt: now - 5500, updatedAt: now, finishedAt: now, output: 'bounded tail\n' + 'z'.repeat(12000), truncated: true, exitCode: 7 };
  await page.evaluate(row => window.fixture([row]), row);
  await page.locator('summary').click();
  assert.match(await page.locator('[data-tool-activity]').innerText(), /실패.*종료 코드 7/s);
  assert.match(await page.locator('[data-tool-activity]').innerText(), /일부 로그 생략/);
  await page.setViewportSize({ width: 375, height: 700 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no narrow-screen horizontal overflow');
  const frozen = await page.locator('summary').innerText();
  await page.waitForTimeout(1100);
  assert.equal(await page.locator('summary').innerText(), frozen);
  await page.evaluate(row => window.fixture([{ ...row, state: 'cancelled' }]), row);
  await page.waitForFunction(() => document.querySelector('summary')?.textContent.includes('취소'));
  await page.evaluate(row => window.fixture([{ ...row, state: 'running', finishedAt: undefined }]), row);
  await page.waitForFunction(() => document.querySelector('summary')?.textContent.includes('연결 종료 · 완료 상태 미수신'));
  await page.evaluate(() => window.fixture([]));
  await page.waitForFunction(() => !document.querySelector('[data-tool-activity]'));
  assert.deepEqual(errors, []);
  console.log('PASS failure/cancel/disconnect, bounded-log notice, frozen history, empty state, 375px layout');
  console.log('2 browser acceptance groups passed');
} finally {
  abort.abort();
  await shellTask;
  await browser?.close();
  await server.close();
  rmSync(temp, { recursive: true, force: true });
}
