import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { assertWritablePath } from '../security/path-guard.js';
import { vaultMachineIds } from './vault-machine-id.js';
import { decryptSecret, decryptSecretWithKey, encryptSecretWithKey, keyHint } from './vault-crypto.js';
import { createPlatformMasterKeyStore, type MasterKeyStore } from './os-secret-store.js';
import { getProviderDef, loadProviderCatalog } from './provider-catalog.js';
import { sanitizeApiKey } from './api-key.js';
import { determineProviderWireApi, enforcedProviderWireApi, knownProviderWireApi } from './provider-wire-api.js';
import type {
  ProviderDefinition,
  ProviderCompatibility,
  ProviderPublicStatus,
  ProviderSecretEntry,
  ProviderVaultFile,
  UserProviderMeta,
} from './types.js';
import { ProviderError } from './types.js';

interface EncryptedVaultFile {
  version: number;
  default_provider_id: string | null;
  entries: Record<
    string,
    {
      api_key_enc: string;
      cipher?: 'envelope-v2' | 'legacy-v1';
      base_url?: string;
      model_id?: string;
      wire_api?: import('./types.js').ProviderWireApi;
      tool_protocol?: import('./types.js').ProviderToolProtocol;
      updated_at: string;
    }
  >;
  user_defs?: Record<string, UserProviderMeta>;
}

const COMPANY_PROVIDER_ID = 'custom';
const COMPANY_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const ENVELOPE_DECRYPT_ATTEMPTS = 3;

function isCompanyOpenRouterBaseUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.origin === 'https://openrouter.ai' && url.pathname.replace(/\/$/, '') === '/api/v1';
  } catch {
    return false;
  }
}

function slugifyProviderName(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
  return s || 'api';
}

export function isUserProviderId(id: string): boolean {
  return id.startsWith('user_');
}

export class ProviderStore {
  private catalog: ProviderDefinition[];
  private readonly machineIds: string[];
  private readonly masterKeyStore: MasterKeyStore;

  constructor(
    private readonly vaultPath: string,
    private readonly cqrRoot: string,
    masterKeyStore?: MasterKeyStore,
  ) {
    this.catalog = loadProviderCatalog();
    this.machineIds = vaultMachineIds(cqrRoot);
    this.masterKeyStore = masterKeyStore ?? createPlatformMasterKeyStore(vaultPath, cqrRoot);
    this.migrateKnownWireApis();
  }

  /** Bundled catalog + user-defined OpenAI-compatible providers. */
  listDefinitions(): ProviderDefinition[] {
    const vault = this.loadVault();
    const userDefs = Object.entries(vault.user_defs ?? {}).map(([id, meta]) =>
      this.userMetaToDef(id, meta),
    );
    return [...this.catalog, ...userDefs];
  }

  getDefinition(id: string): ProviderDefinition | undefined {
    return getProviderDef(this.listDefinitions(), id);
  }

  listPublic(): ProviderPublicStatus[] {
    const vault = this.loadVault();
    return this.listDefinitions().map((def) => this.toPublic(def, vault));
  }

  getDefaultId(): string | null {
    return this.loadVault().default_provider_id;
  }

  setDefault(id: string | null): ProviderPublicStatus[] {
    const vault = this.loadVault();
    if (id && (!vault.entries[id] || !this.isUsableEntry(id, vault.entries[id]))) {
      throw new ProviderError('PROVIDER_NOT_CONFIGURED', '키가 등록된 프로바이더만 기본으로 설정할 수 있습니다.');
    }
    vault.default_provider_id = id;
    this.saveVault(vault);
    return this.listPublic();
  }

