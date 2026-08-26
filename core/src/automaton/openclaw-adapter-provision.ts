import { requestOpenClawAdapterProvision } from '../setup/activation-client.js';
import {
  hasOpenClawAdapterVault,
  writeOpenClawAdapterVault,
} from './openclaw-adapter-vault.js';

export async function ensureOpenClawAdapterVault(
  cqrRoot: string,
  vaultDir: string,
  opts?: { force?: boolean },
): Promise<{ ok: boolean; written: boolean; error?: string }> {
  if (!opts?.force && hasOpenClawAdapterVault(vaultDir)) {
    return { ok: true, written: false };
  }
  const pulled = await requestOpenClawAdapterProvision(cqrRoot);
  if (!pulled.ok || !pulled.adapter) {
    return { ok: false, written: false, error: pulled.error };
  }
  writeOpenClawAdapterVault(vaultDir, cqrRoot, {
    base_url: pulled.adapter.base_url.replace(/\/+$/, ''),
    token: pulled.adapter.token.trim(),
    source: 'activation',
  });
  return { ok: true, written: true };
}
