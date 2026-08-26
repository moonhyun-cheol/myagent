#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.MY_AGENT_ROOT = root;

spawnSync(process.execPath, [path.join(root, 'tools', 'build.mjs')], { cwd: root, stdio: 'inherit' });

const { probePlaywright } = await import(
  pathToFileURL(path.join(root, 'core', 'dist', 'browser', 'playwright-probe.js')).href
);
const { PlaywrightSession } = await import(
  pathToFileURL(path.join(root, 'core', 'dist', 'browser', 'playwright-session.js')).href
);

const probe = probePlaywright(root);
if (!probe.available) {
  console.log(`verify-playwright: SKIP (${probe.reason ?? 'not installed'})`);
  process.exit(0);
}

let session;
try {
  session = await PlaywrightSession.open({ cqrRoot: root, headless: true });
  const nav = await session.navigate('https://example.com');
  if (!nav.title.toLowerCase().includes('example')) {
    console.error('verify-playwright: unexpected title', nav);
    process.exit(1);
  }
  const tmpWorkspace = path.join(root, 'data', 'outputs', 'browser', 'verify-workspace');
  mkdirSync(tmpWorkspace, { recursive: true });
  const shot = await session.screenshot(tmpWorkspace, '.playwright/verify/example.png', 'verify', {});
  if (!existsSync(shot.path)) {
    console.error('verify-playwright: screenshot missing', shot);
    process.exit(1);
  }
  console.log('verify-playwright OK');
} catch (e) {
  console.error('verify-playwright failed:', e);
  process.exit(1);
} finally {
  await session?.close();
  try {
    rmSync(path.join(root, 'data', 'outputs', 'browser', 'verify-workspace'), {
      recursive: true,
      force: true,
    });
  } catch {
    /* ignore */
  }
}