  /**
   * Register a personal OpenAI- or Anthropic-compatible endpoint.
   */
  createUserProvider(input: {
    name: string;
    base_url: string;
    model_id: string;
    api_key: string;
    compatibility: ProviderCompatibility;
  }): ProviderPublicStatus[] {
    const name = input.name.trim() || 'Personal API';
    const baseUrl = input.base_url.trim().replace(/\/$/, '');
    const modelId = input.model_id.trim();
    const apiKey = sanitizeApiKey(input.api_key);
    const compatibility = input.compatibility;
    if (!baseUrl) throw new ProviderError('BASE_URL_REQUIRED', 'Base URL을 입력하세요.');
    if (!modelId) throw new ProviderError('MODEL_ID_REQUIRED', '모델 ID를 입력하세요.');
    if (!apiKey) throw new ProviderError('API_KEY_EMPTY', 'API 키를 입력하세요.');
    if (compatibility !== 'openai' && compatibility !== 'anthropic') {
      throw new ProviderError('COMPATIBILITY_REQUIRED', 'OpenAI 호환 또는 Anthropic 호환을 선택하세요.');
    }
    try {
      // eslint-disable-next-line no-new
      new URL(baseUrl);
    } catch {
      throw new ProviderError('BASE_URL_INVALID', 'Base URL 형식이 올바르지 않습니다.');
    }

    const vault = this.loadVault();
    const id = `user_${slugifyProviderName(name)}_${Math.random().toString(36).slice(2, 7)}`;
    vault.user_defs = vault.user_defs ?? {};
    vault.user_defs[id] = {
      name,
      base_url: baseUrl,
      default_model: modelId,
      compatibility,
      created_at: new Date().toISOString(),
    };
    vault.entries[id] = {
      api_key: apiKey,
      base_url: baseUrl,
      model_id: modelId,
      wire_api: enforcedProviderWireApi(this.userMetaToDef(id, vault.user_defs[id]), modelId) ?? undefined,
      tool_protocol: undefined,
      updated_at: new Date().toISOString(),
    };
    if (!vault.default_provider_id) vault.default_provider_id = id;
    this.persistSecrets(vault);
    return this.listPublic();
  }

  /** Remove a user-defined provider (meta + key). */
  deleteUserProvider(id: string): ProviderPublicStatus[] {
    if (!isUserProviderId(id)) {
      throw new ProviderError('PROVIDER_NOT_USER', '개인 추가 프로바이더만 삭제할 수 있습니다.');
    }
    const vault = this.loadVault();
    if (vault.user_defs) delete vault.user_defs[id];
    delete vault.entries[id];
    if (vault.default_provider_id === id) {
      vault.default_provider_id = Object.keys(vault.entries)[0] ?? null;
    }
    this.persistSecrets(vault);
    return this.listPublic();
  }

  saveKey(
    id: string,
    apiKey: string,
    opts?: {
      base_url?: string;
      model_id?: string;
      name?: string;
      wire_api?: import('./types.js').ProviderWireApi;
      tool_protocol?: import('./types.js').ProviderToolProtocol;
    },
  ): ProviderPublicStatus[] {
    const def = this.getDefinition(id);
    if (!def) throw new ProviderError('PROVIDER_UNKNOWN', `Unknown provider: ${id}`);

    const vault = this.loadVault();
    const existing = vault.entries[id];
    const existingUsable = existing && this.isUsableEntry(id, existing) ? existing : undefined;
    const trimmed = sanitizeApiKey(apiKey);

    if (!trimmed && !existingUsable) {
      throw new ProviderError('API_KEY_EMPTY', 'API 키를 입력하세요.');
    }

    const companyFixed = id === COMPANY_PROVIDER_ID;
    const nextBase = companyFixed
      ? COMPANY_OPENROUTER_BASE_URL
      : opts?.base_url?.trim() || existingUsable?.base_url || def.base_url;
    const nextModel = opts?.model_id?.trim() || existingUsable?.model_id || def.default_model;
    const routeChanged = Boolean(
      existingUsable
      && (
        nextBase.replace(/\/$/, '') !== (existingUsable.base_url || def.base_url).replace(/\/$/, '')
        || nextModel !== (existingUsable.model_id || def.default_model)
      )
    );
    const nextWireApi = knownProviderWireApi(
      { ...def, base_url: nextBase },
      nextModel,
      opts?.wire_api ?? null,
    ) ?? existingUsable?.wire_api;
    const nextToolProtocol = nextWireApi !== 'chat_completions'
      ? opts?.tool_protocol === 'native'
        ? 'native'
        : routeChanged
          ? undefined
          : existingUsable?.tool_protocol === 'native'
            ? 'native'
            : undefined
      : opts?.tool_protocol ?? (routeChanged ? undefined : existingUsable?.tool_protocol);
    if ((def.custom || def.user_defined) && !nextBase) {
      throw new ProviderError('BASE_URL_REQUIRED', 'Base URL이 필요합니다.');
    }

    if (def.kind === 'search' && !def.custom && !def.base_url) {
      throw new ProviderError('BASE_URL_REQUIRED', 'Search provider misconfigured.');
    }

    if (def.user_defined && vault.user_defs?.[id]) {
      vault.user_defs[id] = {
        ...vault.user_defs[id],
        name: opts?.name?.trim() || vault.user_defs[id].name,
        base_url: nextBase.replace(/\/$/, ''),
        default_model:
          nextModel || vault.user_defs[id].default_model,
        wire_api: nextWireApi,
      };
    }

    vault.entries[id] = {
      api_key: trimmed || existingUsable!.api_key,
      base_url: nextBase.replace(/\/$/, ''),
      model_id: nextModel,
      wire_api: nextWireApi,
      tool_protocol: nextToolProtocol,
      updated_at: new Date().toISOString(),
    };
    if (!vault.default_provider_id) vault.default_provider_id = id;
    this.persistSecrets(vault);
    return this.listPublic();
  }

