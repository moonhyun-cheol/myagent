#!/usr/bin/env node
/**
 * Copy core product files from the legacy CQR_PA checkout into this repo.
 * Usage: MY_AGENT_LEGACY_ROOT=/path/to/CQR_PA node tools/port-apply.mjs [--dry-run]
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');
const target = JSON.parse(readFileSync(path.join(root, 'repo-target.json'), 'utf8'));
const legacyRoot = path.resolve(
  process.env.MY_AGENT_LEGACY_ROOT
    || path.join(root, '..', target.legacy?.local_folder || 'CQR_PA'),
);

const SKIP = new Set([
  'manifest.json',
  'repo-target.json',
  'VERSION.txt',
  'AGENTS.md',
  'README.md',
  'ui/workspace/src/components/MutateReviewPane.tsx',
]);

/** Local-only improvements that must not be overwritten by the legacy archive. */
const KEEP_LOCAL = new Set([
  'shell/CqrPa.Shell/App.xaml.cs',
  'shell/CqrPa.Shell/UpdateService.cs',
  'shell/CqrPa.Shell/UpdateProgressWindow.xaml',
  'shell/CqrPa.Shell/UpdateProgressWindow.xaml.cs',
  'shell/CqrPa.Updater/Program.cs',
]);

const EXTRA = [
  'core/src/agent/agent-context-profile.ts',
  'tools/verify-agent-context-profiles.mjs',
  'tools/verify-session-preferred-model.mjs',
  'ui/workspace/src/components/SettingsAgentPage.tsx',
  'ui/workspace/src/components/SettingsGeneralPage.tsx',
];

if (!existsSync(legacyRoot)) {
  console.error(`port-apply: legacy checkout not found: ${legacyRoot}`);
  process.exit(1);
}

const status = spawnSync(process.execPath, [path.join(root, 'tools', 'port-status.mjs')], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, MY_AGENT_LEGACY_ROOT: legacyRoot },
});
if (status.status !== 0) {
  console.error(status.stderr || status.stdout);
  process.exit(status.status ?? 1);
}
const report = JSON.parse(status.stdout.split('\n\n')[0]);
const files = [...new Set([...report.apply_core, ...report.missing_in_core, ...EXTRA])]
  .filter((file) => !SKIP.has(file) && !KEEP_LOCAL.has(file));

let copied = 0;
let skipped = 0;
for (const file of files) {
  const src = path.join(legacyRoot, file);
  const dest = path.join(root, file);
  if (!existsSync(src)) {
    skipped += 1;
    console.log(`skip missing legacy: ${file}`);
    continue;
  }
  if (dryRun) {
    console.log(`would copy: ${file}`);
    copied += 1;
    continue;
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(src, dest);
  console.log(`copied: ${file}`);
  copied += 1;
}

console.log(`port-apply: ${dryRun ? 'would copy' : 'copied'} ${copied}, skipped ${skipped}`);
