#!/usr/bin/env node
/**
 * Pre-publish / pre-deploy gate — encoding, parity, bundles, no debug instrumentation.
 * Usage: node tools/predeploy-check.mjs [--full] [--stage]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDeployParity } from './deploy-parity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const full = process.argv.includes('--full');
const checkStage = process.argv.includes('--stage') || full;

const SKIP_DIR = new Set(['.git', 'node_modules', 'logs', 'deploy', 'runtime', 'data', '.cursor']);
const TEXT_EXT = /\.(ts|js|mjs|cjs|ps1|cs|json|html|css|md|bat)$/i;
const DEBUG_MARK = '7742/ingest';
const DEBUG_SKIP = new Set(['tools/predeploy-check.mjs']);

let failed = 0;
let warned = 0;

function fail(msg) {
  console.error(`  FAIL ${msg}`);
  failed += 1;
}

function warn(msg) {
  console.warn(`  WARN ${msg}`);
  warned += 1;
}

function ok(msg) {
  console.log(`  OK   ${msg}`);
}

function run(label, script, args = [], env = process.env) {
  const r = spawnSync(process.execPath, [path.join(root, 'tools', script), ...args], {
    cwd: root,
    stdio: 'inherit',
    env,
  });
  if (r.status !== 0) {
    fail(`${label} (exit ${r.status ?? 1})`);
    return false;
  }
  return true;
}

function* walkSource(dir, base = '') {
  for (const name of readdirSync(dir)) {
    const rel = base ? `${base}/${name}` : name;
    const top = rel.split('/')[0];
    if (SKIP_DIR.has(top)) continue;
    if (/(^|\/)(dist|bin|obj)(\/|$)/.test(rel)) continue;
    const abs = path.join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) yield* walkSource(abs, rel);
    else if (TEXT_EXT.test(name)) yield { abs, rel: rel.replace(/\\/g, '/') };
  }
}

console.log('predeploy-check\n');

console.log('1) Debug instrumentation (must be absent in ship paths)');
const debugHits = [];
for (const rootName of ['core/src', 'ui', 'shell', 'tools', 'activation-server']) {
  const walkRoot = path.join(root, rootName);
  if (!existsSync(walkRoot)) continue;
  for (const { abs, rel } of walkSource(walkRoot, rootName)) {
    if (DEBUG_SKIP.has(rel)) continue;
    if (readFileSync(abs, 'utf8').includes(DEBUG_MARK)) debugHits.push(rel);
  }
}

if (debugHits.length) {
  fail(
    `agent log regions remain (${debugHits.length}): ${debugHits.slice(0, 8).join(', ')}${debugHits.length > 8 ? '…' : ''}`,
  );
} else {
  ok('no debug instrumentation in source trees');
}

console.log('\n2) UTF-8 / BOM');
if (run('encoding scan', 'normalize-encoding.mjs', ['--scan-only'])) {
  ok('encoding scan passed');
}

console.log('\n3) Deploy parity');
const parity = checkDeployParity(root);
for (const w of parity.warnings) warn(w);
if (!parity.ok) {
  for (const e of parity.errors) fail(e);
} else {
  ok('deploy parity (policy, defaults, skills, license.ocx.example)');
}

console.log('\n4) Bundle & defaults sanity');
const deployPath = path.join(root, 'core/config/defaults/deploy-defaults.json');
const defaultBundle = path.join(root, 'core/config/defaults/keys-bundle.default.enc');
const actBundle = path.join(root, 'activation-server/keys-bundle.enc');

if (existsSync(defaultBundle)) warn('generated keys-bundle.default.enc present — verify it contains no Open WebUI secret');
else ok('source tree has no tracked credential bundle (publish generates local-provider bundle)');

if (!existsSync(deployPath)) {
  fail('deploy-defaults.json missing');
} else {
  const deploy = JSON.parse(readFileSync(deployPath, 'utf8'));
  if (!deploy.ollama_base_url?.trim()) fail('ollama_base_url empty');
  else if (/localhost|127\.0\.0\.1/i.test(deploy.ollama_base_url)) {
    warn('ollama_base_url is localhost — fix before employee deploy');
  } else ok(`Ollama: ${deploy.ollama_base_url}`);

  if (!deploy.activation_server_url?.trim()) warn('activation_server_url empty — file-only/local mode');
  else if (/localhost|127\.0\.0\.1/i.test(deploy.activation_server_url)) {
    warn('activation_server_url is localhost');
  } else ok(`Activation: ${deploy.activation_server_url}`);

  if (!deploy.ollama_default_model?.trim()) warn('ollama_default_model empty');
  else ok(`Default model: ${deploy.ollama_default_model}`);

  if (deploy.openwebui_base_url?.trim()) ok(`OpenAI-compatible endpoint: ${deploy.openwebui_base_url}`);
  else ok('remote provider endpoint is device-local and optional');
}

const policyPath = path.join(root, 'activation-server/policy.json');
if (existsSync(policyPath)) {
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  if (policy.require_allowlist) warn('require_allowlist=true — deploy PCs need manual allowlist');
  ok(`policy org_id=${policy.org_id ?? '?'}`);
}

if (existsSync(actBundle)) ok('activation-server/keys-bundle.enc');
else warn('activation-server/keys-bundle.enc missing — run sync-owui-bundles or bundle-keys for server');

console.log('\n5) UI charset');
const indexHtml = path.join(root, 'ui/workspace/dist/index.html');
if (existsSync(indexHtml)) {
  const html = readFileSync(indexHtml, 'utf8');
  if (!/charset\s*=\s*["']?utf-8/i.test(html)) fail('index.html missing UTF-8 charset');
  else ok('index.html charset=utf-8');
} else fail('workspace UI missing — run npm run workspace:build');

console.log('\n6) Build');
if (run('build', 'build.mjs')) ok('TypeScript build');

console.log('\n6b) Skill/tool lab L1 strict');
if (
  run('skill-tool-lab', path.join('lab', 'skill-tool-lab.mjs'), ['--level=1', '--fail-on-skip'])
) {
  ok('skill/tool lab L1 strict');
}

console.log('\n6c) Harness goldens + embedding cold');
if (run('harness-goldens', 'verify-harness-goldens.mjs')) ok('harness goldens');
if (run('embedding-cold', 'verify-embedding-cold.mjs')) ok('embedding cold');

if (checkStage) {
  console.log('\n7) Publish stage (if present)');
  const stageApp = path.join(root, 'deploy/output/stage/app');
  if (existsSync(stageApp)) {
    // Old/full/slim stages vary: full embeds node+venv; deferred/slim omit them until install.
    // Auto-detect so predeploy --stage does not fail a legitimate deferred tree.
    const hasNode = existsSync(path.join(stageApp, 'runtime', 'node', 'node.exe'));
    const hasVenv = existsSync(
      path.join(stageApp, 'runtime', 'pipeline-venv', 'Scripts', 'python.exe'),
    );
    const stageArgs = ['--app-dir', stageApp];
    if (!hasNode) {
      stageArgs.push('--node-mode=deferred');
      warn('stage: no portable node.exe — treating as --node-mode=deferred (install-time bootstrap)');
    }
    if (!hasVenv) {
      stageArgs.push('--venv-mode=deferred');
      warn('stage: no pipeline-venv — treating as --venv-mode=deferred');
    }
    run('verify-publish-bundle', 'verify-publish-bundle.mjs', stageArgs);
  } else {
    warn('no deploy/output/stage/app — run npm run publish before final zip check');
  }
}

if (full) {
  console.log('\n8) Full verify suite');
  run('verify', 'verify.mjs', [], { ...process.env, CQR_ACTIVATION_SERVER_URL: '' });
  console.log('\n8b) Release checklist reminder');
  ok('lab + sandbox-slim-install-test');
}

console.log('');
if (failed > 0) {
  console.error(`predeploy-check FAILED (${failed} errors, ${warned} warnings)`);
  process.exit(1);
}
console.log(`predeploy-check OK (${warned} warnings)`);
