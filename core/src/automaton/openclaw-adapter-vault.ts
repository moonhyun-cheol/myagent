import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertWritablePath } from '../security/path-guard.js';

export interface OpenClawAdapterVaultDoc {
  base_url?: string;
  token?: string;
  /** Optional legacy client-side signing — prefer empty (server /cqr path). */
  signing_private_key_hex?: string;
  updated_at?: string;
  source?: 'activation' | 'manual' | 'env';
}

export function openClawAdapterVaultPath(vaultDir: string): string {
  return path.join(vaultDir, 'openclaw-adapter.json');
}

export function readOpenClawAdapterVault(vaultDir: string): OpenClawAdapterVaultDoc | null {
  const p = openClawAdapterVaultPath(vaultDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as OpenClawAdapterVaultDoc;
  } catch {
    return null;
  }
}

export function writeOpenClawAdapterVault(
  vaultDir: string,
  cqrRoot: string,
  doc: OpenClawAdapterVaultDoc,
): void {
  const p = openClawAdapterVaultPath(vaultDir);
  mkdirSync(vaultDir, { recursive: true });
  assertWritablePath(p, cqrRoot);
  const out: OpenClawAdapterVaultDoc = {
    ...doc,
    base_url: doc.base_url?.trim().replace(/\/+$/, '') || doc.base_url,
    token: doc.token?.trim() || doc.token,
    updated_at: new Date().toISOString(),
  };
  writeFileSync(p, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
}

/** True when vault has enough for remote OpenClaw (URL + token). */
export function hasOpenClawAdapterVault(vaultDir: string): boolean {
  const doc = readOpenClawAdapterVault(vaultDir);
  return Boolean(doc?.base_url?.trim() && doc?.token?.trim());
}
