#!/usr/bin/env node
/**
 * UTF-8 no BOM + LF normalization for MY Agent source trees.
 * Usage:
 *   node tools/normalize-encoding.mjs [--scan-only] [--target source|all]
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scanOnly = process.argv.includes('--scan-only');
const targetArg = process.argv.find((a, i) => process.argv[i - 1] === '--target');
const target = targetArg === 'all' ? 'all' : 'source';

const TEXT_EXT = new Set([
  '.ts', '.js', '.mjs', '.cjs', '.json', '.md', '.html', '.css', '.xml',
  '.yaml', '.yml', '.txt', '.ini', '.bat', '.cmd', '.ps1', '.cs', '.xaml',
  '.props', '.editorconfig', '.gitignore', '.gitattributes',
]);

const SKIP_DIR = new Set([
  '.git', 'node_modules', 'logs', 'deploy', 'runtime', 'data',
  'webview-user-data', 'EBWebView',
]);

const SKIP_PREFIX = [
  'core/dist/',
  'shell/bin/',
  'tools/keys/',
];

const SOURCE_ROOTS = [
  'core/src',
  'core/config',
  'ui',
  'tools',
  'shell',
  'docs',
  'activation-server',
];

const SOURCE_FILES = [
  'manifest.json',
  'package.json',
  'README.md',
  '.editorconfig',
  '.gitignore',
];

function hasBom(buf) {
  return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
}

function preferredEol(ext) {
  return ext === '.bat' || ext === '.cmd' ? '\r\n' : '\n';
}

function normalizeText(text, eol) {
  const unified = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const body = eol === '\r\n' ? unified.replace(/\n/g, '\r\n') : unified;
  const suffix = body.endsWith('\n') || body.endsWith('\r\n') ? '' : eol;
  return body + suffix;
}

function shouldSkipRel(rel) {
  const norm = rel.replace(/\\/g, '/');
  const top = norm.split('/')[0];
  if (SKIP_DIR.has(top)) return true;
  if (/(^|\/)(obj|bin|out|dist)(\/|$)/.test(norm)) return true;
  return SKIP_PREFIX.some((p) => norm === p || norm.startsWith(p));
}

function* walkFiles(dir, base = '') {
  for (const name of readdirSync(dir)) {
    const rel = base ? `${base}/${name}` : name;
    if (shouldSkipRel(rel)) continue;
    const abs = path.join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      yield* walkFiles(abs, rel);
    } else {
      yield { abs, rel };
    }
  }
}

function collectRoots() {
  if (target === 'all') {
    return [root];
  }
  return SOURCE_ROOTS.map((r) => path.join(root, r)).filter((p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
}

let scanned = 0;
let bomFixed = 0;
let eolFixed = 0;
let bomRemaining = 0;

function processFile(abs, rel) {
  const ext = path.extname(abs).toLowerCase();
  if (!TEXT_EXT.has(ext)) return;

  scanned += 1;
  const raw = readFileSync(abs);
  const hadBom = hasBom(raw);
  let text;
  try {
    text = raw.toString('utf8');
  } catch {
    console.warn('skip (decode):', rel);
    return;
  }
  if (hadBom && text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  const eol = preferredEol(ext);
  const normalized = normalizeText(text, eol);
  const changed = hadBom || normalized !== text;

  if (!changed) return;

  if (hadBom) bomFixed += 1;
  if (normalized !== text) eolFixed += 1;

  if (scanOnly) {
    const flags = [hadBom && 'BOM', normalized !== text && 'EOL'].filter(Boolean).join('+');
    console.log(`[scan] ${flags} ${rel}`);
    if (hadBom) bomRemaining += 1;
    return;
  }

  writeFileSync(abs, normalized, 'utf8');
  console.log('normalized:', rel);
}

for (const walkRoot of collectRoots()) {
  const base = path.relative(root, walkRoot).replace(/\\/g, '/');
  for (const { abs, rel } of walkFiles(walkRoot, base === '.' ? '' : base)) {
    processFile(abs, rel);
  }
}

if (target === 'source') {
  for (const name of SOURCE_FILES) {
    const abs = path.join(root, name);
    try {
      if (statSync(abs).isFile()) processFile(abs, name);
    } catch {
      /* skip */
    }
  }
}

if (!scanOnly) {
  for (const walkRoot of collectRoots()) {
    const base = path.relative(root, walkRoot).replace(/\\/g, '/');
    for (const { abs, rel } of walkFiles(walkRoot, base === '.' ? '' : base)) {
      const ext = path.extname(abs).toLowerCase();
      if (!TEXT_EXT.has(ext)) continue;
      if (hasBom(readFileSync(abs))) {
        bomRemaining += 1;
        console.error('BOM remains:', rel);
      }
    }
  }
}

console.log(
  `normalize-encoding: target=${target} scanned=${scanned} bomFixed=${bomFixed} eolFixed=${eolFixed} bomRemaining=${bomRemaining}`,
);

if (bomRemaining > 0) process.exit(1);
