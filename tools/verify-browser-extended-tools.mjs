// Verifies the isolated-only extended browser tools (scroll/wait/press/select/history/find/read_text/console/download)
// end-to-end through executeAgentTool against a local page. Requires `npx tsc -p tsconfig.json` first.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const { PlaywrightSession } = await imp('core/dist/browser/playwright-session.js');
const { executeAgentTool } = await imp('core/dist/agent/tools.js');
const { BROWSER_AGENT_TOOLS } = await imp('core/dist/agent/agent-tool-definitions.js');
const { buildWebAuditFields } = await imp('core/dist/agent/web-action-audit.js');
const { untrustedSourceForTool } = await imp('core/dist/agent/untrusted-content.js');

const NEW_TOOLS = ['browser_scroll', 'browser_wait', 'browser_press_key', 'browser_select', 'browser_history',
  'browser_find', 'browser_read_text', 'browser_console_logs', 'browser_download'];
const names = BROWSER_AGENT_TOOLS.map((t) => t.function.name);
for (const n of NEW_TOOLS) {
  assert.ok(names.includes(n), `${n} defined`);
  assert.equal(untrustedSourceForTool(n), 'web', `${n} untrusted envelope`);
  assert.equal(buildWebAuditFields({ tool: n, args: {}, output: '{}', resolvedBrowserTarget: 'visible' }).target, 'visible');
  assert.equal(buildWebAuditFields({ tool: n, args: { target: 'isolated' }, output: '{}' }).target, 'isolated');
}

const page = `<!doctype html><html><head><meta charset="utf-8"></head><body style="height:4000px">
<h1>수집 테스트</h1>
<select id="sel"><option value="a">A</option><option value="b">Bee</option></select>
<input id="q" /><p id="out"></p>
<table id="t"><tr><th>품목</th><th>가격</th></tr><tr><td>사과</td><td>1200</td></tr></table>
<a id="dl" href="/file.csv" download="data.csv">download</a>
<button id="late" onclick="setTimeout(()=>{const d=document.createElement('div');d.id='loaded';d.textContent='ok';document.body.append(d)},200)">late</button>
<div style="margin-top:3000px" id="far">맨 아래 문구</div>
<script>document.getElementById('q').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('out').textContent='entered'});console.error('lab-console-error');</script>
</body></html>`;
const server = http.createServer((req, res) => {
  if (req.url === '/file.csv') { res.writeHead(200, { 'content-type': 'text/csv' }); res.end('a,b\n1,2\n'); return; }
  if (req.url === '/two') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>two</title><p>two</p>'); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const session = await PlaywrightSession.open({ cqrRoot: root, headless: true, urlGuard: { allowLocalhost: true } });
const ws = mkdtempSync(path.join(tmpdir(), 'bext-'));
const ctx = { cqrRoot: root, sessionId: `verify_bext_${Date.now()}`, allowLocalhost: true, browserSession: session, browserRouting: 'background' };
let i = 0;
const run = async (name, args) => {
  const res = await executeAgentTool(ws, { id: `c${i++}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }, { allowNas: false }, ctx);
  const out = String(res.output ?? '');
  assert.ok(!/^ERROR:/m.test(out), `${name} failed: ${out.slice(0, 300)}`);
  return out;
};
try {
  await run('browser_navigate', { url: base, target: 'isolated' });
  assert.match(await run('browser_read_text', { mode: 'table' }), /사과/);
  assert.match(await run('browser_read_text', { selector: 'h1' }), /수집 테스트/);
  assert.match(await run('browser_select', { selector: '#sel', value: 'b' }), /b/);
  await run('browser_click', { selector: '#q', target: 'isolated' });
  await run('browser_press_key', { key: 'Enter', selector: '#q' });
  assert.match(await run('browser_read_text', { selector: '#out' }), /entered/);
  assert.match(await run('browser_scroll', { direction: 'down', amount: 1000 }), /down/);
  assert.match(await run('browser_find', { text: '맨 아래' }), /"found": true/);
  await run('browser_click', { selector: '#late', target: 'isolated' });
  assert.match(await run('browser_wait', { selector: '#loaded', timeout_ms: 5000 }), /loaded/);
  assert.match(await run('browser_console_logs', { clear: true }), /lab-console-error/);
  const dl = JSON.parse(await run('browser_download', { selector: '#dl' }));
  assert.ok(existsSync(dl.path) && readFileSync(dl.path, 'utf8').includes('1,2'), 'download saved');
  await run('browser_navigate', { url: `${base}/two`, target: 'isolated' });
  assert.match(await run('browser_history', { action: 'back' }), /127\.0\.0\.1/);
  const vis = await executeAgentTool(ws, { id: 'v', type: 'function', function: { name: 'browser_scroll', arguments: '{"target":"visible","direction":"down"}' } }, { allowNas: false }, ctx);
  // Visible route exists; a background run must never drive the user's browser (fail closed, no silent fallback).
  assert.match(String(vis.output), /BACKGROUND_VISIBLE_BROWSER_FORBIDDEN/);
  console.log(`OK verify-browser-extended-tools (${NEW_TOOLS.length} tools)`);
} finally {
  await session.close();
  server.close();
}