  deleteKey(id: string): ProviderPublicStatus[] {
    if (isUserProviderId(id)) {
      return this.deleteUserProvider(id);
    }
    const vault = this.loadVault();
    delete vault.entries[id];
    if (vault.default_provider_id === id) {
      vault.default_provider_id = Object.keys(vault.entries)[0] ?? null;
    }
    this.persistSecrets(vault);
    return this.listPublic();
  }

  getSecret(id: string): ProviderSecretEntry | null {
    const entry = this.loadVault().entries[id];
    return entry && this.isUsableEntry(id, entry) ? entry : null;
  }

  getConfiguredIds(): string[] {
    const entries = this.loadVault().entries;
    return Object.keys(entries).filter((id) => this.isUsableEntry(id, entries[id]));
  }

  hasAnyKeys(): boolean {
    return this.getConfiguredIds().length > 0;
  }

  /** Re-encrypt legacy machine-derived rows with the OS-protected envelope key. */
  migrateVaultIfNeeded(): { migrated: boolean; entryIds: string[]; decryptFailures: string[] } {
    const raw = this.readRawVaultFile();
    if (!raw?.entries) {
      return { migrated: false, entryIds: [], decryptFailures: [] };
    }
    const vault = this.loadVault();
    const entryIds = Object.keys(vault.entries);
    const decryptFailures = Object.keys(raw.entries).filter((id) => !vault.entries[id]);
    let migrated = false;
    for (const id of entryIds) {
      const row = raw.entries[id];
      if (!row?.api_key_enc) continue;
      const cipher = row.cipher ?? (raw.version >= 2 ? 'envelope-v2' : 'legacy-v1');
      const { plaintext } = this.decryptRowKeyWithMeta(row.api_key_enc, cipher);
      if (plaintext && cipher !== 'envelope-v2') migrated = true;
    }
    if (migrated) {
      this.persistSecrets(vault, { preserveRawIds: decryptFailures });
    }
    return { migrated, entryIds, decryptFailures };
  }

  getVaultDiagnostics(): {
    vault_exists: boolean;
    raw_entry_ids: string[];
    loaded_entry_ids: string[];
    custom_configured: boolean;
    user_provider_ids: string[];
    secret_backend: import('./os-secret-store.js').SecretStoreBackend;
  } {
    const raw = this.readRawVaultFile();
    const vault = this.loadVault();
    return {
      vault_exists: existsSync(this.vaultPath),
      raw_entry_ids: Object.keys(raw?.entries ?? {}),
      loaded_entry_ids: Object.keys(vault.entries),
      custom_configured: Boolean(vault.entries.custom && this.isUsableEntry('custom', vault.entries.custom)),
      user_provider_ids: Object.keys(vault.user_defs ?? {}),
      secret_backend: this.masterKeyStore.backend,
    };
  }

  resolveProvider(
    providerId: string,
    modelOverride?: string,
  ): {
    def: ProviderDefinition;
    secret: ProviderSecretEntry;
    modelId: string;
    baseUrl: string;
    wireApi: import('./types.js').ProviderWireApi;
    toolProtocol: import('./types.js').ProviderToolProtocol;
  } | null {
    const def = this.getDefinition(providerId);
    const secret = this.getSecret(providerId);
    if (!def || !secret) return null;
    const baseUrl = (secret.base_url || def.base_url).replace(/\/$/, '');
    const modelId =
      modelOverride?.trim() ||
      secret.model_id?.trim() ||
      def.default_model ||
      (def.kind === 'search' ? 'search' : '');
    const wireApi = secret.wire_api ?? determineProviderWireApi(def, modelId);
    const toolProtocol = wireApi !== 'chat_completions'
      ? 'native'
      : secret.tool_protocol
        ?? (def.kind === 'search' || providerId === 'ollama' || def.local_only_ok === true ? 'text' : 'native');
    if (def.kind === 'search') {
      if (!baseUrl || !secret.api_key) return null;
      return { def, secret, modelId: modelId || 'search', baseUrl, wireApi, toolProtocol };
    }
    if (!baseUrl || !secret.api_key || !modelId) return null;
    return { def, secret, modelId, baseUrl, wireApi, toolProtocol };
  }

