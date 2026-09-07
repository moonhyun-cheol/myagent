import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import {
  loadAdapterConnection,
  type AdapterConnectionDoc,
} from './adapter-connection.js';
import {
  hasOpenClawAdapterVault,
  readOpenClawAdapterVault,
  writeOpenClawAdapterVault,
  type OpenClawAdapterVaultDoc,
} from './openclaw-adapter-vault.js';

function stableDeviceId(vault: OpenClawAdapterVaultDoc | null): string {
  const existing = vault?.device_id?.trim();
  if (existing) return existing;
  const host = hostname().replace(/[^\w.-]+/g, '_').slice(0, 40) || 'host';
  return `cqr-${host}-${randomUUID().slice(0, 8)}`;
}

export async function ensureOpenClawDeviceToken(opts: {
  cqrRoot: string;
  vaultDir: string;
  baseUrl?: string;
  connection?: AdapterConnectionDoc | null;
  force?: boolean;
}): Promise<{ ok: boolean; token?: string; baseUrl?: string; written: boolean; error?: string }> {
  const connection = opts.connection ?? loadAdapterConnection(opts.cqrRoot);
  const vault = readOpenClawAdapterVault(opts.vaultDir);
  const allowLegacy = connection?.authentication?.allow_legacy_vault_token !== false;
  const baseUrl = (
    opts.baseUrl?.trim()
    || connection?.base_url?.trim()
    || vault?.base_url?.trim()
    || process.env.OPENCLAW_ADAPTER_BASE_URL?.trim()
    || ''
  ).replace(/\/+$/, '');

  if (!opts.force && hasOpenClawAdapterVault(opts.vaultDir) && allowLegacy) {
    return {
      ok: true,
      written: false,
      token: vault?.token?.trim(),
      baseUrl: vault?.base_url?.trim() || baseUrl || undefined,
    };
  }

  const envToken = (
    process.env.OPENCLAW_ADAPTER_TOKEN?.trim()
    || process.env.MAIN_API_TOKEN?.trim()
    || process.env.MANAGER_API_TOKEN?.trim()
    || ''
  );
  if (!opts.force && envToken && baseUrl) {
    return { ok: true, written: false, token: envToken, baseUrl };
  }

  const mode = connection?.authentication?.mode || 'install_bootstrap';
  const bootstrapKey = connection?.authentication?.bootstrap_key?.trim() || '';
  const bootstrapPath = connection?.authentication?.bootstrap_path?.trim()
    || '/cqr/adapter/auth/bootstrap';
  if (mode !== 'install_bootstrap' || !bootstrapKey || !baseUrl) {
    if (vault?.token?.trim() && baseUrl) {
      return {
        ok: true,
        written: false,
        token: vault.token.trim(),
        baseUrl: vault.base_url?.trim() || baseUrl,
      };
    }
    return {
      ok: false,
      written: false,
      error: 'OpenClaw adapter bootstrap 설정이 없습니다 (base_url + bootstrap_key).',
    };
  }

  const deviceId = stableDeviceId(vault);
  const url = `${baseUrl}${bootstrapPath.startsWith('/') ? '' : '/'}${bootstrapPath}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        bootstrap_key: bootstrapKey,
        device_id: deviceId,
        device_label: hostname() || 'my-agent',
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return {
      ok: false,
      written: false,
      error: `bootstrap 연결 실패: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    parsed = {};
  }
  if (res.status === 404) {
    return {
      ok: false,
      written: false,
      error: 'OpenClaw /cqr/adapter/auth/bootstrap 없음 — Adapter API를 최신으로 재기동하세요',
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      written: false,
      error: String(
        parsed.user_message
        || parsed.reason_code
        || `bootstrap HTTP ${res.status}`,
      ),
    };
  }
  const deviceToken = String(parsed.device_token || '').trim();
  if (!deviceToken) {
    return { ok: false, written: false, error: 'bootstrap 응답에 device_token이 없습니다.' };
  }

  writeOpenClawAdapterVault(opts.vaultDir, opts.cqrRoot, {
    base_url: baseUrl,
    token: deviceToken,
    device_id: deviceId,
    expires_at: typeof parsed.expires_at === 'string' ? parsed.expires_at : undefined,
    source: 'bootstrap',
  });
  return { ok: true, written: true, token: deviceToken, baseUrl };
}
