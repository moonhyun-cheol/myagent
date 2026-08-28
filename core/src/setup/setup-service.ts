import { readFileSync, writeFileSync, existsSync, copyFileSync, statSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { ProviderStore } from '../providers/provider-store.js';
import { decryptBundle, parseBundleFile, type BundlePayload } from './key-bundle.js';
import { assertWritablePath } from '../security/path-guard.js';
import { loadDeployDefaults } from '../config/deploy-defaults.js';
import { requestCentralActivation } from './activation-client.js';
import { ensureOpenClawAdapterVault } from '../automaton/openclaw-adapter-provision.js';
import { buildDefaultBundlePayload } from './default-bundle-payload.js';
import {
  writeOpenClawAdapterVault,
  type OpenClawAdapterVaultDoc,
} from '../automaton/openclaw-adapter-vault.js';
import { computeWindowsUserId } from '../license/windows-user-id.js';

const DEFAULT_ORG_ID = 'dev';

export interface SetupStatus {
  needs_license: boolean;
  needs_keys: boolean;
  windows_user: string;
  license_mode: string;
  org_id?: string;
  keys_configured: boolean;
  bundle_present: boolean;
  activation_mode: 'central' | 'none';
  activation_server_url?: string | null;
  activation_error?: string | null;
}

export class SetupService {
  private lastActivationError: string | null = null;

  constructor(
    private readonly vaultDir: string,
    private readonly cqrRoot: string,
    private readonly providerStore: ProviderStore,
  ) {}

  getStatus(): SetupStatus {
    const keysConfigured = this.providerStore.hasAnyKeys();
    const bundlePath = path.join(this.vaultDir, 'keys-bundle.enc');
    const deploy = loadDeployDefaults(this.cqrRoot);
    const serverUrl = deploy.activation_server_url?.trim() || null;
    return {
      needs_license: false,
      needs_keys: !keysConfigured,
      windows_user: computeWindowsUserId(),
      license_mode: 'full',
      org_id: DEFAULT_ORG_ID,
      keys_configured: keysConfigured,
      bundle_present: existsSync(bundlePath),
      activation_mode: serverUrl ? 'central' : 'none',
      activation_server_url: serverUrl,
      activation_error: this.lastActivationError,
    };
  }

  async tryCentralActivation(): Promise<{ activated: boolean; bundle: boolean }> {
    const result = await requestCentralActivation(this.cqrRoot);
    if (!result.attempted) {
      return { activated: false, bundle: false };
    }

    if (!result.activated) {
      this.lastActivationError = result.error ?? 'ACTIVATION_FAILED';
      return { activated: false, bundle: false };
    }

    this.lastActivationError = null;

    let bundleImported = false;
    if (result.keys_bundle?.trim()) {
      try {
        this.importBundle(result.keys_bundle, { overwrite: false });
        bundleImported = true;
      } catch {
        /* keys optional */
      }
    }
    if (!bundleImported) {
      const auto = this.tryAutoImportBundle();
      bundleImported = auto.imported;
    }

    if (result.openclaw_adapter) {
      this.applyOpenClawAdapter(result.openclaw_adapter, 'activation');
    }

    return { activated: true, bundle: bundleImported };
  }

  async ensureOpenClawAdapter(opts?: { force?: boolean }): Promise<{
    ok: boolean;
    written: boolean;
    error?: string;
  }> {
    return ensureOpenClawAdapterVault(this.cqrRoot, this.vaultDir, opts);
  }

  applyOpenClawAdapter(
    adapter: { base_url: string; token: string },
    source: OpenClawAdapterVaultDoc['source'] = 'activation',
  ): void {
    writeOpenClawAdapterVault(this.vaultDir, this.cqrRoot, {
      base_url: adapter.base_url.replace(/\/+$/, ''),
      token: adapter.token,
      source,
    });
  }

  tryAutoImportFromRoot(): { bundle: boolean } {
    const rootBundle = path.join(this.cqrRoot, 'keys-bundle.enc');
    const vaultBundle = path.join(this.vaultDir, 'keys-bundle.enc');
    if (existsSync(rootBundle) && !existsSync(vaultBundle)) {
      try {
        copyFileSync(rootBundle, vaultBundle);
      } catch {
        /* ignore */
      }
    }

    const bundle = this.tryAutoImportBundle();
    return { bundle: bundle.imported };
  }

  importBundle(
    raw: string,
    opts?: { overwrite?: boolean; org_id?: string },
  ): { ok: true; imported: string[] } {
    if (this.providerStore.hasAnyKeys() && !opts?.overwrite) {
      throw new SetupError('KEYS_EXIST', '이미 API 키가 있습니다. 덮어쓰려면 overwrite=true');
    }

    const orgId = opts?.org_id ?? DEFAULT_ORG_ID;
    const enc = parseBundleFile(raw);
    const payload = decryptBundle(enc, orgId);
    const imported = this.applyBundle(payload);

    const bundlePath = path.join(this.vaultDir, 'keys-bundle.enc');
    assertWritablePath(bundlePath, this.cqrRoot);
    writeFileSync(bundlePath, enc + '\n', 'utf8');

    return { ok: true, imported };
  }

  syncProviderRegistry(): { imported: string[] } {
    const added = new Set<string>();
    for (const id of this.tryAutoImportBundle().providers ?? []) added.add(id);
    return { imported: [...added] };
  }

  ensureOpenWebUiFromDefaults(): { imported: boolean } {
    return { imported: false };
  }

  tryAutoImportBundle(): { imported: boolean; providers?: string[] } {
    const orgId = DEFAULT_ORG_ID;
    const keysPath = path.join(this.vaultDir, 'provider-keys.json');
    if (existsSync(keysPath) && statSync(keysPath).size > 32 && !this.providerStore.hasAnyKeys()) {
      const diag = this.providerStore.getVaultDiagnostics();
      if (diag.raw_entry_ids.length > 0 && diag.loaded_entry_ids.length === 0) {
        const quarantine = `${keysPath}.corrupt.${Date.now()}`;
        try {
          renameSync(keysPath, quarantine);
        } catch {
          return { imported: false };
        }
      } else {
        return { imported: false };
      }
    }

    const added: string[] = [];
    const bundlePath = path.join(this.vaultDir, 'keys-bundle.enc');
    const sources: { path: string; orgId: string; persist?: boolean }[] = [];

    if (existsSync(bundlePath)) {
      sources.push({ path: bundlePath, orgId });
    }
    const devBundle = path.join(this.cqrRoot, 'core', 'config', 'defaults', 'keys-bundle.dev.enc');
    if (orgId === 'dev' && existsSync(devBundle)) {
      sources.push({ path: devBundle, orgId, persist: true });
    }
    const defaultBundle = path.join(
      this.cqrRoot,
      'core',
      'config',
      'defaults',
      'keys-bundle.default.enc',
    );
    if (existsSync(defaultBundle)) {
      sources.push({ path: defaultBundle, orgId, persist: !existsSync(bundlePath) });
    }

    for (const src of sources) {
      try {
        const enc = readFileSync(src.path, 'utf8');
        const payload = decryptBundle(parseBundleFile(enc), src.orgId);
        added.push(...this.applyBundle(payload, true));
        if (src.persist) {
          assertWritablePath(bundlePath, this.cqrRoot);
          writeFileSync(bundlePath, enc.trim() + '\n', 'utf8');
        }
      } catch {
        /* try next bundle source */
      }
    }

    const unique = [...new Set(added)];

    if (!this.providerStore.getSecret('custom') || !this.providerStore.getSecret('ollama')) {
      try {
        const payload = buildDefaultBundlePayload({
          orgId,
          cqrRoot: this.cqrRoot,
          requireOpenWebUi: false,
        });
        unique.push(...this.applyBundle(payload, true));
      } catch {
        /* deploy defaults incomplete */
      }
    }

    const merged = [...new Set(unique)];
    return { imported: merged.length > 0, providers: merged.length ? merged : undefined };
  }

  private applyBundle(payload: BundlePayload, onlyMissing = false): string[] {
    const added: string[] = [];
    for (const [id, entry] of Object.entries(payload.entries)) {
      if (id === 'custom') continue;
      if (onlyMissing && this.providerStore.getSecret(id)) continue;
      this.providerStore.saveKey(id, entry.api_key, {
        base_url: entry.base_url,
        model_id: entry.model_id,
      });
      added.push(id);
    }
    if (payload.default_provider_id && !onlyMissing) {
      this.providerStore.setDefault(payload.default_provider_id);
    } else if (payload.default_provider_id && !this.providerStore.getDefaultId()) {
      this.providerStore.setDefault(payload.default_provider_id);
    }
    return added;
  }
}

export class SetupError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SetupError';
  }
}
