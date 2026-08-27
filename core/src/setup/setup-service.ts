import { readFileSync, writeFileSync, existsSync, unlinkSync, copyFileSync, statSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { FileLicenseGate } from '../license/file-license-gate.js';
import { parseSignedLicense } from '../license/license-format.js';
import { verifyLicenseSignature } from '../license/license-crypto.js';
import { computeMachineId } from '../license/machine-id.js';
import { computeWindowsUserId, normalizeUserHint } from '../license/windows-user-id.js';
import type { ProviderStore } from '../providers/provider-store.js';
import { decryptBundle, parseBundleFile, type BundlePayload } from './key-bundle.js';
import { assertWritablePath, isNasPath } from '../security/path-guard.js';
import { loadDeployDefaults } from '../config/deploy-defaults.js';
import { requestCentralActivation } from './activation-client.js';
import { ensureOpenClawAdapterVault } from '../automaton/openclaw-adapter-provision.js';
import {
  buildDefaultBundlePayload,
} from './default-bundle-payload.js';
import {
  writeOpenClawAdapterVault,
  type OpenClawAdapterVaultDoc,
} from '../automaton/openclaw-adapter-vault.js';

export interface SetupStatus {
  needs_license: boolean;
  needs_keys: boolean;
  windows_user: string;
  license_mode: string;
  license_reason?: string;
  org_id?: string;
  keys_configured: boolean;
  bundle_present: boolean;
  activation_mode: 'central' | 'file' | 'none';
  activation_server_url?: string | null;
  activation_error?: string | null;
}

export class SetupService {
  private lastActivationError: string | null = null;

  constructor(
    private readonly vaultDir: string,
    private readonly cqrRoot: string,
    private readonly license: FileLicenseGate,
    private readonly providerStore: ProviderStore,
  ) {}

  getStatus(): SetupStatus {
    const lic = this.license.getStatus();
    const keysConfigured = this.providerStore.hasAnyKeys();
    const bundlePath = path.join(this.vaultDir, 'keys-bundle.enc');
    const deploy = loadDeployDefaults(this.cqrRoot);
    const serverUrl = deploy.activation_server_url?.trim() || null;
    const activationMode: SetupStatus['activation_mode'] = serverUrl
      ? 'central'
      : existsSync(path.join(this.cqrRoot, 'license.ocx'))
        ? 'file'
        : 'none';
    return {
      needs_license: lic.mode !== 'full',
      needs_keys: lic.mode === 'full' && !keysConfigured,
      windows_user: computeWindowsUserId(),
      license_mode: lic.mode,
      license_reason: lic.reason,
      org_id: lic.org_id,
      keys_configured: keysConfigured,
      bundle_present: existsSync(bundlePath),
      activation_mode: activationMode,
      activation_server_url: serverUrl,
      activation_error: this.lastActivationError,
    };
  }

  async tryCentralActivation(): Promise<{ license: boolean; bundle: boolean }> {
    if (this.license.getStatus().mode === 'full') {
      return { license: false, bundle: false };
    }

    const result = await requestCentralActivation(this.cqrRoot);
    if (!result.attempted) {
      return { license: false, bundle: false };
    }

    if (!result.activated || !result.license) {
      this.lastActivationError = result.error ?? 'ACTIVATION_FAILED';
      return { license: false, bundle: false };
    }

    try {
      this.importLicense(result.license);
      this.lastActivationError = null;
    } catch (e) {
      this.lastActivationError = e instanceof SetupError ? e.message : String(e);
      return { license: false, bundle: false };
    }

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

    return { license: true, bundle: bundleImported };
  }

  /**
   * Install/update: write OpenClaw URL+token from activation server into vault.
   * Skips when vault already has both unless force=true.
   */
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

  tryAutoImportFromRoot(): { license: boolean; bundle: boolean } {
    let licenseImported = false;
    const vaultLic = path.join(this.vaultDir, 'license.ocx');
    const rootLic = path.join(this.cqrRoot, 'license.ocx');

    if (!existsSync(vaultLic) && existsSync(rootLic)) {
      try {
        this.importLicense(readFileSync(rootLic, 'utf8'));
        licenseImported = true;
      } catch {
        /* wizard fallback */
      }
    }

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
    return { license: licenseImported, bundle: bundle.imported };
  }

  importLicenseFromPath(filePath: string): { ok: true; org_id: string } {
    const resolved = path.resolve(filePath.trim().replace(/^"|"$/g, ''));
    if (isNasPath(resolved)) {
      throw new SetupError('NAS_READ_FORBIDDEN', '공유 폴더에 있는 라이선스 파일은 사용할 수 없습니다. 이 PC로 복사한 뒤 다시 선택하세요.');
    }
    if (!existsSync(resolved)) {
      throw new SetupError('LICENSE_FILE_MISSING', '선택한 라이선스 파일을 찾을 수 없습니다.');
    }
    const st = statSync(resolved);
    if (!st.isFile()) {
      throw new SetupError('LICENSE_FILE_MISSING', '선택한 라이선스 파일을 찾을 수 없습니다.');
    }
    if (st.size > 256 * 1024) {
      throw new SetupError('LICENSE_FILE_TOO_LARGE', '라이선스 파일이 너무 큽니다.');
    }
    const ext = path.extname(resolved).toLowerCase();
    if (ext && ext !== '.ocx' && ext !== '.json' && ext !== '.lic') {
      throw new SetupError('LICENSE_FILE_TYPE', '라이선스 파일(.ocx)을 선택하세요.');
    }
    return this.importLicense(readFileSync(resolved, 'utf8'));
  }

  importLicense(raw: string): { ok: true; org_id: string } {
    const doc = parseSignedLicense(raw);
    if (!doc) throw new SetupError('LICENSE_INVALID', '라이선스 파일 형식이 올바르지 않습니다.');
    if (!verifyLicenseSignature(doc.payload, doc.sig)) {
      throw new SetupError('LICENSE_SIGNATURE_INVALID', '라이선스 서명이 유효하지 않습니다.');
    }

    const expires = new Date(doc.payload.expires_at);
    if (Number.isNaN(expires.getTime()) || expires < new Date()) {
      throw new SetupError('LICENSE_EXPIRED', '라이선스가 만료되었습니다.');
    }

    const userId = computeWindowsUserId();
    const machineId = computeMachineId(this.cqrRoot);

    if (doc.payload.user_hint) {
      const expected = normalizeUserHint(doc.payload.user_hint);
      if (expected !== userId) {
        throw new SetupError(
          'LICENSE_USER_MISMATCH',
          `이 라이선스는 다른 Windows 계정용입니다.\n필요: ${expected}\n현재: ${userId}`,
        );
      }
    }
    if (doc.payload.machine_hint) {
      if (doc.payload.machine_hint !== machineId) {
        throw new SetupError('LICENSE_MACHINE_MISMATCH', '이 라이선스는 다른 PC용입니다.');
      }
    }

    const licensePath = path.join(this.vaultDir, 'license.ocx');
    assertWritablePath(licensePath, this.cqrRoot);
    writeFileSync(licensePath, raw.trim() + '\n', 'utf8');

    const activationPath = path.join(this.vaultDir, 'activation.json');
    if (existsSync(activationPath)) unlinkSync(activationPath);

    this.license.reload();
    return { ok: true, org_id: doc.payload.org_id };
  }

  importBundle(raw: string, opts?: { overwrite?: boolean }): { ok: true; imported: string[] } {
    const lic = this.license.getStatus();
    if (lic.mode !== 'full' || !lic.org_id) {
      throw new SetupError('LICENSE_REQUIRED', '먼저 라이선스 파일을 등록하세요.');
    }

    if (this.providerStore.hasAnyKeys() && !opts?.overwrite) {
      throw new SetupError('KEYS_EXIST', '이미 API 키가 있습니다. 덮어쓰려면 overwrite=true');
    }

    const enc = parseBundleFile(raw);
    const payload = decryptBundle(enc, lic.org_id);
    const imported = this.applyBundle(payload);

    const bundlePath = path.join(this.vaultDir, 'keys-bundle.enc');
    assertWritablePath(bundlePath, this.cqrRoot);
    writeFileSync(bundlePath, enc + '\n', 'utf8');

    return { ok: true, imported };
  }

  /** Fill missing non-secret local providers. Company OpenRouter keys are local-entry only. */
  syncProviderRegistry(): { imported: string[] } {
    const added = new Set<string>();
    for (const id of this.tryAutoImportBundle().providers ?? []) added.add(id);
    return { imported: [...added] };
  }

  /** Kept for compatibility; shared/default company credentials are intentionally disabled. */
  ensureOpenWebUiFromDefaults(): { imported: boolean } {
    return { imported: false };
  }

  tryAutoImportBundle(): { imported: boolean; providers?: string[] } {
    if (!this.license.getStatus().valid) return { imported: false };

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

    const orgId = this.license.getStatus().org_id;
    if (!orgId) return { imported: false };

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
      // Shared bundles may configure Ollama, but company OpenRouter credentials stay device-local.
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
