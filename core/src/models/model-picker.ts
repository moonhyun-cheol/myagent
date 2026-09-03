import type { ModelRegistry } from './model-registry.js';
import type { UserOverrides } from '../config/user-overrides.js';
import { isProviderAllowedLocalOnly } from '../config/user-overrides.js';
import type { ProviderStore } from '../providers/provider-store.js';
import type { ResolvedModelRoute } from '../providers/types.js';
import { listRemoteModelsDetailed, type RemoteModelInfo } from '../providers/openai-compatible.js';
import type { ChatMode } from '../router/types.js';
import {
  buildModeHints,
  curateRemoteModels,
  defaultCompanyModelIds,
  describeRemoteModels,
  isHardExcluded,
  loadCurateConfig,
  pickModelForMode,
  type CuratedModel,
  type ModeHint,
} from '../providers/remote-model-curate.js';
import {
  listOllamaModelNames,
  peekCachedOllamaModelNames,
  resolveInstalledOllamaModel,
} from '../providers/ollama-models.js';

export interface ModelPickerOption {
  value: string;
  label: string;
  kind: 'auto' | 'provider' | 'local';
  /** Credential boundary used by the workspace model selector. */
  access_mode: 'auto' | 'managed' | 'byok' | 'local';
  provider_id?: string;
  configured?: boolean;
  category?: string;
}

export interface ModelPickerPayload {
  local_only: boolean;
  default_provider_id: string | null;
  default_llm_id: string | null;
  options: ModelPickerOption[];
  remote_model_errors?: Record<string, string>;
  mode_hints?: Partial<Record<ChatMode, ModeHint>>;
  remote_models_total?: Record<string, number>;
  remote_models_shown?: Record<string, number>;
  company_models?: {
    source: 'default' | 'personalized';
    selected: string[];
    defaults: string[];
    available: string[];
    /** Install-time featured set that drives the compact discovery view. */
    featured: string[];
    /** Newest remotely published models when the provider exposes publication time. */
    recent: string[];
  };
}

export interface ResolveChatModelOptions {
  mode?: ChatMode;
  hasAttachments?: boolean;
}

const REMOTE_MODEL_CACHE_MS = 60_000;
const PRIMARY_BYOK_PROVIDER_IDS = new Set(['openai', 'anthropic', 'google']);
const remoteModelCache = new Map<
  string,
  { at: number; models: string[]; curated: CuratedModel[]; recent: string[] }
>();

/** Keep discovery compact and use provider publication metadata instead of model-name guesses. */
export function selectRecentRemoteModelIds(models: RemoteModelInfo[], limit = 12): string[] {
  const cfg = loadCurateConfig();
  return models
    .filter((model) => model.created_at != null)
    .filter((model) => !isHardExcluded(model.id, cfg))
    .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
    .slice(0, limit)
    .map((model) => model.id);
}

export function encodeProviderModelPick(providerId: string, modelId: string): string {
  return `provider:${providerId}@${encodeURIComponent(modelId)}`;
}

export function parseProviderPreference(
  preference: string,
): { providerId: string; modelId?: string } | null {
  if (!preference.startsWith('provider:')) return null;
  const rest = preference.slice('provider:'.length);
  const at = rest.indexOf('@');
  if (at === -1) return { providerId: rest };
  return {
    providerId: rest.slice(0, at),
    modelId: decodeURIComponent(rest.slice(at + 1)),
  };
}

function ollamaPickerOptions(
  providerId: string,
  providerName: string,
  installed: string[],
  fallbackModel?: string,
): ModelPickerOption[] {
  const names = installed.length ? installed : (fallbackModel?.trim() ? [fallbackModel.trim()] : []);
  return names.map((model) => ({
    value: encodeProviderModelPick(providerId, model),
    label: `${providerName} · ${model}`,
    kind: 'provider',
    access_mode: 'local',
    provider_id: providerId,
    configured: true,
  }));
}

