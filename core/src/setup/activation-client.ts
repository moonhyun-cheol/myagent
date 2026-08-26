import { loadDeployDefaults } from '../config/deploy-defaults.js';
import { computeMachineId } from '../license/machine-id.js';
import { computeWindowsUserId } from '../license/windows-user-id.js';
import { readProductVersion } from '../config/product-version.js';

export interface OpenClawAdapterProvision {
  base_url: string;
  token: string;
}

export interface ActivationResponse {
  ok: boolean;
  license?: string;
  keys_bundle?: string;
  openclaw_adapter?: OpenClawAdapterProvision;
  error?: string;
  message?: string;
}

export interface ActivationResult {
  attempted: boolean;
  activated: boolean;
  bundle: boolean;
  error?: string;
  server_url?: string;
  license?: string;
  keys_bundle?: string;
  openclaw_adapter?: OpenClawAdapterProvision;
}

const ACTIVATE_TIMEOUT_MS = 15_000;

function activationHeaders(cqrRoot: string): Record<string, string> {
  const defaults = loadDeployDefaults(cqrRoot);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (defaults.activation_token?.trim()) {
    headers.Authorization = `Bearer ${defaults.activation_token.trim()}`;
  }
  return headers;
}

function normalizeOpenClawAdapter(raw: unknown): OpenClawAdapterProvision | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const base_url = String(o.base_url ?? o.baseUrl ?? '').trim().replace(/\/+$/, '');
  const token = String(o.token ?? '').trim();
  if (!base_url || !token) return undefined;
  return { base_url, token };
}

export async function requestCentralActivation(cqrRoot: string): Promise<ActivationResult> {
  const defaults = loadDeployDefaults(cqrRoot);
  const serverUrl = defaults.activation_server_url?.replace(/\/$/, '');
  if (!serverUrl) {
    return { attempted: false, activated: false, bundle: false };
  }

  const windowsUser = computeWindowsUserId();
  const machineId = computeMachineId(cqrRoot);
  const productVersion = readProductVersion(cqrRoot);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ACTIVATE_TIMEOUT_MS);

  try {
    const res = await fetch(`${serverUrl}/v1/activate`, {
      method: 'POST',
      headers: activationHeaders(cqrRoot),
      body: JSON.stringify({
        windows_user: windowsUser,
        machine_id: machineId,
        product: 'MY Agent',
        product_version: productVersion,
      }),
      signal: controller.signal,
    });

    const data = (await res.json()) as ActivationResponse;
    if (!res.ok || !data.ok || !data.license?.trim()) {
      return {
        attempted: true,
        activated: false,
        bundle: false,
        error: data.message ?? data.error ?? `HTTP ${res.status}`,
        server_url: serverUrl,
      };
    }

    return {
      attempted: true,
      activated: true,
      bundle: Boolean(data.keys_bundle?.trim()),
      server_url: serverUrl,
      license: data.license,
      keys_bundle: data.keys_bundle,
      openclaw_adapter: normalizeOpenClawAdapter(data.openclaw_adapter),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      attempted: true,
      activated: false,
      bundle: false,
      error: msg.includes('abort') ? '활성화 서버 응답 시간 초과' : msg,
      server_url: serverUrl,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Already-licensed PCs: pull OpenClaw URL+token on install/update without re-issuing license.
 */
export async function requestOpenClawAdapterProvision(
  cqrRoot: string,
): Promise<{ ok: boolean; adapter?: OpenClawAdapterProvision; error?: string; server_url?: string }> {
  const defaults = loadDeployDefaults(cqrRoot);
  const serverUrl = defaults.activation_server_url?.replace(/\/$/, '');
  if (!serverUrl) {
    return { ok: false, error: 'activation_server_url not configured' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ACTIVATE_TIMEOUT_MS);
  try {
    const res = await fetch(`${serverUrl}/v1/openclaw-adapter`, {
      method: 'GET',
      headers: activationHeaders(cqrRoot),
      signal: controller.signal,
    });
    const data = (await res.json()) as ActivationResponse & { openclaw_adapter?: unknown };
    if (!res.ok || !data.ok) {
      return {
        ok: false,
        error: data.message ?? data.error ?? `HTTP ${res.status}`,
        server_url: serverUrl,
      };
    }
    const adapter = normalizeOpenClawAdapter(data.openclaw_adapter);
    if (!adapter) {
      return { ok: false, error: 'openclaw_adapter not configured on activation server', server_url: serverUrl };
    }
    return { ok: true, adapter, server_url: serverUrl };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: msg.includes('abort') ? '활성화 서버 응답 시간 초과' : msg,
      server_url: serverUrl,
    };
  } finally {
    clearTimeout(timer);
  }
}
