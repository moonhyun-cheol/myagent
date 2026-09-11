#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(root, 'runtime', 'playwright', 'browsers');
const { chromium } = await import('playwright');
const dist = path.join(root, 'ui', 'workspace', 'dist');
assert.ok(existsSync(path.join(dist, 'index.html')), 'workspace dist missing');

const fixtureShelf = {
  schema_version: 1,
  id: 'ops',
  group: 'cqr',
  label: 'CQR 명령어 모음',
  description: '브라우저 자동화 작업 키트',
  pull: ['agent-plugins'],
  plugins: { enable: {} },
  features: { enable: { 'cqr-automaton': { required: true } } },
  hints: { needs_organization_module: false },
  origin: 'locker',
  install_status: 'installed',
};
let applyRequested = false;
let unapplyRequested = false;

function json(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(readFileSync(path.join(dist, 'index.html')));
    return;
  }
  if (url.pathname === '/profiles/unapply' && req.method === 'POST') {
    unapplyRequested = true;
    return json(res, { ok: true, warnings: [] });
  }
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons')) {
    const rel = url.pathname.slice(1);
    const file = path.join(dist, rel);
    if (existsSync(file)) {
      res.writeHead(200, { 'Content-Type': file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'application/javascript' });
      res.end(readFileSync(file));
      return;
    }
  }
  if (url.pathname === '/profiles') return json(res, {
    locker_root: 'fixture', feed_sequence: 12,
    groups: [{ id: 'cqr', label: 'CQR', order: 1, shelves: [fixtureShelf] }],
    applied: applyRequested && !unapplyRequested ? { profile_id: 'cqr/ops', group: 'cqr', kit_id: 'ops', applied_at: new Date().toISOString() } : null,
    applied_kits: applyRequested && !unapplyRequested ? [{ profile_id: 'cqr/ops', group: 'cqr', kit_id: 'ops', applied_at: new Date().toISOString() }] : [],
    can_restore: true,
    organization_features: [{ id: 'cqr-automaton', installed: true, enabled: false, capabilities: [], refs: [] }],
  });
  if (url.pathname === '/profiles/catalog/check') return json(res, { feed_url: null, update_available: false, cached_sequence: 12 });
  if (url.pathname === '/profiles/apply' && req.method === 'POST') {
    applyRequested = true;
    return json(res, { ok: true, enabled_features: ['cqr-automaton'], warnings: [] });
  }
  if (url.pathname === '/health') return json(res, { ok: true, cqr_root: root, version: 'test', ui: 'workspace' });
  if (url.pathname === '/config') return json(res, {});
  if (url.pathname === '/license/status') return json(res, { mode: 'full', features: ['chat', 'manager'] });
  if (url.pathname === '/models') return json(res, { models: [] });
  if (url.pathname === '/providers') return json(res, { providers: [] });
  if (url.pathname === '/sessions') return json(res, { sessions: [] });
  if (url.pathname === '/projects') return json(res, { projects: [] });
  if (url.pathname === '/skills') return json(res, { skills: [] });
  if (url.pathname === '/organization-module') return json(res, { installed: null, can_check_remote: false });
  if (url.pathname === '/organization-features') return json(res, { features: [] });
  return json(res, {});
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByTitle('프로바이더 설정 열기').click();
  await page.getByTestId('settings-nav-work-kits').click();
  await page.getByTestId('work-kit-library').waitFor();
  await page.getByText('CQR 명령어 모음').waitFor();
  await page.getByText('추가 기능 설치됨(꺼짐)').waitFor();
  assert.equal(await page.getByTestId('profile-picker-apply-cqr-ops').isEnabled(), true);
  assert.equal(await page.getByTestId('work-profile-restore').isVisible(), true);
  await page.getByTestId('profile-picker-apply-cqr-ops').click();
  await page.getByRole('alertdialog').getByRole('button', { name: '적용', exact: true }).click();
  await page.getByText(/적용 완료 · 추가 기능 활성 1/).waitFor();
  assert.equal(applyRequested, true);
  await page.getByTestId('profile-picker-unapply-cqr-ops').click();
  await page.getByRole('alertdialog').getByRole('button', { name: '적용 해제', exact: true }).click();
  await page.getByText(/적용 해제 완료/).waitFor();
  assert.equal(unapplyRequested, true);
  console.log('verify-work-kit-settings-ui: Settings → 작업 키트 rendered; apply/unapply completed with Feature feedback');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
