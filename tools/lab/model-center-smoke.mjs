#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const port = 10327;
const baseUrl = `http://127.0.0.1:${port}`;
const nodeExe = path.join(root, 'runtime', 'node', 'node.exe');
const edgeExe = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find(existsSync);
assert.ok(existsSync(nodeExe), `embedded Node missing: ${nodeExe}`);
assert.ok(edgeExe, 'Microsoft Edge is required for the product UI smoke');

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
      /* booting */
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('API health timeout');
}

let browser;
try {
  await waitForHealth();
  browser = await chromium.launch({ headless: true, executablePath: edgeExe });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route('**/models/picker?refresh=1', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        options: [],
        company_models: {
          source: 'default',
          selected: ['open_webui_openrouter_integration.openai.gpt-5.6-terra-pro'],
          defaults: ['open_webui_openrouter_integration.openai.gpt-5.6-terra-pro'],
          available: [
            'open_webui_openrouter_integration.openai.gpt-5.6-terra-pro',
            'open_webui_openrouter_integration.anthropic.claude-opus-4.8',
          ],
        },
      }),
    });
  });
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  const outDir = path.join(root, 'data', 'logs');
  mkdirSync(outDir, { recursive: true });
  await page.screenshot({ path: path.join(outDir, 'workspace-matte-theme-smoke.png'), fullPage: true });
  await page.getByRole('button', { name: '설정', exact: true }).last().click();
  const dialog = page.getByRole('dialog', { name: '설정' });
  await dialog.waitFor({ state: 'visible' });
  await dialog.getByText('MY 클라우드', { exact: true }).waitFor();
  await dialog.getByText('OpenAI', { exact: true }).waitFor();
  await dialog.getByText('Anthropic', { exact: true }).waitFor();
  await dialog.getByText('Gemini', { exact: true }).waitFor();
  await dialog.getByText('기타 호환 API', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: '모델 구성', exact: true }).click();
  await dialog.getByText('선택된 MY 모델', { exact: true }).waitFor();
  await dialog.getByPlaceholder('예: claude, gpt, gemini').fill('claude');
  await dialog.getByText('anthropic.claude-opus-4.8', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(outDir, 'model-center-company-models-smoke.png'), fullPage: true });
  await dialog.getByRole('button', { name: '모델 관리로 돌아가기' }).click();
  await dialog.getByText('기타 호환 API', { exact: true }).click();
  await dialog.getByText('OpenAI 호환 또는 Anthropic 호환 엔드포인트만 추가합니다.', { exact: true }).waitFor();
  assert.equal(await dialog.getByText('MiniMax', { exact: true }).count(), 0);
  for (const hiddenLabel of ['User MCP (stdio)', '로컬 LLM', '로컬 이미지', '시장조사 파이프라인']) {
    assert.equal(await dialog.getByText(hiddenLabel, { exact: true }).count(), 0, `${hiddenLabel} must stay out of model manager`);
  }
  await page.screenshot({ path: path.join(outDir, 'model-center-advanced-smoke.png'), fullPage: true });
  const screenshot = path.join(outDir, 'model-center-smoke.png');
  await page.screenshot({ path: screenshot, fullPage: true });

  await dialog.getByRole('button', { name: '에이전트 기본값', exact: true }).click();
  await dialog.getByTestId('settings-reasoning-level').waitFor();
  await dialog.getByTestId('settings-autopilot-mode').waitFor();
  await dialog.getByRole('button', { name: '권한 및 승인', exact: true }).click();
  await dialog.getByTestId('settings-approval-delegation-mode').waitFor();
  await page.screenshot({ path: path.join(outDir, 'settings-agent-runtime-smoke.png'), fullPage: true });
  await dialog.getByRole('button', { name: '설정 닫기', exact: true }).click();

  await page.getByTestId('chat-execution-policy').click();
  await page.getByTestId('chat-reasoning-level').selectOption('high');
  await page.getByTestId('chat-autopilot-level').selectOption('on');
  await page.getByText('현재 채팅 실행 정책', { exact: true }).waitFor();
  await page.waitForFunction(async () => {
    const id = localStorage.getItem('cqr-workspace-session');
    if (!id) return false;
    const rec = await fetch(`/sessions/${encodeURIComponent(id)}`).then((response) => response.json());
    return rec.execution_policy?.reasoning === 'high' && rec.execution_policy?.autopilot === 'on';
  });
  await page.screenshot({ path: path.join(outDir, 'chat-execution-policy-smoke.png'), fullPage: true });

  console.log(`model-center-smoke: PASS ${screenshot}`);
} finally {
  await browser?.close().catch(() => undefined);
  api.kill('SIGTERM');
}
