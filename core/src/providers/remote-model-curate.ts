import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatMode } from '../router/types.js';

export type ModelCategoryId = 'general' | 'coding' | 'reasoning' | 'image' | 'fast' | 'longctx';

export interface ModeModelRule {
  primary: string;
  fallbacks?: string[];
}

export interface CurateConfig {
  version: number;
  max_models: number;
  openrouter_prefix: string;
  hard_exclude: string[];
  exclude_patterns: string[];
  /** Matrix models always included in the curated picker when available remotely. */
  pinned_suffixes?: string[];
  /** When true, picker shows only pinned_suffixes (workspace matrix), no quota fill. */
  matrix_only?: boolean;
  /** Per-mode primary + failover suffixes (provider.model, without openrouter prefix). */
  mode_models?: Partial<Record<ChatMode, ModeModelRule>>;
  /** Within each family, keep only the highest-priority available models (newest-first lists). */
  model_families?: ModelFamilyRule[];
  categories: Record<ModelCategoryId, { patterns: string[] }>;
  category_priority: ModelCategoryId[];
  category_quotas: Partial<Record<ModelCategoryId, number>>;
  tier_patterns: Partial<Record<ModelCategoryId, { S?: string[]; A?: string[]; B?: string[] }>>;
  mode_defaults: Partial<Record<ChatMode, ModelCategoryId>>;
  default_model_suffix: string;
  /** Fallback suffixes when default_model_suffix model is absent. */
  default_model_suffix_fallbacks?: string[];
}

export interface ModelFamilyRule {
  match: string[];
  max_keep: number;
  /** Skip candidates containing these substrings when a cleaner alternative exists in the family. */
  prefer_drop?: string[];
}

export interface CuratedModel {
  id: string;
  displayName: string;
  category: ModelCategoryId;
  tier: 'S' | 'A' | 'B' | 'C';
}

export interface ModeHint {
  value: string;
  label: string;
  modelId: string;
}

let cachedConfig: CurateConfig | null = null;

function configPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, '..', '..', 'config', 'defaults', 'openwebui-model-curate.json'),
    path.join(here, '..', 'config', 'defaults', 'openwebui-model-curate.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0];
}

const MATRIX_ONLY_OFF_VALUES = new Set(['0', 'off', 'false', 'none', 'disabled']);

export function loadCurateConfig(force = false): CurateConfig {
  if (cachedConfig && !force) return cachedConfig;
  const doc = JSON.parse(readFileSync(configPath(), 'utf8')) as CurateConfig;
  // Escape hatch for verify runs and support sessions: exercise the full curation pipeline
  // (family dedupe, exclusions, category labels, quota fill) instead of the deploy matrix.
  const override = process.env.MY_AGENT_MODEL_CURATE_MATRIX_ONLY?.trim().toLowerCase();
  if (override) doc.matrix_only = !MATRIX_ONLY_OFF_VALUES.has(override);
  cachedConfig = doc;
  return cachedConfig;
}

export function shortModelName(modelId: string, cfg = loadCurateConfig()): string {
  const raw = modelId.startsWith(cfg.openrouter_prefix)
    ? modelId.slice(cfg.openrouter_prefix.length)
    : modelId;
  const slash = raw.lastIndexOf('/');
  if (slash >= 0) return raw.slice(slash + 1);
  const dot = raw.indexOf('.');
  return dot >= 0 ? raw.slice(dot + 1) : raw;
}

function matchesAny(text: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    try {
      return new RegExp(p, 'i').test(text);
    } catch {
      return text.toLowerCase().includes(p.toLowerCase());
    }
  });
}

function tierScore(modelId: string, category: ModelCategoryId, cfg: CurateConfig): number {
  const short = shortModelName(modelId, cfg);
  const tiers = cfg.tier_patterns[category];
  if (!tiers) return 99;
  if (tiers.S?.some((p) => short.includes(p) || modelId.includes(p))) return 0;
  if (tiers.A?.some((p) => short.includes(p) || modelId.includes(p))) return 1;
  if (tiers.B?.some((p) => short.includes(p) || modelId.includes(p))) return 2;
  return 3;
}

export function classifyModel(modelId: string, cfg = loadCurateConfig()): ModelCategoryId {
  const hay = `${modelId} ${shortModelName(modelId, cfg)}`;
  for (const cat of cfg.category_priority) {
    if (cat === 'general') continue;
    const def = cfg.categories[cat];
    if (def && matchesAny(hay, def.patterns)) return cat;
  }
  return 'general';
}

export function shouldExcludeModel(modelId: string, cfg = loadCurateConfig()): boolean {
  if (cfg.hard_exclude.includes(modelId)) return true;
  const hay = `${modelId} ${shortModelName(modelId, cfg)}`;
  return cfg.exclude_patterns.some((p) => {
    try {
      return new RegExp(p, 'i').test(hay);
    } catch {
      return hay.toLowerCase().includes(p.toLowerCase());
    }
  });
}

