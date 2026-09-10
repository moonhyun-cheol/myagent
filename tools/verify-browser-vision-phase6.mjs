import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BROWSER_VISION_TIER2_ACTIONS,
  BROWSER_VISION_TIER3_ACTIONS,
  parseBrowserVisionAction,
} from '../core/dist/browser/browser-vision-agent.js';
import { isPlaywrightAvailable } from '../core/dist/browser/playwright-probe.js';
import { PlaywrightSession } from '../core/dist/browser/playwright-session.js';
import { needsHumanApproval } from '../core/dist/agent/tool-approval.js';

for (const action of ['wait_for', 'select', 'key', 'go_back', 'forward', 'reload', 'upload_file']) {
  assert.ok(BROWSER_VISION_TIER2_ACTIONS.includes(action), `missing Tier 2 action ${action}`);
}
for (const action of ['get_console_logs', 'eval_js', 'download', 'take_over']) {
  assert.ok(BROWSER_VISION_TIER3_ACTIONS.includes(action), `missing Tier 3 action ${action}`);
}
assert.deepEqual(parseBrowserVisionAction('{"action":"wait_for","selector":"#ready","state":"visible"}'), {
  action: 'wait_for', selector: '#ready', state: 'visible',
});
const approval = needsHumanApproval('browser_evaluate', { expression: 'document.title' });
assert.equal(approval.needed, true);
assert.equal(approval.expires, 'once');

const shellSource = readFileSync(new URL('../shell/CqrPa.Shell/MainWindow.BrowserTabs.cs', import.meta.url), 'utf8');
assert.match(shellSource, /AreDevToolsEnabled = true/);
assert.match(shellSource, /Key\.F12/);
assert.match(shellSource, /AutomationOwner is not null/);
const bridgeSource = readFileSync(new URL('../ui/workspace/src/lib/inAppBrowserBridge.ts', import.meta.url), 'utf8');
assert.match(bridgeSource, /inAppBrowser\.devtools/);

const cqrRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (isPlaywrightAvailable(cqrRoot)) {
  const server = createServer((req, res) => {
    if (req.url === '/download') {
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': 'attachment; filename="phase6.txt"',
      });
      res.end('phase6 download');
      return;
    }
    if (req.url === '/missing') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('broken');
      return;
    }
    if (req.url === '/second') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Second</title><h1 id="second">Second page</h1>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><title>Phase 6</title></head><body>
      <select id="choice"><option value="a">A</option><option value="b">B</option></select>
      <input id="keys" value="abc"><input id="upload" type="file">
      <a id="next" href="/second">Next</a><a id="download" href="/download">Download</a>
      <script>console.error('phase6-console'); fetch('/missing');</script>
    </body></html>`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const session = await PlaywrightSession.open({
    cqrRoot,
    headless: true,
    urlGuard: { allowLocalhost: true },
  });
  let downloadedPath = '';
  try {
    await session.navigate(`${base}/`);
    await session.waitFor({ selector: '#choice', state: 'visible', timeoutMs: 2_000 });
    await session.select('#choice', 'b');
    assert.equal(await session.evaluate("document.querySelector('#choice').value"), 'b');
    await session.pressKey('End', '#keys');
    await session.uploadFile('#upload', path.join(cqrRoot, 'package.json'));
    assert.match(await session.evaluate("document.querySelector('#upload').files[0].name"), /package\.json/);
    await session.navigate(`${base}/second`);
    assert.match((await session.history('back')).url, /127\.0\.0\.1/);
    assert.match((await session.history('forward')).url, /\/second$/);
    assert.equal((await session.history('reload')).title, 'Second');
    await session.navigate(`${base}/`);
    const downloaded = await session.download('#download', 'phase6-test');
    downloadedPath = downloaded.path;
    assert.equal(readFileSync(downloaded.path, 'utf8'), 'phase6 download');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const logs = session.getConsoleLogs();
    assert.ok(logs.some((entry) => entry.kind === 'console' && entry.text.includes('phase6-console')), JSON.stringify(logs));
    assert.ok(logs.some((entry) => entry.kind === 'http' && entry.level === '500'), JSON.stringify(logs));
    assert.ok((await session.handoffState())?.url.startsWith(base));
  } finally {
    await session.close();
    if (downloadedPath) {
      try { unlinkSync(downloadedPath); } catch { /* best effort */ }
    }
    await new Promise((resolve) => server.close(resolve));
  }
  console.log('verify-browser-vision-phase6: runtime ok');
} else {
  console.log('verify-browser-vision-phase6: runtime skipped (Playwright unavailable)');
}

console.log('verify-browser-vision-phase6: ok');