async function listInstalledOllamaNames(providerStore: ProviderStore): Promise<string[]> {
  const resolved = providerStore.resolveProvider('ollama');
  if (!resolved) return peekCachedOllamaModelNames();
  return listOllamaModelNames(resolved.baseUrl);
}

function remapOllamaModelId(
  providerStore: ProviderStore,
  providerId: string,
  modelId?: string,
): string | undefined {
  if (providerId !== 'ollama') return modelId;
  const resolved = providerStore.resolveProvider('ollama', modelId);
  const installed = peekCachedOllamaModelNames(resolved?.baseUrl);
  if (!installed.length) return modelId;
  const configured = modelId?.trim() || resolved?.modelId || '';
  return resolveInstalledOllamaModel(configured, installed) ?? modelId;
}

function getCachedCurated(providerId: string): CuratedModel[] {
  return remoteModelCache.get(providerId)?.curated ?? [];
}

function getCachedRemote(providerId: string): { models: string[]; curated: CuratedModel[]; recent: string[] } {
  const cached = remoteModelCache.get(providerId);
  return cached
    ? { models: cached.models, curated: cached.curated, recent: cached.recent }
    : { models: [], curated: [], recent: [] };
}

async function fetchRemoteModelsForProvider(
  providerStore: ProviderStore,
  providerId: string,
): Promise<{ models: string[]; curated: CuratedModel[]; recent: string[]; error?: string }> {
  const cached = remoteModelCache.get(providerId);
  if (cached && Date.now() - cached.at < REMOTE_MODEL_CACHE_MS) {
    return { models: cached.models, curated: cached.curated, recent: cached.recent };
  }
  const secret = providerStore.getSecret(providerId);
  const def = providerStore.getDefinition(providerId);
  if (!secret || !def?.custom) return { models: [], curated: [], recent: [] };
  const baseUrl = (secret.base_url || def.base_url).replace(/\/$/, '');
  if (!baseUrl || !secret.api_key) return { models: [], curated: [], recent: [] };
  try {
    const remoteModels = await listRemoteModelsDetailed(baseUrl, secret.api_key);
    const models = remoteModels.map((model) => model.id);
    const recent = selectRecentRemoteModelIds(remoteModels);
    const curated = curateRemoteModels(models);
    // Empty lists can be transient — do not pin them for the full TTL.
    if (models.length > 0) {
      remoteModelCache.set(providerId, { at: Date.now(), models, curated, recent });
    } else {
      remoteModelCache.delete(providerId);
    }
    return { models, curated, recent };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    remoteModelCache.delete(providerId);
    return { models: [], curated: [], recent: [], error: msg };
  }
}

export function invalidateRemoteModelCache(providerId?: string): void {
  if (providerId) remoteModelCache.delete(providerId);
  else remoteModelCache.clear();
}

