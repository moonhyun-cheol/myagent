/**
 * Model context_length seeds + budget scaling for history/tool caps.
 * Remote /models meta wins over seed; unknown models fall back to 128k (flagged).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHarnessPolicy } from './harness-policy.js';

export const DEFAULT_CONTEXT_LENGTH = 128_000;
export const DEFAULT_RESERVE_TOKENS = 8_000;

export interface ModelLimitOverride {
  max_output_tokens?: number | null;
  thinking_budget?: number | null;
  reserve_tokens?: number | null;
}

export interface ModelContextLimitsDoc {
  version: number;
  default_context_length: number;
  reserve_tokens: number;
  default_max_output_tokens: number | null;
  default_thinking_budget: number | null;
  per_image_reserve_chars: number;
  limits: Record<string, number>;
  model_overrides: Record<string, ModelLimitOverride>;
}

export interface ContextBudgets {
  contextLength: number;
  /** contextLength − reserveTokens (floor 1024). */
  effectiveContextLength: number;
  reserveTokens: number;
  historyTurns: number;
  historyAssistantMaxChars: number;
  historyKeepRecent: number;
  historyCompressChars: number;
  toolResultMaxChars: number;
  /** Scale factor vs DEFAULT_CONTEXT_LENGTH (1.0 = no scale). */
  scale: number;
  /** True when neither remote nor seed matched — silent 128k must not be assumed. */
  limitsFallback: boolean;
  maxOutputTokens: number | null;
  thinkingBudget: number | null;
  perImageReserveChars: number;
}

export interface ContextLimitMismatch {
  modelId: string;
  seed: number;
  remote: number;
  note: string;
}

let cachedDoc: ModelContextLimitsDoc | null = null;

function defaultsPath(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, '..', 'config', 'defaults', 'model-context-limits.json'),
    path.join(here, '..', '..', 'config', 'defaults', 'model-context-limits.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function emptyDoc(): ModelContextLimitsDoc {
  return {
    version: 2,
    default_context_length: DEFAULT_CONTEXT_LENGTH,
    reserve_tokens: DEFAULT_RESERVE_TOKENS,
    default_max_output_tokens: null,
    default_thinking_budget: null,
    per_image_reserve_chars: 2_000,
    limits: {},
    model_overrides: {},
  };
}

export function loadModelContextLimitsDoc(): ModelContextLimitsDoc {
  if (cachedDoc) return cachedDoc;
  const p = defaultsPath();
  if (!p) {
    cachedDoc = emptyDoc();
    return cachedDoc;
  }
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<ModelContextLimitsDoc>;
    cachedDoc = {
      version: Number(raw.version) || 2,
      default_context_length:
        Number(raw.default_context_length) > 0
          ? Number(raw.default_context_length)
          : DEFAULT_CONTEXT_LENGTH,
      reserve_tokens:
        Number(raw.reserve_tokens) > 0 ? Math.floor(Number(raw.reserve_tokens)) : DEFAULT_RESERVE_TOKENS,
      default_max_output_tokens:
        typeof raw.default_max_output_tokens === 'number' && raw.default_max_output_tokens > 0
          ? Math.floor(raw.default_max_output_tokens)
          : null,
      default_thinking_budget:
        typeof raw.default_thinking_budget === 'number' && raw.default_thinking_budget > 0
          ? Math.floor(raw.default_thinking_budget)
          : null,
      per_image_reserve_chars:
        Number(raw.per_image_reserve_chars) > 0
          ? Math.floor(Number(raw.per_image_reserve_chars))
          : 2_000,
      limits: raw.limits && typeof raw.limits === 'object' ? raw.limits : {},
      model_overrides:
        raw.model_overrides && typeof raw.model_overrides === 'object' ? raw.model_overrides : {},
    };
  } catch {
    cachedDoc = emptyDoc();
  }
  return cachedDoc;
}

/** Test helper — clear seed cache. */
export function resetModelContextLimitsCache(): void {
  cachedDoc = null;
}

