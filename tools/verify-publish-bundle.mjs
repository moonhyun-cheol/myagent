#!/usr/bin/env node
/**
 * Verify staged install tree has everything needed for dev-parity deploy.
 * Usage: node tools/verify-publish-bundle.mjs [--app-dir PATH]
 */
import { checkDeployParity } from './deploy-parity.mjs';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function getArg(name) {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return null;
  return process.argv[i + 1];
}

const appDir = path.resolve(getArg('--app-dir') ?? path.join(root, 'deploy', 'output', 'stage', 'app'));
const nodeDeferred = process.argv.includes('--node-mode=deferred');

const checks = [
  {
    id: 'api',
    path: 'core/dist/main.js',
    label: 'Node API (core/dist/main.js)',
  },
  {
    id: 'ui',
    path: 'ui/workspace/dist/index.html',
    label: 'Workspace UI',
  },
  {
    id: 'node',
    path: 'runtime/node/node.exe',
    label: 'Portable Node',
    optional: process.argv.includes('--no-node') || nodeDeferred,
  },
  {
    id: 'shell',
    path: 'MYAgent.exe',
    label: 'single user entry (MYAgent.exe)',
  },
  {
    id: 'updater',
    path: 'MYAgent.Updater.exe',
    label: 'transactional update helper (MYAgent.Updater.exe)',
  },
  {
    id: 'keys_bundle',
    path: 'core/config/defaults/keys-bundle.default.enc',
    label: 'Ollama NAS default keys bundle',
  },
  {
    id: 'deploy_defaults',
    path: 'core/config/defaults/deploy-defaults.json',
    label: 'deploy-defaults.json',
  },
];

function resolveCheck(c) {
  const rels = c.paths ?? [c.path];
  for (const rel of rels) {
    const full = path.join(appDir, rel);
    if (existsSync(full)) return { ok: true, rel, full };
  }
  return { ok: false, rel: rels[0], full: path.join(appDir, rels[0]) };
}

let failed = 0;
console.log(`verify-publish-bundle: ${appDir}\n`);

for (const c of checks) {
  const r = resolveCheck(c);
  if (r.ok) {
    console.log(`  OK   ${c.label}`);
    continue;
  }
  if (c.optional) {
    console.log(`  SKIP ${c.label} (optional)`);
    continue;
  }
  console.error(`  FAIL ${c.label} — missing: ${r.rel}`);
  failed++;
}

const stageInstallBat = path.join(appDir, '..', 'install.bat');
if (existsSync(stageInstallBat)) {
  console.log('  OK   zip-root install.bat');
} else {
  console.error('  FAIL zip-root install.bat — missing next to app\\');
  failed++;
}

const forbidden = [
  { id: 'no_github', path: '.github', label: 'GitHub workflow tree must not ship in install zip' },
  { id: 'no_gitignore', path: '.gitignore', label: '.gitignore must not ship in install zip' },
  { id: 'no_port_md', path: 'PORT.md', label: 'PORT.md must not ship in install zip' },
  { id: 'no_repo_target', path: 'repo-target.json', label: 'repo-target.json must not ship in install zip' },
  { id: 'no_activation_server', path: 'activation-server', label: 'activation-server must not ship in install zip' },
  { id: 'no_build_dir', path: '.build', label: '.build must not ship in install zip' },
];

for (const c of forbidden) {
  const full = path.join(appDir, c.path);
  if (existsSync(full)) {
    console.error(`  FAIL ${c.label} — present: ${c.path}`);
    failed++;
  } else {
    console.log(`  OK   ${c.label}`);
  }
}

const deployPath = path.join(appDir, 'core/config/defaults/deploy-defaults.json');
if (existsSync(deployPath)) {
  const deploy = JSON.parse(readFileSync(deployPath, 'utf8'));
  if (!deploy.ollama_base_url?.trim()) {
    console.error('  FAIL deploy-defaults.ollama_base_url is empty');
    failed++;
  } else {
    console.log(`  OK   Ollama URL: ${deploy.ollama_base_url}`);
  }
  if (!deploy.activation_server_url?.trim()) {
    console.warn('  WARN deploy-defaults.activation_server_url is empty (file-only license mode)');
  } else {
    console.log(`  OK   Activation server: ${deploy.activation_server_url}`);
  }
}

const policyPath = path.join(root, 'activation-server', 'policy.json');
const bundlePath = path.join(appDir, 'core/config/defaults/keys-bundle.default.enc');
if (existsSync(policyPath) && existsSync(bundlePath)) {
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  const org = policy.org_id ?? 'myorg';
  console.log(`  INFO activation policy org_id=${org} (keys bundle must match after activation)`);
}

const parity = checkDeployParity(root, { appDir, skipDevLicense: true });
for (const w of parity.warnings) console.warn(`  WARN ${w}`);
for (const e of parity.errors) {
  console.error(`  FAIL ${e}`);
  failed++;
}

console.log('');
if (failed > 0) {
  console.error(`verify-publish-bundle FAILED (${failed} required checks)`);
  process.exit(1);
}
console.log('verify-publish-bundle OK — install zip matches full feature deploy');