  private userMetaToDef(id: string, meta: UserProviderMeta): ProviderDefinition {
    return {
      id,
      name: meta.name,
      kind: 'openai_compatible',
      base_url: meta.base_url,
      default_model: meta.default_model,
      wire_api: meta.wire_api,
      compatibility: meta.compatibility,
      user_defined: true,
      note: meta.compatibility === 'anthropic' ? '개인 Anthropic 호환 API' : '개인 OpenAI 호환 API',
    };
  }

  private readRawVaultFile(): EncryptedVaultFile | null {
    if (!existsSync(this.vaultPath)) return null;
    try {
      return JSON.parse(readFileSync(this.vaultPath, 'utf8')) as EncryptedVaultFile;
    } catch {
      return null;
    }
  }

  private loadVault(): ProviderVaultFile {
    const encDoc = this.readRawVaultFile();
    if (!encDoc) {
      return { version: 1, default_provider_id: null, entries: {}, user_defs: {} };
    }
    try {
      const entries: Record<string, ProviderSecretEntry> = {};
      for (const [id, row] of Object.entries(encDoc.entries ?? {})) {
        const cipher = row.cipher ?? (encDoc.version >= 2 ? 'envelope-v2' : 'legacy-v1');
        const apiKey = this.decryptRowKey(row.api_key_enc, cipher);
        if (apiKey == null) continue;
        entries[id] = {
          // Heal keys stored before sanitizing existed, without a re-entry round trip.
          api_key: sanitizeApiKey(apiKey),
          base_url: row.base_url,
          model_id: row.model_id,
          wire_api: row.wire_api,
          tool_protocol: row.tool_protocol,
          updated_at: row.updated_at,
        };
      }
      return {
        version: 1,
        default_provider_id: this.sanitizeDefaultId(encDoc.default_provider_id, entries),
        entries,
        user_defs: encDoc.user_defs ?? {},
      };
    } catch {
      return { version: 1, default_provider_id: null, entries: {}, user_defs: {} };
    }
  }

  private persistSecrets(
    vault: ProviderVaultFile,
    opts?: { preserveRawIds?: string[] },
  ): void {
    const existing = this.readRawVaultFile();
    const preserve = new Set(opts?.preserveRawIds ?? []);
    const encDoc: EncryptedVaultFile = {
      version: 2,
      default_provider_id: this.sanitizeDefaultId(vault.default_provider_id, vault.entries),
      entries: {},
      user_defs: vault.user_defs ?? {},
    };
    if (existing?.entries) {
      for (const [id, row] of Object.entries(existing.entries)) {
        if (preserve.has(id) && !vault.entries[id] && row?.api_key_enc) {
          encDoc.entries[id] = {
            api_key_enc: row.api_key_enc,
            cipher: row.cipher ?? (existing.version >= 2 ? 'envelope-v2' : 'legacy-v1'),
            base_url: row.base_url,
            model_id: row.model_id,
            wire_api: row.wire_api,
            tool_protocol: row.tool_protocol,
            updated_at: row.updated_at,
          };
        }
      }
    }
    const masterKey = this.masterKeyStore.getOrCreate();
    for (const [id, entry] of Object.entries(vault.entries)) {
      encDoc.entries[id] = {
        api_key_enc: encryptSecretWithKey(entry.api_key, masterKey),
        cipher: 'envelope-v2',
        base_url: entry.base_url,
        model_id: entry.model_id,
        wire_api: entry.wire_api,
        tool_protocol: entry.tool_protocol,
        updated_at: entry.updated_at,
      };
    }
    encDoc.default_provider_id = this.sanitizeDefaultId(encDoc.default_provider_id, encDoc.entries);
    assertWritablePath(this.vaultPath, this.cqrRoot);
    writeFileSync(this.vaultPath, JSON.stringify(encDoc, null, 2) + '\n', 'utf8');
  }

  private sanitizeDefaultId(
    defaultId: string | null | undefined,
    entries: Record<string, unknown>,
  ): string | null {
    if (defaultId && entries[defaultId] && this.isUsableEntry(defaultId, entries[defaultId] as ProviderSecretEntry)) return defaultId;
    const ids = Object.keys(entries).filter((id) => this.isUsableEntry(id, entries[id] as ProviderSecretEntry));
    return ids[0] ?? null;
  }