/** Normalize OWUI / OpenRouter style ids for seed lookup. */
export function normalizeModelIdForLimits(modelId: string): string[] {
  const raw = String(modelId || '').trim();
  if (!raw) return [];
  const keys = new Set<string>();
  const add = (s: string) => {
    const t = s.trim();
    if (!t) return;
    keys.add(t);
    keys.add(t.toLowerCase());
  };
  add(raw);
  const noPrefix = raw.replace(/^open_webui_openrouter_integration\./i, '');
  add(noPrefix);
  if (noPrefix.includes('/')) {
    const bare = noPrefix.split('/').slice(1).join('/');
    add(bare);
    add(noPrefix.replace(/\//g, '.'));
  } else if (noPrefix.includes('.')) {
    const i = noPrefix.indexOf('.');
    const provider = noPrefix.slice(0, i);
    const rest = noPrefix.slice(i + 1);
    add(`${provider}/${rest}`);
    add(rest);
  }
  return [...keys];
}

const remoteContextCache = new Map<string, number>();

/** Remember context_length from a live /models list (process-lifetime). */
export function rememberRemoteModelContext(modelId: string, contextLength: number): void {
  const n = Math.floor(contextLength);
  if (!modelId || !Number.isFinite(n) || n < 1_024) return;
  for (const k of normalizeModelIdForLimits(modelId)) {
    remoteContextCache.set(k, n);
  }
}

export function clearRemoteModelContextCache(): void {
  remoteContextCache.clear();
}

export function seedContextLengthForModel(modelId: string | null | undefined): number | null {
  if (!modelId) return null;
  const doc = loadModelContextLimitsDoc();
  for (const k of normalizeModelIdForLimits(modelId)) {
    const n = doc.limits[k] ?? doc.limits[k.toLowerCase()];
    if (typeof n === 'number' && n > 0) return Math.floor(n);
  }
  return null;
}

function lookupOverride(modelId: string | null | undefined): ModelLimitOverride | null {
  if (!modelId) return null;
  const doc = loadModelContextLimitsDoc();
  for (const k of normalizeModelIdForLimits(modelId)) {
    const o = doc.model_overrides[k] ?? doc.model_overrides[k.toLowerCase()];
    if (o && typeof o === 'object') return o;
  }
  return null;
}

function remoteContextLengthForModel(modelId: string): number | null {
  for (const k of normalizeModelIdForLimits(modelId)) {
    const remote = remoteContextCache.get(k);
    if (typeof remote === 'number' && remote > 0) return remote;
  }
  return null;
}

/**
 * Resolve context window: remote cache > seed catalog > default 128k.
 */
export function resolveModelContextLength(modelId?: string | null): number {
  const doc = loadModelContextLimitsDoc();
  const fallback = doc.default_context_length || DEFAULT_CONTEXT_LENGTH;
  if (!modelId) return fallback;
  const remote = remoteContextLengthForModel(modelId);
  if (remote) return remote;
  return seedContextLengthForModel(modelId) ?? fallback;
}

/** True when resolution used catalog default because model id had no seed/remote. */
export function usedContextLimitsFallback(modelId?: string | null): boolean {
  if (!modelId) return true;
  if (remoteContextLengthForModel(modelId)) return false;
  if (seedContextLengthForModel(modelId)) return false;
  return true;
}

/**
 * When both seed and remote exist and differ by >10%, surface a diagnostics note.
 */
export function getContextLimitMismatch(modelId?: string | null): ContextLimitMismatch | null {
  if (!modelId) return null;
  const seed = seedContextLengthForModel(modelId);
  const remote = remoteContextLengthForModel(modelId);
  if (!seed || !remote) return null;
  const ratio = Math.abs(seed - remote) / Math.max(seed, remote);
  if (ratio <= 0.1) return null;
  return {
    modelId,
    seed,
    remote,
    note: `context_limit_mismatch: seed=${seed} remote=${remote} (>10%)`,
  };
}

/** Process-lifetime mismatches observed via rememberRemote + seed. */
export function listContextLimitMismatches(modelIds: string[]): ContextLimitMismatch[] {
  const out: ContextLimitMismatch[] = [];
  for (const id of modelIds) {
    const m = getContextLimitMismatch(id);
    if (m) out.push(m);
  }
  return out;
}

function clampInt(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}

export type BudgetDebitOpts = {
  /** Number of vision images / keyframes in this turn. */
  visionImageCount?: number;
  /** Extra attachment text chars to debit from compress/tool budgets. */
  attachmentChars?: number;
};

/**
 * Scale history/tool budgets with effective context_length / 128k.
 * Unknown / 128k models keep env base values (scale ≈ 1) but set limitsFallback.
 */
export function resolveContextBudgets(
  modelId?: string | null,
  env: NodeJS.ProcessEnv = process.env,
  debit: BudgetDebitOpts = {},
): ContextBudgets {
  const base = loadHarnessPolicy(env);
  const doc = loadModelContextLimitsDoc();
  const override = lookupOverride(modelId);
  const contextLength = resolveModelContextLength(modelId);
  const reserveTokens = Math.max(
    512,
    Number(override?.reserve_tokens) > 0
      ? Math.floor(Number(override!.reserve_tokens))
      : doc.reserve_tokens || DEFAULT_RESERVE_TOKENS,
  );
  const effectiveContextLength = Math.max(1_024, contextLength - reserveTokens);
  const limitsFallback = usedContextLimitsFallback(modelId);
  const scale = effectiveContextLength / DEFAULT_CONTEXT_LENGTH;
  const up = Math.max(1, scale);

  const visionN = Math.max(0, Math.floor(Number(debit.visionImageCount) || 0));
  const attachChars = Math.max(0, Math.floor(Number(debit.attachmentChars) || 0));
  const perImage = doc.per_image_reserve_chars || 2_000;
  const visionDebit = visionN * perImage;
  const totalDebit = visionDebit + attachChars;

  const historyCompressChars = Math.max(
    2_000,
    clampInt(base.historyCompressChars * up, 4_000, 400_000) - totalDebit,
  );
  const toolResultMaxChars = Math.max(
    4_000,
    clampInt(base.toolResultMaxChars * up, 8_000, 200_000) - Math.floor(totalDebit / 2),
  );

  const maxOutputTokens =
    typeof override?.max_output_tokens === 'number' && override.max_output_tokens > 0
      ? Math.floor(override.max_output_tokens)
      : doc.default_max_output_tokens;
  const thinkingBudget =
    typeof override?.thinking_budget === 'number' && override.thinking_budget > 0
      ? Math.floor(override.thinking_budget)
      : doc.default_thinking_budget;

  return {
    contextLength,
    effectiveContextLength,
    reserveTokens,
    scale: up,
    limitsFallback,
    historyTurns: clampInt(base.historyTurns * up, 8, 80),
    historyAssistantMaxChars: clampInt(base.historyAssistantMaxChars * up, 500, 40_000),
    historyKeepRecent: base.historyKeepRecent,
    historyCompressChars,
    toolResultMaxChars,
    maxOutputTokens,
    thinkingBudget,
    perImageReserveChars: perImage,
  };
}

export type ContextBudgetSnapshot = {
  modelId: string | null;
  usedChars: number;
  budgetChars: number;
  contextLength: number;
  effectiveContextLength: number;
  compressed: boolean;
  fallback128k: boolean;
  scale: number;
  reserveTokens: number;
  foldedTurns?: number;
  mismatch?: string | null;
};

export function buildContextBudgetSnapshot(input: {
  modelId?: string | null;
  usedChars: number;
  compressed?: boolean;
  foldedTurns?: number;
  debit?: BudgetDebitOpts;
  env?: NodeJS.ProcessEnv;
}): ContextBudgetSnapshot {
  const budgets = resolveContextBudgets(input.modelId, input.env ?? process.env, input.debit);
  const mismatch = getContextLimitMismatch(input.modelId);
  return {
    modelId: input.modelId ?? null,
    usedChars: Math.max(0, Math.floor(input.usedChars)),
    budgetChars: budgets.historyCompressChars,
    contextLength: budgets.contextLength,
    effectiveContextLength: budgets.effectiveContextLength,
    compressed: Boolean(input.compressed),
    fallback128k: budgets.limitsFallback,
    scale: budgets.scale,
    reserveTokens: budgets.reserveTokens,
    foldedTurns: input.foldedTurns,
    mismatch: mismatch?.note ?? null,
  };
}