function familyPatternIndex(modelId: string, pattern: string, cfg: CurateConfig): number {
  const short = shortModelName(modelId, cfg);
  const hay = `${modelId} ${short}`.toLowerCase();
  const p = pattern.toLowerCase();
  return hay.includes(p) ? pattern.length : -1;
}

function modelMatchesFamily(modelId: string, pattern: string, cfg: CurateConfig): boolean {
  return familyPatternIndex(modelId, pattern, cfg) >= 0;
}

/** Keep only the newest / best variant per model family when multiple generations coexist. */
export function applyFamilyDedupe(modelIds: string[], cfg = loadCurateConfig()): string[] {
  const families = cfg.model_families;
  if (!families?.length) return modelIds;

  const excluded = new Set<string>();

  for (const family of families) {
    const candidates: { id: string; priority: number }[] = [];
    for (const id of modelIds) {
      if (excluded.has(id) || shouldExcludeModel(id, cfg)) continue;
      let bestPriority = Number.POSITIVE_INFINITY;
      for (let i = 0; i < family.match.length; i++) {
        if (modelMatchesFamily(id, family.match[i], cfg)) {
          bestPriority = Math.min(bestPriority, i);
        }
      }
      if (bestPriority < Number.POSITIVE_INFINITY) {
        candidates.push({ id, priority: bestPriority });
      }
    }
    if (!candidates.length) continue;

    candidates.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return shortModelName(a.id, cfg).localeCompare(shortModelName(b.id, cfg));
    });

    const preferDrop = family.prefer_drop ?? [];
    const withoutDrop = candidates.filter(
      (c) => !preferDrop.some((p) => shortModelName(c.id, cfg).includes(p) || c.id.includes(p)),
    );
    const pool = withoutDrop.length >= family.max_keep ? withoutDrop : candidates;
    const kept = new Set(pool.slice(0, family.max_keep).map((c) => c.id));
    for (const c of candidates) {
      if (!kept.has(c.id)) excluded.add(c.id);
    }
  }

  return modelIds.filter((id) => !excluded.has(id));
}

function toCuratedEntry(id: string, cfg: CurateConfig): CuratedModel {
  const category = classifyModel(id, cfg);
  return {
    id,
    displayName: shortModelName(id, cfg),
    category,
    tier: (['S', 'A', 'B', 'C'] as const)[tierScore(id, category, cfg)] ?? 'C',
  };
}

/** Convert the former OWUI `provider.model` suffix to OpenRouter's canonical `provider/model`. */
function canonicalOpenRouterModelId(value: string): string {
  if (value.includes('/')) return value;
  const match = /^([a-z0-9-]+)\.(.+)$/i.exec(value);
  return match ? `${match[1]}/${match[2]}` : value;
}

export function normalizeCompanyModelId(value: string, cfg = loadCurateConfig()): string {
  const withoutLegacyProxy = value.replace(/^open_webui_openrouter_integration\./, '');
  const unwrapped = cfg.openrouter_prefix && withoutLegacyProxy.startsWith(cfg.openrouter_prefix)
    ? withoutLegacyProxy.slice(cfg.openrouter_prefix.length)
    : withoutLegacyProxy;
  return canonicalOpenRouterModelId(unwrapped);
}

/** Stable product defaults available before the first remote model-list request. */
export function defaultCompanyModelIds(cfg = loadCurateConfig()): string[] {
  return (cfg.pinned_suffixes ?? []).map((suffix) => normalizeCompanyModelId(suffix, cfg));
}

/** Describe an explicit user selection without applying matrix quotas or family pruning. */
export function describeRemoteModels(modelIds: string[], cfg = loadCurateConfig()): CuratedModel[] {
  const seen = new Set<string>();
  return modelIds
    .map((id) => normalizeCompanyModelId(id, cfg))
    .filter((id) => {
      if (!id || seen.has(id) || shouldExcludeModel(id, cfg)) return false;
      seen.add(id);
      return true;
    })
    .map((id) => toCuratedEntry(id, cfg));
}

function resolveModelIdBySuffix(modelIds: string[], suffix: string, cfg: CurateConfig): string | null {
  const full = normalizeCompanyModelId(suffix, cfg);
  if (modelIds.includes(full)) return full;
  return modelIds.find((id) => id.endsWith(full) || id.endsWith(suffix)) ?? null;
}

function resolvePinnedModels(modelIds: string[], cfg: CurateConfig): CuratedModel[] {
  const pinned: CuratedModel[] = [];
  for (const suffix of cfg.pinned_suffixes ?? []) {
    const id = resolveModelIdBySuffix(modelIds, suffix, cfg);
    if (!id || shouldExcludeModel(id, cfg)) continue;
    if (pinned.some((m) => m.id === id)) continue;
    pinned.push(toCuratedEntry(id, cfg));
  }
  return pinned;
}

