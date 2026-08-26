#!/usr/bin/env node
/**
 * Generic Playwright fallback when a normal HTML fetch is insufficient.
 * Uses the MY Agent Playwright bridge (stdio child).
 * Usage: node tools/fetch-page-playwright.mjs <url>
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
spawnSync(process.execPath, [path.join(root, 'tools', 'build.mjs')], { cwd: root, stdio: 'inherit' });

const url = process.argv[2]?.trim();
if (!url) {
  console.error('usage: node tools/fetch-page-playwright.mjs <url>');
  process.exit(2);
}

const { browserFetchPageViaMcp } = await import(
  pathToFileURL(path.join(root, 'core', 'dist', 'browser', 'playwright-mcp-bridge.js')).href
);
const { writeBrowserFetchCache } = await import(
  pathToFileURL(path.join(root, 'core', 'dist', 'browser', 'browser-service.js')).href
);

const result = await browserFetchPageViaMcp(url, {
  cqrRoot: root,
  headless: true,
  allowLocalhost: process.env.MY_AGENT_PLAYWRIGHT_ALLOW_LOCALHOST === '1',
});

if (result.ok) {
  writeBrowserFetchCache(root, url, result);
}

process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(result.ok ? 0 : 1);
