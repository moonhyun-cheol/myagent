#!/usr/bin/env node
/**
 * MY Agent internal Playwright MCP server (stdio).
 * Spawned by core/src/browser/playwright-mcp-client.ts — not for Cursor IDE config.
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.env.MY_AGENT_ROOT?.trim()
  ? path.resolve(process.env.MY_AGENT_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

process.env.MY_AGENT_ROOT = root;

if (!process.argv.includes('--skip-build')) {
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'build.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const { startPlaywrightMcpServer } = await import(
  pathToFileURL(path.join(root, 'core', 'dist', 'mcp', 'playwright-mcp-server.js')).href
);

await startPlaywrightMcpServer();