export async function buildModelPicker(
  registry: ModelRegistry,
  overrides: UserOverrides,
  providerStore: ProviderStore,
  opts?: { refreshRemote?: boolean },
): Promise<ModelPickerPayload> {
  const doc = registry.load();
  const localOnly = overrides.local_only === true;
  const catalog = providerStore.listDefinitions();
  const configured = new Set(providerStore.getConfiguredIds());
  const defaultProvider = providerStore.getDefaultId();

  const options: ModelPickerOption[] = [{
    value: 'auto',
    label: '기본 (자동)',
    kind: 'auto',
    access_mode: 'auto',
  }];
  const remoteModelErrors: Record<string, string> = {};
  const remoteModelsTotal: Record<string, number> = {};
  const remoteModelsShown: Record<string, number> = {};
  let modeHints: Partial<Record<ChatMode, ModeHint>> | undefined;
  const curateCfg = loadCurateConfig();
  const companyDefaults = defaultCompanyModelIds(curateCfg);
  const initialCompanySelection = overrides.company_model_ids?.length
    ? overrides.company_model_ids
    : companyDefaults;
  let companyModels: ModelPickerPayload['company_models'] = {
    source: overrides.company_model_ids?.length ? 'personalized' : 'default',
    selected: describeRemoteModels(initialCompanySelection, curateCfg).map((model) => model.id),
    defaults: companyDefaults,
    available: [],
    featured: companyDefaults,
    recent: [],
  };
  const matrixPickerOnly = curateCfg.matrix_only === true && !localOnly;

  if (!localOnly) {
    for (const def of catalog) {
      if (!configured.has(def.id)) continue;
      if (def.id === 'ollama') {
        const secret = providerStore.getSecret(def.id);
        const fallback = secret?.model_id || def.default_model;
        const installed = await listInstalledOllamaNames(providerStore);
        options.push(...ollamaPickerOptions(def.id, def.name, installed, fallback));
        continue;
      }
      // Matrix-only still allows personal OpenAI-compatible endpoints the user registered.
      if (
        matrixPickerOnly
        && !def.custom
        && !def.user_defined
        && !PRIMARY_BYOK_PROVIDER_IDS.has(def.id)
      ) continue;
      const secret = providerStore.getSecret(def.id);
      if (def.custom) {
        // Cold UI boot uses the encrypted vault's saved model immediately. A live /models
        // request (up to several 20s candidate probes) only runs on explicit refresh.
        const remote: { models: string[]; curated: CuratedModel[]; recent: string[]; error?: string } = opts?.refreshRemote
          ? await fetchRemoteModelsForProvider(providerStore, def.id)
          : getCachedRemote(def.id);
        if (remote.error) remoteModelErrors[def.id] = remote.error;
        remoteModelsTotal[def.id] = remote.models.length;
        const selectedIds = overrides.company_model_ids?.length
          ? overrides.company_model_ids
          : companyDefaults;
        const selectedModels = describeRemoteModels(selectedIds, curateCfg);
        remoteModelsShown[def.id] = selectedModels.length;
        modeHints = buildModeHints(def.id, selectedModels);
        companyModels = {
          source: overrides.company_model_ids?.length ? 'personalized' : 'default',
          selected: selectedModels.map((model) => model.id),
          defaults: companyDefaults,
          available: remote.models,
          featured: companyDefaults.filter((id) => remote.models.includes(id)),
          recent: remote.recent,
        };

        const remoteIds = new Set(selectedModels.map((m) => m.id));
        for (const m of selectedModels) {
          options.push({
            value: encodeProviderModelPick(def.id, m.id),
            label: m.displayName,
            kind: 'provider',
            access_mode: def.id === 'openai' ? 'byok' : 'managed',
            provider_id: def.id,
            configured: true,
            category: m.category,
          });
        }

        const savedModel = secret?.model_id?.trim();
        if (
          savedModel
          && !remoteIds.has(savedModel)
          && (!matrixPickerOnly || opts?.refreshRemote !== true)
        ) {
          const personal = curateRemoteModels([savedModel])[0] ?? {
            id: savedModel,
            displayName: savedModel,
            category: 'general' as const,
            tier: 'C' as const,
          };
          options.push({
            value: encodeProviderModelPick(def.id, savedModel),
            label: personal.displayName,
            kind: 'provider',
            access_mode: def.id === 'openai' ? 'byok' : 'managed',
            provider_id: def.id,
            configured: true,
            category: personal.category,
          });
        }

        if (selectedModels.length === 0 && !savedModel) {
          if (remote.error) {
            options.push({
              value: `provider:${def.id}`,
              label: `${def.name} · (모델 목록 실패)`,
              kind: 'provider',
              access_mode: def.id === 'openai' ? 'byok' : 'managed',
              provider_id: def.id,
              configured: true,
            });
          }
        }
        continue;
      }

      const model = secret?.model_id || def.default_model;
      if (!model) continue;
      options.push({
        value: `provider:${def.id}`,
        label: `${def.name} · ${model}`,
        kind: 'provider',
        access_mode: def.id === 'openai' ? 'byok' : 'managed',
        provider_id: def.id,
        configured: true,
      });
    }
  } else {
    for (const def of catalog) {
      if (!configured.has(def.id)) continue;
      if (!isProviderAllowedLocalOnly(def.id, catalog)) continue;
      if (def.id === 'ollama') {
        const secret = providerStore.getSecret(def.id);
        const fallback = secret?.model_id || def.default_model;
        const installed = await listInstalledOllamaNames(providerStore);
        options.push(...ollamaPickerOptions(def.id, def.name, installed, fallback));
        continue;
      }
      const secret = providerStore.getSecret(def.id);
      const model = secret?.model_id || def.default_model;
      if (!model) continue;
      options.push({
        value: `provider:${def.id}`,
        label: `${def.name} · ${model}`,
        kind: 'provider',
        access_mode: def.id === 'openai' ? 'byok' : 'managed',
        provider_id: def.id,
        configured: true,
      });
    }
  }

  if (!matrixPickerOnly) {
    for (const m of doc.models.filter((x) => x.kind === 'llm')) {
      options.push({
        value: m.id,
        label: `[로컬] ${m.filename}`,
        kind: 'local',
        access_mode: 'local',
      });
    }
  }

  return {
    local_only: localOnly,
    default_provider_id: defaultProvider,
    default_llm_id: doc.default_llm_id,
    options,
    remote_model_errors:
      Object.keys(remoteModelErrors).length > 0 ? remoteModelErrors : undefined,
    mode_hints: modeHints,
    remote_models_total:
      Object.keys(remoteModelsTotal).length > 0 ? remoteModelsTotal : undefined,
    remote_models_shown:
      Object.keys(remoteModelsShown).length > 0 ? remoteModelsShown : undefined,
    company_models: companyModels,
  };
}