  /** Never reuse a legacy Open WebUI credential against the new OpenRouter host. */
  private isUsableEntry(id: string, entry: ProviderSecretEntry): boolean {
    if (id !== COMPANY_PROVIDER_ID) return true;
    return isCompanyOpenRouterBaseUrl(entry.base_url);
  }

  private decryptRowKey(blob: string, cipher: 'envelope-v2' | 'legacy-v1'): string | null {
    return this.decryptRowKeyWithMeta(blob, cipher).plaintext;
  }

  private decryptRowKeyWithMeta(
    blob: string,
    cipher: 'envelope-v2' | 'legacy-v1',
  ): { plaintext: string | null; machineId: string | null } {
    if (cipher === 'envelope-v2') {
      // OS credential helpers can fail transiently during desktop startup. A single
      // failure must not be downgraded to "provider not configured" when the vault
      // and encrypted key are present.
      for (let attempt = 1; attempt <= ENVELOPE_DECRYPT_ATTEMPTS; attempt += 1) {
        try {
          return { plaintext: decryptSecretWithKey(blob, this.masterKeyStore.getOrCreate()), machineId: null };
        } catch {
          if (attempt === ENVELOPE_DECRYPT_ATTEMPTS) {
            return { plaintext: null, machineId: null };
          }
        }
      }
    }
    for (const mid of this.machineIds) {
      try {
        return { plaintext: decryptSecret(blob, mid), machineId: mid };
      } catch {
        /* try next machine id */
      }
    }
    return { plaintext: null, machineId: null };
  }

  private saveVault(vault: ProviderVaultFile): void {
    this.persistSecrets(vault);
  }

  /** Migrate missing or manually overridden transports to the enforced model/endpoint contract. */
  private migrateKnownWireApis(): void {
    if (!existsSync(this.vaultPath)) return;
    const vault = this.loadVault();
    let changed = false;
    for (const [id, entry] of Object.entries(vault.entries)) {
      const def = getProviderDef(
        [...this.catalog, ...Object.entries(vault.user_defs ?? {}).map(([userId, meta]) => this.userMetaToDef(userId, meta))],
        id,
      );
      if (!def) continue;
      const enforced = enforcedProviderWireApi(def, entry.model_id ?? def.default_model);
      if (enforced && entry.wire_api !== enforced) {
        entry.wire_api = enforced;
        if (vault.user_defs?.[id]) vault.user_defs[id].wire_api = enforced;
        changed = true;
      }
      const effectiveWire = enforced ?? entry.wire_api ?? determineProviderWireApi(def, entry.model_id ?? def.default_model);
      if (effectiveWire !== 'chat_completions' && entry.tool_protocol === 'text') {
        // A cloud-native contract failure must be re-tested, never preserved as TEXT fallback.
        delete entry.tool_protocol;
        changed = true;
      }
    }
    if (changed) this.persistSecrets(vault);
  }

  private toPublic(def: ProviderDefinition, vault: ProviderVaultFile): ProviderPublicStatus {
    const entry = vault.entries[def.id];
    const usableEntry = entry && this.isUsableEntry(def.id, entry) ? entry : undefined;
    const wireApi = usableEntry?.wire_api ?? determineProviderWireApi(def, usableEntry?.model_id ?? def.default_model);
    return {
      id: def.id,
      name: def.name,
      kind: def.kind,
      base_url: usableEntry?.base_url || def.base_url,
      default_model: def.default_model,
      custom: def.custom,
      user_defined: def.user_defined,
      compatibility: def.compatibility,
      docs_url: def.docs_url,
      note: def.note,
      wire_api: wireApi,
      wire_api_confirmed: Boolean(
        usableEntry?.wire_api || knownProviderWireApi(def, usableEntry?.model_id ?? def.default_model),
      ),
      tool_protocol:
        wireApi !== 'chat_completions'
          ? 'native'
          : usableEntry?.tool_protocol
            ?? (def.kind === 'search' || def.id === 'ollama' || def.local_only_ok === true ? 'text' : 'native'),
      tool_protocol_confirmed: Boolean(
        usableEntry?.tool_protocol
        || def.kind === 'search'
        || def.id === 'openai'
        || def.id === 'anthropic'
        || def.id === 'ollama',
      ),
      secret_storage: 'local_encrypted',
      secret_backend: this.masterKeyStore.backend,
      configured: Boolean(usableEntry),
      is_default: Boolean(usableEntry) && vault.default_provider_id === def.id,
      model_id: usableEntry?.model_id ?? null,
      key_hint: usableEntry ? keyHint(usableEntry.api_key) : null,
      updated_at: usableEntry?.updated_at ?? null,
    };
  }
}
