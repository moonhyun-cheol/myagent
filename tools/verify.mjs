import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupUserVault, restoreUserVault } from './verify-vault-backup.mjs';
import { acquireVerifyLock, releaseVerifyLock } from './verify-lock.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = path.join(root, 'data', 'logs', '.verify.lock');

acquireVerifyLock(lockPath, { root });
process.on('exit', () => releaseVerifyLock(lockPath));

// 'off' rather than '': Windows strips empty env values when spawning children, which
// silently let verify steps auto-activate against the live activation server.
const verifyEnv = { ...process.env, CQR_ACTIVATION_SERVER_URL: 'off' };

backupUserVault();

function runTool(script, env = process.env) {
  return spawnSync(process.execPath, [path.join(root, 'tools', script)], {
    cwd: root,
    stdio: 'inherit',
    env,
  });
}

const ensureKeys = runTool('ensure-dev-keys.mjs');
if (ensureKeys.status !== 0) {
  console.error('verify failed at: ensure-dev-keys');
  process.exit(ensureKeys.status ?? 1);
}

const steps = [
  ['build', () => runTool('build.mjs')],
  ['deploy-parity', () => runTool('verify-deploy-parity.mjs', verifyEnv)],
  ['nas', () => runTool('verify-no-nas-paths.mjs', verifyEnv)],
  ['readonly', () => runTool('verify-read-only-mode.mjs', verifyEnv)],
  ['license', () => runTool('verify-license.mjs', verifyEnv)],
  ['attachments', () => runTool('verify-attachments.mjs', verifyEnv)],
  ['models', () => runTool('verify-models.mjs', verifyEnv)],
  ['image-gen-retry', () => runTool('verify-image-gen-retry.mjs', verifyEnv)],
  ['checkpoint-sweep', () => runTool('verify-checkpoint-sweep.mjs', verifyEnv)],
  ['session-temp-gc', () => runTool('verify-session-temp-gc.mjs', verifyEnv)],
  ['lock-policy', () => runTool('verify-lock-policy.mjs', verifyEnv)],
  ['post-mutate-syntax', () => runTool('verify-post-mutate-syntax.mjs', verifyEnv)],
  ['diagnostics-ui-tsc', () => runTool('verify-diagnostics-ui-tsc.mjs', verifyEnv)],
  ['phase4', () => runTool('verify-phase4.mjs', verifyEnv)],
  ['providers', () => runTool('verify-providers.mjs', verifyEnv)],
  ['phase6', () => runTool('verify-phase6.mjs', verifyEnv)],
  ['phase7', () => runTool('verify-phase7.mjs', verifyEnv)],
  ['phase8', () => runTool('verify-phase8.mjs', verifyEnv)],
  ['phase9', () => runTool('verify-phase9.mjs', verifyEnv)],
  ['phase10', () => runTool('verify-phase10.mjs', verifyEnv)],
  ['phase11', () => runTool('verify-phase11.mjs', verifyEnv)],
  ['playwright', () => runTool('verify-playwright.mjs', verifyEnv)],
];

for (const [name, fn] of steps) {
  const r = fn();
  if (r.status !== 0) {
    console.error(`verify failed at: ${name}`);
    restoreUserVault();
    process.exit(r.status ?? 1);
  }
}
restoreUserVault();
console.log('all verifications passed');