function resolveAutoProviderModel(
  providerStore: ProviderStore,
  overrides: UserOverrides,
  opts?: ResolveChatModelOptions,
): ResolvedModelRoute | null {
  const defaultProvider = providerStore.getDefaultId();
  if (!defaultProvider) return null;

  const def = providerStore.getDefinition(defaultProvider);
  if (!def?.custom) {
    const secret = providerStore.getSecret(defaultProvider);
    const model = remapOllamaModelId(
      providerStore,
      defaultProvider,
      secret?.model_id || def?.default_model,
    );
    const resolved = providerStore.resolveProvider(defaultProvider, model || undefined);
    if (!resolved) return null;
    return {
      display: `${resolved.def.name}/${resolved.modelId}`,
      route: {
        type: 'provider',
        providerId: defaultProvider,
        modelId: resolved.modelId,
        baseUrl: resolved.baseUrl,
      },
    };
  }

  if (opts?.mode) {
    const curated = overrides.company_model_ids?.length
      ? describeRemoteModels(overrides.company_model_ids)
      : getCachedCurated(defaultProvider);
    if (curated.length) {
      const pick = pickModelForMode(opts.mode, curated, {
        hasAttachments: opts.hasAttachments,
      });
      if (pick) {
        const modeResolved = providerStore.resolveProvider(defaultProvider, pick.id);
        if (modeResolved) {
          return {
            display: pick.displayName,
            route: {
              type: 'provider',
              providerId: defaultProvider,
              modelId: pick.id,
              baseUrl: modeResolved.baseUrl,
            },
          };
        }
      }
    }
  }

  const secret = providerStore.getSecret(defaultProvider);
  const model = secret?.model_id || def.default_model;
  const resolved = providerStore.resolveProvider(defaultProvider, model || undefined);
  if (!resolved) return null;
  return {
    display: `${resolved.def.name}/${resolved.modelId}`,
    route: {
      type: 'provider',
      providerId: defaultProvider,
      modelId: resolved.modelId,
      baseUrl: resolved.baseUrl,
    },
  };
}

export async function warmRemoteModelCache(
  providerStore: ProviderStore,
  providerId?: string,
): Promise<void> {
  const ids = providerId
    ? [providerId]
    : providerStore.getConfiguredIds().filter((id) => {
        const def = providerStore.getDefinition(id);
        return def?.custom === true;
      });
  await Promise.all(ids.map((id) => fetchRemoteModelsForProvider(providerStore, id)));
}

