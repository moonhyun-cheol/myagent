/**
 * verify-browser-url-guard — 4번: 브라우저 주소 차단 강화.
 * 1) 순수 판정: 사설/링크로컬/미지정 주소, 사용자 차단 목록, DNS 해석 검사, visible 결과 차단
 * 2) 실제 격리 Chromium: 직접 이동·리다이렉트·링크 클릭·스크립트 이동·하위 리소스 차단
 * 3) 크롤링 링크 / save_web_asset 리다이렉트 차단
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, unlinkSync, utimesSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertAllowedBrowserUrl,
  assertBrowserUrlResolvesAllowed,
  browserUrlBlockReason,
  configureBrowserUrlBlocklistFile,
  parseBrowserBlockEntry,
  visibleBlockedOutput,
} from '../core/dist/browser/url-guard.js';
import { PlaywrightSession } from '../core/dist/browser/playwright-session.js';
import { isPlaywrightAvailable } from '../core/dist/browser/playwright-probe.js';
import { runWebCrawl } from '../core/dist/browser/web-crawl-service.js';
import { saveWebAsset } from '../core/dist/sessions/save-web-asset.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok  - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL - ${name}\n${error?.stack ?? error}`);
  }
}
const blocked = (url, opts) => browserUrlBlockReason(url, opts) !== null;
delete process.env.MY_AGENT_BROWSER_BLOCKED_URLS;

await check('strict private-host check without allowLocalhost', () => {
  for (const u of [
    'http://localhost/', 'http://127.0.0.2/', 'http://0.0.0.0/', 'http://169.254.169.254/latest',
    'http://100.64.1.1/', 'http://10.1.2.3/', 'http://192.168.0.1/', 'http://172.20.0.1/',
    'http://[::1]/', 'http://[fd00::1]/', 'http://[fe80::1]/', 'http://printer.local/', 'http://db.internal/',
    'http://2130706433/', 'http://0x7f.1/', 'http://[::ffff:127.0.0.1]/',
  ]) assert.equal(blocked(u), true, u);
  assert.equal(blocked('https://www.naver.com/'), false);
  assert.equal(blocked('file:///C:/x'), true);
});

await check('allowLocalhost keeps link-local / unspecified / multicast blocked', () => {
  const o = { allowLocalhost: true };
  for (const u of ['http://localhost:5173/', 'http://127.0.0.2/', 'http://192.168.1.10:8080/', 'http://[::1]:3000/'])
    assert.equal(blocked(u, o), false, u);
  for (const u of ['http://169.254.169.254/', 'http://0.0.0.0:3000/', 'http://[fe80::1]/', 'http://239.1.1.1/', 'http://[::]/'])
    assert.equal(blocked(u, o), true, u);
});

await check('user blocklist entry parsing and matching', () => {
  const e = parseBrowserBlockEntry('https://mkoutdoor.co.kr:25000/admin/*');
  assert.deepEqual({ host: e.host, port: e.port, pathPrefix: e.pathPrefix }, { host: 'mkoutdoor.co.kr', port: '25000', pathPrefix: '/admin/' });
  const opts = { blockedUrls: ['mkoutdoor.co.kr:25000/admin', '*.blocked.example', 'exact.example:8443'] };
  assert.match(browserUrlBlockReason('http://mkoutdoor.co.kr:25000/admin/loozVari6.jsp', opts), /BLOCKED_BY_USER_POLICY/);
  assert.equal(blocked('http://www.mkoutdoor.co.kr:25000/ADMIN/x', opts), true, 'subdomain + case');
  assert.equal(blocked('http://mkoutdoor.co.kr:25000/%61dmin/x', opts), true, 'percent-encoded path');
  assert.equal(blocked('http://mkoutdoor.co.kr:25000/shop', opts), false, 'other path');
  assert.equal(blocked('http://mkoutdoor.co.kr/admin', opts), false, 'other port');
  assert.equal(blocked('https://a.b.blocked.example/', opts), true);
  assert.equal(blocked('https://exact.example:8443/x', opts), true);
  assert.equal(blocked('https://exact.example/x', opts), false);
  assert.equal(blocked('https://notblocked.example/', opts), false, 'suffix without dot');
  assert.equal(parseBrowserBlockEntry('# comment'), null);
  assert.equal(parseBrowserBlockEntry(''), null);
});

const tmp = mkdtempSync(path.join(os.tmpdir(), 'url-guard-'));
await check('blocklist from user-overrides.json reloads on change + env entries', () => {
  const cfg = path.join(tmp, 'user-overrides.json');
  writeFileSync(cfg, JSON.stringify({ browser_blocked_urls: ['first.example'] }));
  configureBrowserUrlBlocklistFile(cfg);
  assert.equal(blocked('https://first.example/'), true);
  assert.equal(blocked('https://second.example/'), false);
  writeFileSync(cfg, JSON.stringify({ browser_blocked_urls: ['second.example', 'more.example'] }));
  const later = new Date(Date.now() + 5000);
  utimesSync(cfg, later, later);
  assert.equal(blocked('https://first.example/'), false);
  assert.equal(blocked('https://second.example/'), true);
  process.env.MY_AGENT_BROWSER_BLOCKED_URLS = 'env.example, other-env.example';
  assert.equal(blocked('https://other-env.example/'), true);
  delete process.env.MY_AGENT_BROWSER_BLOCKED_URLS;
  configureBrowserUrlBlocklistFile(null);
  assert.equal(blocked('https://second.example/'), false);
});

await check('DNS resolution check refuses names that resolve to private space', async () => {
  const fake = (map) => async (host) => (map[host] ?? []).map((address) => ({ address }));
  const resolver = fake({ 'rebind.example': ['127.0.0.1'], 'meta.example': ['169.254.169.254'], 'ok.example': ['93.184.216.34'] });
  await assert.rejects(assertBrowserUrlResolvesAllowed('http://rebind.example/', {}, resolver), /resolves to 127\.0\.0\.1/);
  await assert.rejects(assertBrowserUrlResolvesAllowed('http://meta.example/', { allowLocalhost: true }, resolver), /169\.254/);
  await assertBrowserUrlResolvesAllowed('http://rebind.example/', { allowLocalhost: true }, resolver);
  await assertBrowserUrlResolvesAllowed('http://ok.example/', {}, resolver);
  await assertBrowserUrlResolvesAllowed('http://nx.example/', {}, async () => { throw new Error('ENOTFOUND'); });
  assert.throws(() => assertAllowedBrowserUrl('http://10.0.0.1/'), /BLOCKED_HOST/);
});

await check('visible results on blocked pages withhold content', () => {
  process.env.MY_AGENT_BROWSER_BLOCKED_URLS = 'secret.example';
  const out = visibleBlockedOutput({ url: 'https://secret.example/admin', tree: 'TOP SECRET' }, true);
  assert.match(out, /^ERROR: BLOCKED_PAGE/);
  assert.doesNotMatch(out, /TOP SECRET/);
  assert.match(visibleBlockedOutput({ page_url: 'http://169.254.169.254/' }, true), /BLOCKED_PAGE/);
  assert.equal(visibleBlockedOutput({ url: 'https://www.naver.com/' }, true), null);
  assert.equal(visibleBlockedOutput({ url: 'about:blank' }, false), null);
  delete process.env.MY_AGENT_BROWSER_BLOCKED_URLS;
});

// ── Real Chromium ───────────────────────────────────────────────────────────────
const hitsB = [];
const serverB = createServer((req, res) => {
  hitsB.push(req.url);
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<title>B</title><p>SECRET-B</p>');
});
await new Promise((r) => serverB.listen(0, '127.0.0.1', r));
const pB = serverB.address().port;
const B = `http://127.0.0.1:${pB}`;
const serverA = createServer((req, res) => {
  const html = (body) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(body); };
  if (req.url === '/redirect' || req.url === '/asset-redirect') { res.writeHead(302, { location: `${B}/landed` }); res.end(); return; }
  if (req.url === '/link') return html(`<title>A</title><a id="go" href="${B}/clicked">go</a><a href="/page2">p2</a>`);
  if (req.url === '/script') return html(`<title>A</title><script>setTimeout(()=>{location.href='${B}/scripted'},50)</script>`);
  if (req.url === '/img') return html(`<title>A</title><img src="${B}/pixel.png"><p>img page</p>`);
  if (req.url === '/crawl') return html(`<title>A</title><a href="${B}/c1">b</a><a href="/page2">p2</a>`);
  if (req.url === '/page2') return html('<title>P2</title><p>page two</p>');
  if (req.url === '/asset') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('asset-ok'); return; }
  html('<title>A</title><p>home</p>');
});
await new Promise((r) => serverA.listen(0, '127.0.0.1', r));
const A = `http://localhost:${serverA.address().port}`;
// Blocklist only B (A is localhost:<pA>, B is 127.0.0.1:<pB>).
process.env.MY_AGENT_BROWSER_BLOCKED_URLS = `127.0.0.1:${pB}`;

const app = mkdtempSync(path.join(os.tmpdir(), 'url-guard-app-'));
symlinkSync(path.join(root, 'node_modules'), path.join(app, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
symlinkSync(path.join(root, 'runtime'), path.join(app, 'runtime'), process.platform === 'win32' ? 'junction' : 'dir');

if (!isPlaywrightAvailable(app)) {
  console.log('skip - Playwright runtime not available');
} else {
  const browser = new PlaywrightSession(app, { headless: true, urlGuard: { allowLocalhost: true } });
  try {
    await check('direct navigate to blocklisted host refused before any request', async () => {
      hitsB.length = 0;
      await assert.rejects(browser.navigate(`${B}/direct`), /BLOCKED_BY_USER_POLICY/);
      assert.equal(hitsB.length, 0);
    });
    await check('redirect to blocklisted host: navigation refused, content not returned', async () => {
      hitsB.length = 0;
      await assert.rejects(browser.navigate(`${A}/redirect`), /BLOCKED/);
      const snap = await browser.snapshot().catch((e) => ({ url: 'error', tree: String(e) }));
      assert.doesNotMatch(JSON.stringify(snap), /SECRET-B/);
      console.log(`      (redirect hop reached B server: ${hitsB.length ? 'yes' : 'no'})`);
    });
    await check('link click to blocklisted host is aborted (no request to B)', async () => {
      await browser.navigate(`${A}/link`);
      hitsB.length = 0;
      await browser.click('#go');
      await new Promise((r) => setTimeout(r, 400));
      const snap = await browser.snapshot();
      assert.equal(hitsB.length, 0, `B hits: ${hitsB}`);
      assert.doesNotMatch(snap.url, new RegExp(String(pB)));
    });
    await check('script location change to blocklisted host is aborted', async () => {
      hitsB.length = 0;
      await browser.navigate(`${A}/script`);
      await new Promise((r) => setTimeout(r, 500));
      const text = await browser.readText().catch((e) => String(e));
      assert.doesNotMatch(text, /SECRET-B/);
      assert.equal(hitsB.length, 0, `B hits: ${hitsB}`);
    });
    await check('sub-resource to blocklisted host is aborted', async () => {
      hitsB.length = 0;
      const nav = await browser.navigate(`${A}/img`);
      await new Promise((r) => setTimeout(r, 300));
      assert.match(nav.excerpt, /img page/);
      assert.equal(hitsB.length, 0, `B hits: ${hitsB}`);
    });
    await check('normal localhost navigation still works', async () => {
      const nav = await browser.navigate(`${A}/page2`);
      assert.match(nav.excerpt, /page two/);
    });
  } finally {
    await browser.close();
  }

  await check('crawl skips links and redirects into blocklisted hosts', async () => {
    hitsB.length = 0;
    const result = await runWebCrawl({ cqrRoot: app, sessionId: 'urlguard', startUrl: `${A}/crawl`, maxPages: 5, allowLocalhost: true });
    assert.equal(result.ok, true, result.error);
    assert.ok(result.pages.some((p) => p.url.endsWith('/page2')));
    assert.ok(!result.pages.some((p) => p.url.includes(String(pB))));
    assert.equal(hitsB.length, 0, `B hits: ${hitsB}`);
  });
}

await check('save_web_asset re-checks every redirect hop', async () => {
  hitsB.length = 0;
  const ok = await saveWebAsset({ cqrRoot: app, sessionId: 'urlguard', sourceUrl: `${A}/asset`, allowLocalhost: true });
  assert.equal(ok.ok, true, ok.error);
  const r = await saveWebAsset({ cqrRoot: app, sessionId: 'urlguard', sourceUrl: `${A}/asset-redirect`, allowLocalhost: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /BLOCKED_BY_USER_POLICY/);
  assert.equal(hitsB.length, 0);
  const r2 = await saveWebAsset({ cqrRoot: app, sessionId: 'urlguard', sourceUrl: `${A}/asset`, allowLocalhost: false });
  assert.match(r2.error, /BLOCKED_HOST/);
});

delete process.env.MY_AGENT_BROWSER_BLOCKED_URLS;
serverA.closeAllConnections?.();
serverB.closeAllConnections?.();
await new Promise((r) => serverA.close(r));
await new Promise((r) => serverB.close(r));
rmSync(tmp, { recursive: true, force: true });
// Remove the junctions themselves first so cleanup can never descend into the repo runtime.
for (const link of ['node_modules', 'runtime']) unlinkSync(path.join(app, link));
rmSync(app, { recursive: true, force: true });
if (failures) {
  console.error(`verify-browser-url-guard: ${failures} failure(s)`);
  process.exit(1);
}
console.log('verify-browser-url-guard: OK');
