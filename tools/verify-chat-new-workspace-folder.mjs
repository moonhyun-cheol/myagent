import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from '../ui/workspace/node_modules/vite/dist/node/index.js';
import { dispatchApiRequest } from '../core/dist/routes/dispatch.js';
import { ProjectStore } from '../core/dist/projects/project-store.js';
import { SessionStore } from '../core/dist/sessions/session-store.js';
import { loadUserOverrides, saveUserOverrides } from '../core/dist/config/user-overrides.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(path.join(os.tmpdir(), 'myagent-chat-folder-'));
const folder = path.join(temp, '업무 이미지검수', '20261113');
const other = path.join(temp, 'other');
const invalid = path.join(temp, 'missing');
const config = path.join(temp, 'config', 'user-overrides.json');
for (const dir of [folder, other, path.dirname(config), path.join(temp, 'projects'), path.join(temp, 'sessions')]) mkdirSync(dir, { recursive: true });
writeFileSync(path.join(temp, 'not-folder.txt'), 'not a folder');
const projects = new ProjectStore(path.join(temp, 'projects'), temp);
const sessions = new SessionStore(path.join(temp, 'sessions'), temp);
const owner = projects.create({ title: '대화 소속 유지', kind: 'project' });
const baseline = projects.upsertWorkspaceRoot(other);
sessions.ensure('api-chat', { project_id: owner.id });
sessions.ensure('peer');
sessions.ensure('prompt-chat', { project_id: owner.id });
saveUserOverrides(config, { dev_workspace_root: other }, temp);
let readOnly = false;
let delayBinding = false;
let releaseBinding;
const context = {
  cqrRoot: temp, userConfigPath: config, projectStore: projects, sessionStore: sessions,
  getOverrides: () => loadUserOverrides(config),
  license: { assertFeature() {}, assertWritable() { if (readOnly) throw new Error('READ_ONLY'); } },
};
const entry = `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { ChatPane } from '/src/components/ChatPane.tsx';
  import { useWorkspaceStore } from '/src/store/workspaceStore.ts';
  import '/src/index.css';
  window.fixtureStore = useWorkspaceStore;
  window.sent = [];
  useWorkspaceStore.setState({ sendAiMessage: async text => { window.sent.push({ text, sessionId: useWorkspaceStore.getState().activeSessionId }); } });
  localStorage.removeItem('my-agent-workspace-session');
  localStorage.removeItem('cqr-workspace-session');
  createRoot(document.getElementById('root')).render(React.createElement(ChatPane));
`;
const chromiumPath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p => p && existsSync(p));
let server;
let browser;
try {
  const assets = path.join(root, 'ui/workspace/dist/assets');
  const bundle = readdirSync(assets).filter(name => name.endsWith('.js')).map(name => readFileSync(path.join(assets, name), 'utf8')).join('\n');
  assert.ok(bundle.includes('chat-workspace-add-folder') && bundle.includes('workspace-access-add-folder'), 'built UI must contain both entry points');
  server = await createServer({
    root: path.join(root, 'ui/workspace'), configFile: false, logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{
      name: 'chat-folder-test',
      resolveId(id) { if (id === '/test-entry.js') return '\0chat-folder-test'; },
      load(id) { if (id === '\0chat-folder-test') return entry; },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url, 'http://127.0.0.1');
          const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
          if (url.pathname === '/test') {
            res.setHeader('Content-Type', 'text/html');
            return res.end('<html><body><div id="root" style="height:100vh"></div><script type="module" src="/test-entry.js"></script></body></html>');
          }
          if (url.pathname === '/models/picker') return json({ models: [{ id: 'auto', label: '자동', category: 'chat' }], premium_model_ids: [] });
          if (url.pathname === '/skills/selectable') return json({ skills: [] });
          if (/^\/sessions\/[^/]+\/attachments$/.test(url.pathname)) return json({ attachments: [] });
          // Keep initial folder browsing inside the fixture, without enumerating the user's drives/shares.
          if (url.pathname === '/fs/browse' && !url.searchParams.has('path')) return json({ path: temp, parent: null, entries: [{ name: '업무 이미지검수', path: path.dirname(folder) }] });
          if (url.pathname === '/workspace' || url.pathname === '/sessions' || url.pathname.startsWith('/sessions/') || url.pathname.startsWith('/fs/')) {
            try {
              if (delayBinding && url.pathname.endsWith('/workspace') && req.method === 'PUT') {
                await new Promise(resolve => { releaseBinding = resolve; });
              }
              await dispatchApiRequest(context, req, res, url, req.method);
            } catch (error) {
              res.statusCode = 403;
              json({ error: String(error.message) });
            }
            return;
          }
          next();
        });
      },
    }],
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const bind = async (body, sid = 'api-chat') => {
    const res = await fetch(`${origin}/sessions/${sid}/workspace`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  const initialRoots = projects.listWorkspaceRoots().length;
  for (const body of [{ folder_path: '' }, { folder_path: 42 }, { folder_path: 'relative/path' }, { folder_path: folder, workspace_project_id: baseline.id }]) assert.equal((await bind(body)).status, 400);
  for (const folder_path of [invalid, path.join(temp, 'not-folder.txt'), '\\\\unapproved-host\\share\\folder']) assert.equal((await bind({ folder_path })).status, 403);
  assert.equal((await bind({ folder_path: folder }, 'missing-session')).status, 404);
  readOnly = true;
  assert.equal((await bind({ folder_path: folder })).status, 403);
  readOnly = false;
  assert.equal(projects.listWorkspaceRoots().length, initialRoots, 'invalid requests must not register roots');
  assert.equal(sessions.load('api-chat').workspace_project_id ?? null, null);
  const originalTime = sessions.load('api-chat').updated_at;
  const first = await bind({ folder_path: folder });
  assert.equal(first.status, 200);
  assert.equal(first.data.project_id, owner.id);
  assert.equal(first.data.updated_at, originalTime);
  const linkedId = first.data.workspace_project_id;
  assert.equal((await bind({ folder_path: folder })).data.workspace_project_id, linkedId, 'repeat selection deduplicates');
  assert.equal((await bind({ folder_path: invalid })).status, 403);
  assert.equal(sessions.load('api-chat').workspace_project_id, linkedId, 'failed replacement preserves the existing binding');
  assert.equal(loadUserOverrides(config).dev_workspace_root, other);
  assert.equal(sessions.load('peer').workspace_project_id ?? null, null);
  assert.equal(new SessionStore(path.join(temp, 'sessions'), temp).load('api-chat').workspace_project_id, linkedId, 'binding survives reload');
  assert.equal((await bind({ workspace_project_id: baseline.id })).status, 200);
  assert.equal((await bind({ workspace_project_id: null })).data.workspace_project_id, null);
  console.log('PASS: real API path validation, NAS/read-only guards, registration deduplication, persistence, legacy binding and scope isolation');

  browser = await chromium.launch({ headless: true, ...(chromiumPath ? { executablePath: chromiumPath } : {}) });
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`${origin}/test`);
  await page.getByTestId('chat-workspace-button').waitFor();
  const openPicker = async () => {
    await page.getByTestId('chat-workspace-button').click();
    await page.getByTestId('chat-workspace-add-folder').click();
    await page.getByTestId('folder-browser-dialog').waitFor();
    await page.getByRole('button', { name: '이 폴더 사용' }).waitFor();
  };
  await page.getByRole('textbox', { name: '메시지 입력' }).fill('검수 요청 초안');
  await openPicker();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByTestId('folder-browser-dialog').count(), 0);
  assert.equal(await page.evaluate(() => window.fixtureStore.getState().activeSessionId), null, 'cancel does not create a session');
  await openPicker();
  await page.getByRole('textbox', { name: '폴더 경로' }).fill(invalid);
  await page.getByRole('button', { name: '이 폴더 사용' }).click();
  await page.getByRole('alert').waitFor();
  assert.equal(await page.evaluate(() => window.fixtureStore.getState().activeWorkspaceProjectId), null);
  await page.getByRole('textbox', { name: '폴더 경로' }).fill(`"${folder}"`);
  await page.getByRole('button', { name: '이 폴더 사용' }).click();
  await page.getByTestId('folder-browser-dialog').waitFor({ state: 'detached' });
  const created = await page.evaluate(() => ({ sid: window.fixtureStore.getState().activeSessionId, wid: window.fixtureStore.getState().activeWorkspaceProjectId, pid: window.fixtureStore.getState().activeProjectId }));
  assert.ok(created.sid);
  assert.equal(created.wid, linkedId);
  assert.equal(created.pid, null);
  assert.equal(sessions.load(created.sid).workspace_project_id, linkedId);
  assert.equal(await page.getByRole('textbox', { name: '메시지 입력' }).inputValue(), '검수 요청 초안');
  await page.waitForFunction(id => window.fixtureStore.getState().filesRoot?.includes('20261113') && window.fixtureStore.getState().activeWorkspaceProjectId === id, linkedId);
  console.log('PASS: empty composer cancel, invalid-path retry, quoted Korean path, session creation, draft preservation and explorer root');

  await openPicker();
  await page.getByRole('textbox', { name: '폴더 경로' }).fill(temp);
  await page.getByRole('button', { name: '이동', exact: true }).click();
  await page.getByRole('button', { name: '업무 이미지검수', exact: true }).click();
  await page.getByRole('button', { name: '20261113', exact: true }).click();
  await page.getByRole('button', { name: '이 폴더 사용' }).click();
  await page.getByTestId('folder-browser-dialog').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.fixtureStore.getState().activeSessionId), created.sid);
  console.log('PASS: directory browsing and existing conversation preserved');

  await page.evaluate(pid => window.fixtureStore.setState({ activeSessionId: 'prompt-chat', composerSessionPromotionId: null, activeProjectId: pid, activeWorkspaceProjectId: null, chat: [] }), owner.id);
  await page.getByRole('textbox', { name: '메시지 입력' }).fill('연결 후 이어서 검수');
  await page.getByRole('textbox', { name: '메시지 입력' }).press('Enter');
  await page.getByTestId('workspace-access-add-folder').click();
  await page.getByRole('textbox', { name: '폴더 경로' }).fill(folder);
  await page.getByRole('button', { name: '이 폴더 사용' }).click();
  await page.waitForFunction(() => window.sent.length === 1);
  assert.deepEqual(await page.evaluate(() => window.sent), [{ text: '연결 후 이어서 검수', sessionId: 'prompt-chat' }]);
  assert.equal(sessions.load('prompt-chat').project_id, owner.id);
  assert.equal(sessions.load('prompt-chat').workspace_project_id, linkedId);
  console.log('PASS: permission prompt new-folder entry connects before sending once without moving ownership');

  delayBinding = true;
  await openPicker();
  await page.getByRole('textbox', { name: '폴더 경로' }).fill(other);
  await page.getByRole('button', { name: '이 폴더 사용' }).click();
  await page.getByRole('button', { name: '연결 중…' }).waitFor();
  await page.evaluate(() => window.fixtureStore.setState({ activeSessionId: 'peer', activeProjectId: null, activeWorkspaceProjectId: null }));
  await page.getByTestId('folder-browser-dialog').waitFor({ state: 'detached' });
  while (!releaseBinding) await new Promise(resolve => setTimeout(resolve, 10));
  const savedResponse = page.waitForResponse(response => response.url().endsWith('/sessions/prompt-chat/workspace') && response.request().method() === 'PUT');
  releaseBinding();
  await savedResponse;
  assert.equal(sessions.load('prompt-chat').workspace_project_id, baseline.id);
  assert.equal(sessions.load('peer').workspace_project_id ?? null, null);
  assert.equal(await page.evaluate(() => window.fixtureStore.getState().activeWorkspaceProjectId), null);
  assert.equal(loadUserOverrides(config).dev_workspace_root, other);
  assert.deepEqual(pageErrors, []);
  console.log('PASS: delayed save cannot redirect another conversation or change its folder; no browser runtime errors');
} finally {
  releaseBinding?.();
  await browser?.close();
  await server?.close();
  rmSync(temp, { recursive: true, force: true });
}