export async function resolveChatModelAsync(
  preference: string | undefined,
  registry: ModelRegistry,
  overrides: UserOverrides,
  providerStore: ProviderStore,
  opts?: ResolveChatModelOptions,
): Promise<ResolvedModelRoute> {
  const localOnly = overrides.local_only === true;
  if ((preference === 'auto' || !preference) && opts?.mode && !localOnly) {
    await warmRemoteModelCache(providerStore);
  }
  if (preference === 'auto' || !preference || preference.startsWith('provider:ollama')) {
    const ollama = providerStore.resolveProvider('ollama');
    if (ollama) await listOllamaModelNames(ollama.baseUrl);
  }
  return resolveChatModel(preference, registry, overrides, providerStore, opts);
}

export function resolveChatModel(
  preference: string | undefined,
  registry: ModelRegistry,
  overrides: UserOverrides,
  providerStore: ProviderStore,
  opts?: ResolveChatModelOptions,
): ResolvedModelRoute {
  const doc = registry.load();
  const localOnly = overrides.local_only === true;
  const defaultLlm = doc.default_llm_id
    ? doc.models.find((m) => m.id === doc.default_llm_id)
    : null;
  const defaultProvider = providerStore.getDefaultId();

  const pickProvider = (providerId: string, modelOverride?: string): ResolvedModelRoute | null => {
    if (localOnly && !isProviderAllowedLocalOnly(providerId, providerStore.listDefinitions())) {
      return null;
    }
    const modelId = remapOllamaModelId(providerStore, providerId, modelOverride);
    const resolved = providerStore.resolveProvider(providerId, modelId);
    if (!resolved) return null;
    return {
      display: `${resolved.def.name}/${resolved.modelId}`,
      route: {
        type: 'provider',
        providerId,
        modelId: resolved.modelId,
        baseUrl: resolved.baseUrl,
      },
    };
  };

  const parsed = preference ? parseProviderPreference(preference) : null;
  if (parsed && preference !== 'auto') {
    const picked = pickProvider(parsed.providerId, parsed.modelId);
    if (picked) return picked;
  }

  if (preference && preference !== 'auto' && !preference.startsWith('provider:')) {
    const local = doc.models.find((m) => m.id === preference && m.kind === 'llm');
    if (local) {
      return {
        display: `local:${local.filename}`,
        route: { type: 'local', modelId: local.id, path: local.path, filename: local.filename },
      };
    }
  }

  if (preference === 'auto' || !preference) {
    if (!localOnly) {
      const autoPicked = resolveAutoProviderModel(providerStore, overrides, opts);
      if (autoPicked) return autoPicked;

      if (defaultProvider) {
        const secret = providerStore.getSecret(defaultProvider);
        const def = providerStore.getDefinition(defaultProvider);
        const defaultModel = secret?.model_id || def?.default_model;
        const picked = pickProvider(defaultProvider, defaultModel || undefined);
        if (picked) return picked;
      }
    }
    if (defaultLlm) {
      return {
        display: `local:${defaultLlm.filename}`,
        route: {
          type: 'local',
          modelId: defaultLlm.id,
          path: defaultLlm.path,
          filename: defaultLlm.filename,
        },
      };
    }
    if (!localOnly) {
      const first = providerStore.getConfiguredIds()[0];
      if (first) {
        const picked = pickProvider(first);
        if (picked) return picked;
      }
    }
  }

  if (overrides.default_model && overrides.default_model !== 'auto') {
    const ovrParsed = parseProviderPreference(overrides.default_model);
    if (ovrParsed) {
      const picked = pickProvider(ovrParsed.providerId, ovrParsed.modelId);
      if (picked) return picked;
    }
    if (overrides.default_model === 'cloud' && defaultProvider) {
      const picked = pickProvider(defaultProvider);
      if (picked) return picked;
    }
  }

  return {
    display: 'none',
    route: {
      type: 'stub',
      reason: localOnly
        ? '로컬 모델 또는 API 키를 설정하세요.'
        : '모델 탭에서 API 키를 등록하거나 로컬 GGUF를 추가하세요.',
    },
  };
}
