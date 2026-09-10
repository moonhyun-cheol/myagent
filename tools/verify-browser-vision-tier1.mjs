import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER_VISION_TIER1_ACTIONS, parseBrowserVisionAction } from '../core/dist/browser/browser-vision-agent.js';
import { isPlaywrightAvailable } from '../core/dist/browser/playwright-probe.js';
import { PlaywrightSession } from '../core/dist/browser/playwright-session.js';

const expected = ['find_in_page', 'scroll', 'read_text', 'extract', 'snapshot'];
for (const action of expected) assert.ok(BROWSER_VISION_TIER1_ACTIONS.includes(action), `missing ${action}`);

assert.deepEqual(
  parseBrowserVisionAction('{"action":"scroll","direction":"to-text","text":"가격"}'),
  { action: 'scroll', direction: 'to-text', text: '가격' },
);
assert.deepEqual(
  parseBrowserVisionAction('next: {"action":"click","snapshot_id":"isolated-1","ref":"e2"}'),
  { action: 'click', snapshot_id: 'isolated-1', ref: 'e2' },
);
assert.deepEqual(parseBrowserVisionAction('{"action":"eval_js","expression":"document.title"}'), {
  action: 'eval_js', expression: 'document.title',
});

const sessionSource = readFileSync(new URL('../core/src/browser/playwright-session.ts', import.meta.url), 'utf8');
for (const method of ['findInPage(', 'scroll(', 'readText(', 'snapshot(', 'clickRef(']) {
  assert.ok(sessionSource.includes(method), `PlaywrightSession missing ${method}`);
}
assert.match(sessionSource, /TIER1_TEXT_MAX\s*=\s*12_000/);
assert.match(sessionSource, /SNAPSHOT_NODE_MAX\s*=\s*160/);

const cqrRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (isPlaywrightAvailable(cqrRoot)) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body>
      <h1>Tier 1 fixture</h1>
      <div style="height:1600px"></div>
      <button id="target" aria-label="실행 버튼" onclick="document.body.dataset.clicked='yes'">화면 밖 실행</button>
      <table id="prices"><tr><th>상품</th><th>가격</th></tr><tr><td>A</td><td>100</td></tr></table>
    </body></html>`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const session = await PlaywrightSession.open({
    cqrRoot,
    headless: true,
    urlGuard: { allowLocalhost: true },
  });
  try {
    await session.navigate(`http://127.0.0.1:${address.port}/`);
    const found = await session.findInPage('화면 밖 실행');
    assert.equal(found.found, true);
    assert.equal(found.selector, '#target');
    await session.scroll({ direction: 'to-text', text: '화면 밖 실행' });
    const snapshot = await session.snapshot();
    const buttonLine = snapshot.tree.split('\n').find((line) => line.includes('실행 버튼'));
    assert.ok(buttonLine, snapshot.tree);
    const ref = buttonLine.match(/\[ref=(e\d+)\]/)?.[1];
    assert.ok(ref);
    await session.clickRef(ref, snapshot.snapshot_id);
    assert.equal(await session.evaluate('document.body.dataset.clicked'), 'yes');
    const table = JSON.parse(await session.readText('#prices', 'table'));
    assert.deepEqual(table[1].cells, ['A', '100']);
  } finally {
    await session.close();
    await new Promise((resolve) => server.close(resolve));
  }
  console.log('verify-browser-vision-tier1: runtime ok');
} else {
  console.log('verify-browser-vision-tier1: runtime skipped (Playwright unavailable)');
}

console.log('verify-browser-vision-tier1: ok');
