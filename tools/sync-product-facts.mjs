#!/usr/bin/env node
/**
 * Scan live API/layout sources → core/config/defaults/product-facts.json
 * Product memory for the code agent (E) — prefer over model memory.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRulebookDocsDir, resolveRulebookRoot, rulebookMemoryFileRels } from './rulebook-paths.mjs';

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

const rulebookDocs = resolveRulebookDocsDir(root);
const rulebookRoot = resolveRulebookRoot(root);

const layout = {
  primary_ui: existsSync(path.join(root, 'ui/workspace')) ? 'ui/workspace' : null,
  shell: existsSync(path.join(root, 'shell/CqrPa.Shell')) ? 'shell/CqrPa.Shell' : null,
  core_src: existsSync(path.join(root, 'core/src')) ? 'core/src' : null,
  api_dispatch: existsSync(path.join(root, dispatchRel)) ? dispatchRel : null,
  rulebook: rulebookDocs
    ? path.relative(root, rulebookDocs).replace(/\\/g, '/')
    : null,
  rulebook_canonical: rulebookRoot
    ? path.relative(root, rulebookRoot).replace(/\\/g, '/')
    : null,
  agents_md: existsSync(path.join(root, 'AGENTS.md')) ? 'AGENTS.md' : null,
  ui_facts: existsSync(path.join(root, 'core/config/defaults/ui-facts.json'))
    ? 'core/config/defaults/ui-facts.json'
    : null,
  work_kit_launcher_ui: existsSync(path.join(root, 'ui/work-kit-launcher'))
    ? 'ui/work-kit-launcher'
    : null,
  work_kit_launcher_shell: existsSync(path.join(root, 'shell/WorkKitLauncher'))
    ? 'shell/WorkKitLauncher'
    : null,
  launcher_manifest: existsSync(path.join(root, 'launcher-manifest.json'))
    ? 'launcher-manifest.json'
    : null,
};

const memoryFiles = ['AGENTS.md', ...rulebookMemoryFileRels(root)].filter((rel, i, arr) => arr.indexOf(rel) === i);

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
