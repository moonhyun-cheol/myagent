#!/usr/bin/env node
/**
 * Static import-cycle check for core/src/agent (and agent/index).
 * Parses relative .js imports only — no external bundler required.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentRoot = path.join(root, 'core/src/agent');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec.replace(/\.js$/i, ''));
  const candidates = [`${base}.ts`, path.join(base, 'index.ts'), base];
  for (const c of candidates) {
    try {
      if (statSync(c).isFile() && c.endsWith('.ts')) return path.normalize(c);
    } catch {
      /* miss */
    }
  }
  return null;
}

const importRe = /(?:import|export)\s+(?:[^'"\n]+from\s+)?['"](\.[^'"]+)['"]/g;

const files = walk(agentRoot);
const graph = new Map();

for (const file of files) {
  const src = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => !/^\s*import\s+type\s+/.test(line))
    .join('\n');
  const deps = new Set();
  let m;
  importRe.lastIndex = 0;
  while ((m = importRe.exec(src))) {
    const resolved = resolveImport(file, m[1]);
    if (resolved && resolved.startsWith(agentRoot)) deps.add(path.normalize(resolved));
  }
  graph.set(path.normalize(file), [...deps]);
}

const visiting = new Set();
const visited = new Set();
const cycles = [];

function dfs(node, stack) {
  if (visiting.has(node)) {
    const i = stack.indexOf(node);
    cycles.push([...stack.slice(i), node]);
    return;
  }
  if (visited.has(node)) return;
  visiting.add(node);
  stack.push(node);
  for (const d of graph.get(node) || []) dfs(d, stack);
  stack.pop();
  visiting.delete(node);
  visited.add(node);
}

for (const f of graph.keys()) dfs(f, []);

if (cycles.length) {
  console.error(`verify-agent-import-cycles: FAIL (${cycles.length} cycle(s))`);
  for (const c of cycles.slice(0, 10)) {
    console.error(
      '  ' + c.map((p) => path.relative(root, p).replace(/\\/g, '/')).join(' -> '),
    );
  }
  process.exit(1);
}

console.log(`verify-agent-import-cycles: ok (files=${files.length})`);
