import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { UserMemoryStore } from '../core/dist/memory/user-memory-store.js';

const root = fileURLToPath(new URL('../ui/workspace/', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
const { default: react } = await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href);
const { default: tailwind } = await import(pathToFileURL(require.resolve('@tailwindcss/vite')).href);
const dir = mkdtempSync(path.join(os.tmpdir(), 'memory-ui-'));
const store = new UserMemoryStore(dir);
for (let i = 0; i < 65; i++) store.add({ scope: 'global', text: `기억 ${String(i).padStart(2, '0')}` });
store.add({ scope: 'session', session_id: 'chat-a', text: '챗 전용 기억' });
const server = await createServer({ root, configFile: false, plugins: [react(), tailwind(), {
  name: 'isolated-memory-test',
  resolveId(id) { if (id === '/__memory-entry.jsx') return path.join(root, '__memory-entry.jsx').replaceAll('\\', '/'); },
  load(id) { if (id === path.join(root, '__memory-entry.jsx').replaceAll('\\', '/')) return `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {UserMemoryPanelHost, openUserMemoryPanel} from '/src/components/UserMemoryPanel.tsx';
    import {ConfirmModal} from '/src/components/ConfirmModal.tsx';
    import '/src/index.css';
    window.openMemory = openUserMemoryPanel;
    createRoot(document.getElementById('root')).render(<><UserMemoryPanelHost/><ConfirmModal/></>);
  `; },
  configureServer(server) {
    server.middlewares.use('/__memory-test', async (_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(await server.transformIndexHtml('/__memory-test', '<html><body><div id="root"></div><script type="module" src="/__memory-entry.jsx"></script></body></html>'));
    });
  },
}], server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let failRead = false, failWrite = false, delayRead = 0;
  await page.route('**/memory{,/**,?*}', async (route) => {
    const req = route.request(); const url = new URL(req.url());
    try {
      if (req.method() === 'GET') {
        const data = store.list(url.searchParams.get('project_id'), url.searchParams.get('session_id'));
        const delay = delayRead; delayRead = 0;
        if (delay) await new Promise((r) => setTimeout(r, delay));
        if (failRead) return await route.fulfill({ status: 500, json: { message: '목록 테스트 오류' } });
        return await route.fulfill({ json: data });
      }
      if (failWrite) return await route.fulfill({ status: 500, json: { message: '저장 테스트 오류' } });
      const body = req.postDataJSON();
      if (url.pathname === '/memory/batch') return await route.fulfill({ json: { changed: store.batch(body) } });
      if (req.method() === 'PUT') return await route.fulfill({ json: store.update(decodeURIComponent(url.pathname.split('/').pop()), body) });
      return await route.fulfill({ status: 201, json: store.add(body) });
    } catch (e) { await route.fulfill({ status: 400, json: { message: e.message } }); }
  });
  await page.goto(`http://127.0.0.1:${port}/__memory-test`);
  await page.waitForFunction(() => !!window.openMemory);
  const open = (sessionId = 'chat-a') => page.evaluate((sessionId) => window.openMemory({ sessionId, projectId: 'project-a', title: '테스트' }), sessionId);
  await open();
  const dialog = page.getByRole('dialog', { name: '메모리 관리', exact: true });
  const expectText = async (text) => { await dialog.getByText(text, { exact: true }).waitFor(); };
  await expectText('66개 검색됨');
  assert.equal(await dialog.getByRole('listitem').count(), 30);
  await dialog.getByRole('button', { name: '다음', exact: true }).click();
  await expectText('2 / 3');
  await dialog.getByRole('searchbox').fill('기억 01');
  await expectText('1개 검색됨');
  await dialog.getByRole('listitem').getByRole('button').click();
  await dialog.getByLabel('메모리 본문').fill('수정된 기억');
  await dialog.getByRole('searchbox').focus();
  assert.ok(store.list().global.some((e) => e.text === '기억 01'), 'blur must not save');
  failWrite = true;
  await dialog.getByRole('button', { name: '저장', exact: true }).click();
  await expectText('저장 테스트 오류');
  assert.equal(await dialog.getByLabel('메모리 본문').inputValue(), '수정된 기억');
  failWrite = false;
  await dialog.getByRole('button', { name: '저장', exact: true }).click();
  await expectText('메모리를 저장했습니다.');
  await expectText('0개 검색됨');
  await dialog.getByRole('searchbox').fill('수정된 기억');
  await expectText('1개 검색됨');
  await dialog.getByLabel('현재 페이지 전체 선택').check();
  await dialog.getByRole('button', { name: '비활성화', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '적용', exact: true }).click();
  await expectText('1개 메모리에 적용했습니다.');
  assert.equal(store.list().global.find((e) => e.text === '수정된 기억').enabled, false);
  await dialog.getByLabel('현재 페이지 전체 선택').check();
  await dialog.getByLabel('이동할 저장 위치').selectOption('project');
  await dialog.getByRole('button', { name: '범위 이동', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '적용', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="메모리 목록"]')?.textContent.includes('프로젝트 / 작업폴더'));
  assert.equal(store.list('project-a').project[0].enabled, false);
  await dialog.getByLabel('현재 페이지 전체 선택').check();
  await dialog.getByRole('button', { name: '삭제', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '취소', exact: true }).click();
  assert.equal(store.list('project-a').project.length, 1);
  await dialog.getByRole('button', { name: '삭제', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '적용', exact: true }).click();
  await expectText('0개 검색됨');
  assert.equal(store.list('project-a').project.length, 0);
  await dialog.getByRole('button', { name: '추가', exact: true }).click();
  await dialog.getByLabel('추가 저장 위치').selectOption('global');
  await dialog.getByLabel('메모리 본문').fill('기억 02');
  await expectText('같은 범위에 동일한 내용이 있습니다. 기존 항목을 확인하세요.');
  assert.equal(await dialog.getByRole('button', { name: '저장', exact: true }).isDisabled(), true);
  await dialog.getByLabel('메모리 본문').fill('새 기억');
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '취소', exact: true }).click();
  assert.equal(await dialog.getByLabel('메모리 본문').inputValue(), '새 기억');
  await dialog.getByRole('button', { name: '저장', exact: true }).click();
  await expectText('메모리를 저장했습니다.');
  await dialog.getByRole('searchbox').fill('');
  await dialog.getByLabel('활성 상태 필터').selectOption('disabled');
  await expectText('0개 검색됨');
  await dialog.getByLabel('활성 상태 필터').selectOption('all');
  await dialog.getByLabel('등록 방식 필터').selectOption('auto');
  await expectText('0개 검색됨');
  await dialog.getByLabel('등록 방식 필터').selectOption('all');
  await dialog.getByLabel('메모리 정렬').selectOption('text');
  await expectText('66개 검색됨');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'mobile modal must not overflow');
  await dialog.getByRole('listitem').getByRole('button').first().click();
  await dialog.getByLabel('메모리 본문').waitFor();
  await dialog.getByRole('button', { name: '취소 / 목록', exact: true }).click();
  failRead = true;
  await dialog.getByRole('button', { name: '새로고침', exact: true }).click();
  await expectText('목록 테스트 오류');
  assert.equal(await dialog.getByRole('listitem').count(), 1);
  failRead = false;
  await dialog.getByRole('button', { name: '새로고침', exact: true }).click();
  await expectText('66개 검색됨');
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  delayRead = 600;
  await open();
  await expectText('불러오는 중…');
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await open('chat-b');
  await expectText('65개 검색됨');
  await page.waitForTimeout(800);
  await expectText('65개 검색됨');
  assert.equal(await dialog.getByText('챗 전용 기억', { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS memory UI: pagination/search/filters/sort, explicit edit save, write retry, batch disable/move/delete + cancel, duplicate prevention, dirty close guard, responsive detail, reload failure/recovery, late-response isolation');
} finally {
  await browser?.close();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
}
