#!/usr/bin/env node
/**
 * UI regression via Playwright Test — dev/CI only.
 * SKIP when API is not running on http://127.0.0.1:10200
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseUrl = process.env.CQR_E2E_BASE_URL ?? 'http://127.0.0.1:10200';

async function serverUp() {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    try {
      const res = await fetch(baseUrl, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }
}

if (!(await serverUp())) {
  console.log(`verify-e2e: SKIP (API not reachable at ${baseUrl})`);
  process.exit(0);
}

const pwCli = path.join(root, 'node_modules', '@playwright', 'test', 'cli.js');
const r = spawnSync(
  process.execPath,
  [
    pwCli,
    'test',
    'api-smoke.spec.ts',
    '-c',
    path.join(root, 'tools', 'e2e', 'playwright.config.ts'),
  ],
  { cwd: path.join(root, 'tools', 'e2e'), stdio: 'inherit', env: { ...process.env, CQR_E2E_BASE_URL: baseUrl } },
);

if (r.status !== 0) {
  console.error('verify-e2e failed');
  process.exit(r.status ?? 1);
}

console.log('verify-e2e OK');
