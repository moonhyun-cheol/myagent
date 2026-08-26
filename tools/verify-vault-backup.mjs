import { copyFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vault = path.join(root, 'data', 'vault');
const lic = path.join(vault, 'license.ocx');
const keys = path.join(vault, 'provider-keys.json');
const config = path.join(root, 'data', 'config', 'user-overrides.json');
const backupDir = path.join(vault, '.verify-backup');

function backupFile(src, name) {
  if (!existsSync(src)) return;
  writeFileSync(path.join(backupDir, name), readFileSync(src));
}

export function backupUserVault() {
  mkdirSync(backupDir, { recursive: true });
  backupFile(lic, 'license.ocx');
  backupFile(keys, 'provider-keys.json');
  backupFile(config, 'user-overrides.json');
}

/**
 * Snapshot the user's vault for the lifetime of this process so a single verify step run
 * on its own cannot leave test licenses/keys behind. When verify.mjs already owns a
 * snapshot the guard is a no-op, leaving the outer restore in charge.
 */
export function guardUserVault() {
  if (existsSync(backupDir)) return () => {};
  backupUserVault();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    restoreUserVault();
  };
  process.on('exit', release);
  return release;
}

export function restoreUserVault() {
  const restore = (name, dest) => {
    const bak = path.join(backupDir, name);
    if (existsSync(bak)) {
      copyFileSync(bak, dest);
      unlinkSync(bak);
    } else if (name === 'provider-keys.json' && existsSync(dest)) {
      unlinkSync(dest);
    } else if (name === 'user-overrides.json' && existsSync(dest)) {
      unlinkSync(dest);
    }
  };
  restore('license.ocx', lic);
  restore('provider-keys.json', keys);
  restore('user-overrides.json', config);
  try {
    if (existsSync(backupDir)) rmdirSync(backupDir);
  } catch {
    /* ignore */
  }
}
