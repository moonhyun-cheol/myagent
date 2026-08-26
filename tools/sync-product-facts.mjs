#!/usr/bin/env node
/**
 * Scan live API/layout sources → core/config/defaults/product-facts.json
 * Product memory for the code agent (E) — prefer over model memory.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readText(rel) {
  const abs = path.join(root, rel);
  if (!existsSync(abs)) return null;
  return readFileSync(abs, 'utf8');
}

const dispatchRel = 'core/src/routes/dispatch.ts';
const dispatch = readText(dispatchRel) ?? '';

const apiRoots = [];
const rootsBlock = dispatch.match(/const roots = \[([\s\S]*?)\];/);
if (rootsBlock) {
  for (const m of rootsBlock[1].matchAll(/'([^']+)'/g)) {
    apiRoots.push(m[1]);
  }
}

/** @type {{ method: string, path: string, match: 'exact' | 'prefix' }[]} */
const routes = [];
const seen = new Set();

function addRoute(method, p, match) {
  const key = `${method} ${match} ${p}`;
  if (seen.has(key)) return;
  seen.add(key);
  routes.push({ method, path: p, match });
}

for (const m of dispatch.matchAll(
  /method === '(GET|POST|PUT|DELETE|PATCH)' && url\.pathname === '([^']+)'/g,
)) {
  addRoute(m[1], m[2], 'exact');
}
for (const m of dispatch.matchAll(
  /method === '(GET|POST|PUT|DELETE|PATCH)' && url\.pathname\.startsWith\('([^']+)'\)/g,
)) {
  addRoute(m[1], m[2], 'prefix');
}
// Multi-or pathname equality: (url.pathname === '/a' || url.pathname === '/b')
for (const m of dispatch.matchAll(
  /method === '(GET|POST|PUT|DELETE|PATCH)' && \(([^)]+)\)/g,
)) {
  const method = m[1];
  for (const p of m[2].matchAll(/url\.pathname === '([^']+)'/g)) {
    addRoute(method, p[1], 'exact');
  }
  for (const p of m[2].matchAll(/url\.pathname\.startsWith\('([^']+)'\)/g)) {
    addRoute(method, p[1], 'prefix');
  }
}

routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

const layout = {
  primary_ui: existsSync(path.join(root, 'ui/workspace')) ? 'ui/workspace' : null,
  shell: existsSync(path.join(root, 'shell/CqrPa.Shell')) ? 'shell/CqrPa.Shell' : null,
  core_src: existsSync(path.join(root, 'core/src')) ? 'core/src' : null,
  api_dispatch: existsSync(path.join(root, dispatchRel)) ? dispatchRel : null,
  rulebook: existsSync(path.join(root, 'rulebook/docs')) ? 'rulebook/docs' : null,
  agents_md: existsSync(path.join(root, 'AGENTS.md')) ? 'AGENTS.md' : null,
  ui_facts: existsSync(path.join(root, 'core/config/defaults/ui-facts.json'))
    ? 'core/config/defaults/ui-facts.json'
    : null,
};

const memoryFiles = [
  'AGENTS.md',
  'rulebook/docs/00_PROJECT_BRIEF.md',
  'rulebook/docs/01_CURRENT_STATUS.md',
  'rulebook/docs/specs/technical/ui-target-map.md',
  'rulebook/docs/specs/technical/architecture.md',
].filter((rel) => existsSync(path.join(root, rel)));

const facts = {
  version: 1,
  generated_at: new Date().toISOString(),
  note: 'Build-generated. Prefer over memory. Re-run: node tools/sync-product-facts.mjs',
  layout,
  memory_files: memoryFiles,
  api: {
    source: dispatchRel,
    roots: apiRoots,
    route_count: routes.length,
    routes: routes.slice(0, 120),
  },
};

const outDir = path.join(root, 'core', 'config', 'defaults');
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'product-facts.json');
writeFileSync(outPath, `${JSON.stringify(facts, null, 2)}\n`, 'utf8');

console.log(
  `sync-product-facts: ${routes.length} routes, ${apiRoots.length} roots → ${path.relative(root, outPath)}`,
);