export function curateRemoteModels(modelIds: string[], cfg = loadCurateConfig()): CuratedModel[] {
  const pinned = resolvePinnedModels(modelIds, cfg);
  if (cfg.matrix_only) return pinned;

  const deduped = applyFamilyDedupe(modelIds, cfg);
  const filtered = deduped.filter((id) => !shouldExcludeModel(id, cfg));
  const scored = filtered.map((id) => ({
    ...toCuratedEntry(id, cfg),
    tierNum: tierScore(id, classifyModel(id, cfg), cfg),
  }));

  scored.sort((a, b) => {
    if (a.tierNum !== b.tierNum) return a.tierNum - b.tierNum;
    return a.displayName.localeCompare(b.displayName);
  });

  const picked: CuratedModel[] = [];
  const counts: Partial<Record<ModelCategoryId, number>> = {};

  const addPick = (m: CuratedModel, ignoreQuota = false) => {
    if (picked.length >= cfg.max_models) return false;
    if (picked.some((x) => x.id === m.id)) return false;
    const quota = cfg.category_quotas[m.category];
    const used = counts[m.category] ?? 0;
    if (!ignoreQuota && quota != null && used >= quota) return false;
    picked.push({
      id: m.id,
      displayName: m.displayName,
      category: m.category,
      tier: m.tier,
    });
    counts[m.category] = used + 1;
    return true;
  };

  for (const m of pinned) addPick(m, true);

  const tryPick = (m: (typeof scored)[number]) => addPick(m, false);

  for (const m of scored) tryPick(m);
  if (picked.length < cfg.max_models) {
    for (const m of scored) {
      if (picked.length >= cfg.max_models) break;
      if (!picked.some((x) => x.id === m.id)) tryPick(m);
    }
  }

  return picked;
}

export function resolveDefaultOwuiModel(
  modelIds: string[],
  cfg = loadCurateConfig(),
): string | null {
  const suffixes = [cfg.default_model_suffix, ...(cfg.default_model_suffix_fallbacks ?? [])];
  for (const suffix of suffixes) {
    const exact = resolveModelIdBySuffix(modelIds, suffix, cfg);
    if (exact) return exact;
  }
  const curated = curateRemoteModels(modelIds, cfg);
  const general = curated.find((m) => m.category === 'general');
  return general?.id ?? curated[0]?.id ?? null;
}

export function pickModelForMode(
  mode: ChatMode,
  curated: CuratedModel[],
  opts?: { hasAttachments?: boolean },
  cfg = loadCurateConfig(),
): CuratedModel | null {
  if (!curated.length) return null;

  if (opts?.hasAttachments) {
    const long = curated.filter((m) => m.category === 'longctx');
    if (long[0]) return long[0];
  }

  const modeRule = cfg.mode_models?.[mode];
  if (modeRule) {
    const suffixes = [modeRule.primary, ...(modeRule.fallbacks ?? [])];
    for (const suffix of suffixes) {
      const resolvedId = resolveModelIdBySuffix(curated.map((m) => m.id), suffix, cfg);
      const hit = resolvedId ? curated.find((m) => m.id === resolvedId) : undefined;
      if (hit) return hit;
    }
  }

  const cat = cfg.mode_defaults[mode] ?? 'general';
  const inCat = curated.filter((m) => m.category === cat);
  if (inCat[0]) return inCat[0];

  const general = curated.filter((m) => m.category === 'general');
  return general[0] ?? curated[0];
}

/** Primary + failover model IDs for a chat mode (matrix order). */
export function resolveModelChainForMode(
  mode: ChatMode,
  modelIds: string[],
  cfg = loadCurateConfig(),
): string[] {
  const rule = cfg.mode_models?.[mode];
  if (!rule) return [];
  const suffixes = [rule.primary, ...(rule.fallbacks ?? [])];
  const chain: string[] = [];
  for (const suffix of suffixes) {
    const id = resolveModelIdBySuffix(modelIds, suffix, cfg);
    if (id && !chain.includes(id)) chain.push(id);
  }
  return chain;
}

export function buildModeHints(
  providerId: string,
  curated: CuratedModel[],
  cfg = loadCurateConfig(),
): Partial<Record<ChatMode, ModeHint>> {
  const modes: ChatMode[] = [
    'chat',
    'web_dev',
    'web_landing',
    'prompt_master',
    'deep_research',
    'image_gen',
  ];
  const hints: Partial<Record<ChatMode, ModeHint>> = {};
  for (const mode of modes) {
    const pick = pickModelForMode(mode, curated, undefined, cfg);
    if (!pick) continue;
    hints[mode] = {
      modelId: pick.id,
      value: `provider:${providerId}@${encodeURIComponent(pick.id)}`,
      label: pick.displayName,
    };
  }
  return hints;
}
