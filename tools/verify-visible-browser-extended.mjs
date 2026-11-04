// Visible (user WebView2) route for the extended browser tools.
// 1) static: the shell dispatches every action and only accepts agent-armed downloads
// 2) core -> fake shell pipe: each tool sends the right action/payload under the session lease
// 3) the shell's fixed page scripts (C# raw strings) behave correctly in real Chromium
// Requires `npx tsc -p tsconfig.json` first.
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const read = (p) => readFileSync(path.join(root, p), 'utf8');

// 1. static shell contract
const automation = read('shell/CqrPa.Shell/MainWindow.VisibleBrowserAutomation.cs');
const extended = read('shell/CqrPa.Shell/MainWindow.VisibleBrowserExtended.cs');
const tabs = read('shell/CqrPa.Shell/MainWindow.BrowserTabs.cs');
const ACTIONS = {
  scroll: 'AutomateBrowserScrollAsync', wait: 'AutomateBrowserWaitAsync', press_key: 'AutomateBrowserPressKeyAsync',
  select: 'AutomateBrowserSelectAsync', history: 'AutomateBrowserHistoryAsync', find: 'AutomateBrowserFindAsync',
  read_text: 'AutomateBrowserReadTextAsync', console_logs: 'BrowserConsoleLogs', download: 'AutomateBrowserDownloadAsync',
};
for (const [action, method] of Object.entries(ACTIONS)) {
  assert.match(automation, new RegExp(`"${action}" => (await )?${method}\\(`), `shell routes ${action}`);
  assert.match(extended, new RegExp(`${method}\\(JsonElement payload`), `${method} implemented`);
}
assert.match(tabs, /TryAcceptAutomationDownload\(owner, e\)\) return;\s*e\.Cancel = true;/, 'only agent-armed downloads pass; others stay blocked');
assert.match(tabs, /AttachBrowserDiagnostics\(tab, core\)/, 'diagnostics attached per tab');
assert.match(extended, /RequireVisibleBrowser\(RequireAutomationControl\(/, 'extended actions honor takeover/lease');
assert.match(extended, /"downloads"/, 'shell validates the download folder');
assert.doesNotMatch(extended, /PayloadString\(payload, "expression"\)/, 'no agent-supplied script on the visible browser');

// 2. core -> fake shell routing
const { startVisibleBrowserBridge } = await imp('core/dist/browser/visible-browser-bridge.js');
const { executeAgentTool } = await imp('core/dist/agent/agent-tool-execute.js');
const port = 31_000 + (process.pid % 19_000);
const bridge = startVisibleBrowserBridge(port);
const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\my-agent-visible-browser-${port}` : `/tmp/my-agent-visible-browser-${port}.sock`;
let shell;
for (let a = 0; a < 40 && !shell; a += 1) {
  try {
    shell = await new Promise((res, rej) => { const s = net.createConnection(pipe, () => res(s)); s.once('error', rej); });
  } catch { await new Promise((r) => setTimeout(r, 25)); }
}
assert.ok(shell, 'fake shell connected');
const seen = [];
let buf = '';
shell.setEncoding('utf8');
shell.on('data', (chunk) => {
  buf += chunk;
  for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const cmd = JSON.parse(line);
    if (cmd.type !== 'command') continue;
    seen.push({ action: cmd.action, payload: cmd.payload ?? {} });
    shell.write(`${JSON.stringify({ type: 'result', id: cmd.id, ok: true, result: { action: cmd.action, url: 'https://example.org/list' } })}\n`);
  }
});
for (let a = 0; a < 40 && !bridge.isConnected(); a += 1) await new Promise((r) => setTimeout(r, 10));
assert.equal(bridge.isConnected(), true);

const ctx = { cqrRoot: root, sessionId: 'vis_ext_session', browserRouting: 'interactive' };
const call = async (name, args) => {
  const res = await executeAgentTool(root, { id: `c-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }, { allowNas: false }, ctx);
  const out = String(res.output ?? '');
  assert.ok(!/ERROR:/.test(out), `${name}: ${out.slice(0, 300)}`);
  return seen.at(-1);
};
const cases = [
  ['browser_scroll', { direction: 'to-element', snapshot_id: 's1', ref: 'e3' }, 'scroll', { direction: 'to-element', snapshot_id: 's1', ref: 'e3' }],
  ['browser_wait', { selector: '#list', timeout_ms: 4000 }, 'wait', { selector: '#list', timeout_ms: 4000 }],
  ['browser_press_key', { key: 'Control+A', selector: '#q' }, 'press_key', { key: 'Control+A', selector: '#q' }],
  ['browser_select', { snapshot_id: 's1', ref: 'e9', value: 'b' }, 'select', { value: 'b', ref: 'e9' }],
  ['browser_history', { action: 'back', tab_id: 'tab-2' }, 'history', { action: 'back', tab_id: 'tab-2' }],
  ['browser_find', { text: '다음' }, 'find', { text: '다음' }],
  ['browser_read_text', { mode: 'table', selector: 'table' }, 'read_text', { mode: 'table', selector: 'table' }],
  ['browser_console_logs', { clear: true }, 'console_logs', { clear: true }],
  ['browser_download', { selector: '#dl' }, 'download', { selector: '#dl' }],
];
for (const [tool, args, action, expected] of cases) {
  const before = seen.length;
  const last = await call(tool, args);
  assert.equal(last.action, action, `${tool} -> ${action}`);
  for (const [k, v] of Object.entries(expected)) assert.deepEqual(last.payload[k], v, `${tool} payload.${k}`);
  assert.equal(seen[before]?.action, 'tab.control.acquire', `${tool} acquires control first`);
}
const dl = seen.findLast((s) => s.action === 'download');
assert.equal(dl.payload.download_dir, path.join(root, 'data', 'outputs', 'browser', 'vis_ext_session', 'downloads'));
assert.ok(!('amount' in seen.find((s) => s.action === 'scroll').payload), 'absent args are not forwarded');
const count = seen.length;
await executeAgentTool(root, { id: 'iso', type: 'function', function: { name: 'browser_find', arguments: '{"target":"isolated","text":"x"}' } }, { allowNas: false }, ctx);
assert.equal(seen.length, count, 'target=isolated bypasses the shell');
shell.destroy();
bridge.stop();

