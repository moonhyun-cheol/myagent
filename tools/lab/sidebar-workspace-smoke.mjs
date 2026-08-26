#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const port = 10331;
const baseUrl = `http://127.0.0.1:${port}`;
const nodeExe = path.join(root, 'runtime', 'node', 'node.exe');
const edgeExe = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find(existsSync);

assert.ok(existsSync(nodeExe), `embedded Node missing: ${nodeExe}`);
assert.ok(edgeExe, 'Microsoft Edge is required for the sidebar smoke');

const api = spawn(nodeExe, [path.join(root, 'core', 'dist', 'main.js')], {
  cwd: root,
  env: { ...process.env, MY_AGENT_ROOT: root, CQR_API_PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

async function waitForHealth() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // API is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('API health timeout');
}

let browser;
try {
  await waitForHealth();
  browser = await chromium.launch({ headless: true, executablePath: edgeExe });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(baseUrl, { waitUntil: 'networkidle' });

  const chatHeading = page.getByText('채팅 목록', { exact: true }).first();
  const workHeading = page.getByText('작업 단위', { exact: true }).first();
  await chatHeading.waitFor({ state: 'visible' });
  await workHeading.waitFor({ state: 'visible' });
  await page.getByRole('button', { name: /작업 폴더 추가/ }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: /새 프로젝트/ }).waitFor({ state: 'visible' });

  const chatBox = await chatHeading.boundingBox();
  const workBox = await workHeading.boundingBox();
  assert.ok(chatBox && workBox && chatBox.y < workBox.y, 'work units must follow chat list');

  const outDir = path.join(root, 'data', 'logs');
  mkdirSync(outDir, { recursive: true });
  await page.screenshot({ path: path.join(outDir, 'sidebar-workspace-smoke.png'), fullPage: true });
  console.log('sidebar-workspace-smoke: ok');
} finally {
  await browser?.close().catch(() => undefined);
  api.kill();
}