// 3. shell page scripts in real Chromium
/** C# raw string literals with the closing-line indentation removed. */
const rawStrings = [...extended.matchAll(/"""\r?\n([\s\S]*?)\r?\n([ \t]*)"""/g)].map(([, body, indent]) =>
  body.split(/\r?\n/).map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n'));
const pick = (needle) => { const s = rawStrings.find((x) => x.includes(needle)); assert.ok(s, `script ${needle}`); return s; };
const findFn = pick('createTreeWalker');
const waitFn = pick("a.state==='attached'");
const selectFn = pick('HTMLSelectElement');
const extractFn = pick("a.mode==='table'");

const { importPlaywright } = await imp('core/dist/browser/playwright-probe.js');
const { chromium } = await importPlaywright(root);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent(`<body style="height:3000px"><h1>목록</h1>
    <select id="sel"><option value="a">A</option><option value="b">Bee</option></select>
    <table id="t"><tr><th>품목</th><th>가격</th></tr><tr><td>사과</td><td> 1,200 </td></tr></table>
    <div id="hid" style="display:none">숨김</div><p style="margin-top:2500px">다음 페이지</p></body>`);
  const evalFn = (fn, arg, selector) => page.evaluate(([src, a, sel]) => {
    const f = new Function(`return (${src})`)();
    return f.call(sel ? document.querySelector(sel) : document.body, a);
  }, [fn, arg, selector ?? null]);

  const found = await evalFn(findFn, { text: '다음 페이지' });
  assert.equal(found.found, true); assert.match(found.excerpt, /다음 페이지/);
  assert.equal((await page.$$(found.selector)).length, 1, 'find returns a reusable selector');
  assert.ok(await page.evaluate(() => window.scrollY > 1000), 'find scrolls to the hit');
  assert.equal((await evalFn(findFn, { text: '없는문구' })).found, false);

  assert.equal(await evalFn(waitFn, { s: '#t', state: 'visible' }), true);
  assert.equal(await evalFn(waitFn, { s: '#hid', state: 'visible' }), false);
  assert.equal(await evalFn(waitFn, { s: '#hid', state: 'hidden' }), true);
  assert.equal(await evalFn(waitFn, { s: '#nope', state: 'detached' }), true);

  assert.deepEqual(await evalFn(selectFn, 'Bee', '#sel'), { value: 'b', label: 'Bee' });
  assert.equal(await page.$eval('#sel', (s) => s.value), 'b');
  await assert.rejects(evalFn(selectFn, 'zzz', '#sel'), /BROWSER_OPTION_NOT_FOUND/);

  const table = await evalFn(extractFn, { mode: 'table', max: 12000 });
  assert.deepEqual(JSON.parse(table.content), [{ table: 1, cells: ['품목', '가격'] }, { table: 1, cells: ['사과', '1,200'] }]);
  const scoped = await evalFn(extractFn, { mode: 'text', max: 12000 }, 'h1');
  assert.equal(scoped.content, '목록');
  const clipped = await evalFn(extractFn, { mode: 'text', max: 3 });
  assert.equal(clipped.truncated, true); assert.equal(clipped.content.length, 3);
} finally {
  await browser.close();
}
console.log('OK verify-visible-browser-extended (static + pipe routing + page scripts)');
