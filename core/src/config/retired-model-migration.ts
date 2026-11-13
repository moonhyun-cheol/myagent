import { existsSync } from 'node:fs';
import { loadUserOverrides, saveUserOverrides, type UserOverrides } from './user-overrides.js';
import type { ProviderStore } from '../providers/provider-store.js';

/**
 * One-time moves of saved model choices when a product default model is retired.
 * Each id runs once per install (recorded in `user-overrides.model_migrations`), so a
 * user who deliberately picks the old model again afterwards keeps that choice.
 */
interface RetiredModelMigration {
  id: string;
  /** Saved connection model per provider id: old -> new. */
  providers: Record<string, Record<string, string>>;
  /** Company (OpenRouter) picker ids: old -> new, canonical `vendor/model`. */
  company: Record<string, string>;
}

export const RETIRED_MODEL_MIGRATIONS: readonly RetiredModelMigration[] = [
  {
    id: 'sol-5.6-to-6.1',
    providers: {
      openai: { 'gpt-5.6-sol': 'gpt-6.1-sol' },
      custom: { 'openai/gpt-5.6-sol': 'openai/gpt-6.1-sol', 'openai.gpt-5.6-sol': 'openai/gpt-6.1-sol' },
    },
    company: { 'openai/gpt-5.6-sol': 'openai/gpt-6.1-sol', 'openai.gpt-5.6-sol': 'openai/gpt-6.1-sol' },
  },
];

function migratePickPreference(value: string | undefined, m: RetiredModelMigration): string | undefined {
  if (!value?.startsWith('provider:')) return undefined;
  const rest = value.slice('provider:'.length);
  const at = rest.indexOf('@');
  if (at === -1) return undefined;
  const providerId = rest.slice(0, at);
  let modelId: string;
  try {
    modelId = decodeURIComponent(rest.slice(at + 1));
  } catch {
    return undefined;
  }
  const next = m.providers[providerId]?.[modelId];
  return next ? `provider:${providerId}@${encodeURIComponent(next)}` : undefined;
}

export interface RetiredModelMigrationResult {
  applied: string[];
  overrides_changed: string[];
  providers_changed: string[];
}

export function migrateRetiredModelDefaults(opts: {
  userConfigPath: string;
  cqrRoot: string;
  providerStore: ProviderStore;
}): RetiredModelMigrationResult {
  const result: RetiredModelMigrationResult = { applied: [], overrides_changed: [], providers_changed: [] };
  const current = loadUserOverrides(opts.userConfigPath);
  const done = new Set(current.model_migrations ?? []);
  const patch: Partial<UserOverrides> = {};

  for (const m of RETIRED_MODEL_MIGRATIONS) {
    if (done.has(m.id)) continue;
    if (current.company_model_ids?.length) {
      const seen = new Set<string>();
      const next: string[] = [];
      for (const raw of current.company_model_ids) {
        const id = m.company[raw] ?? raw;
        if (seen.has(id)) continue;
        seen.add(id);
        next.push(id);
      }
      if (next.join('\n') !== current.company_model_ids.join('\n')) {
        patch.company_model_ids = next;
        current.company_model_ids = next;
        result.overrides_changed.push('company_model_ids');
      }
    }
    for (const key of ['default_model', 'scheduler_default_model', 'approval_reviewer_model'] as const) {
      const next = migratePickPreference(current[key], m);
      if (next) {
        patch[key] = next;
        current[key] = next;
        result.overrides_changed.push(key);
      }
    }
    result.providers_changed.push(...opts.providerStore.migrateSavedModelIds(m.providers));
    done.add(m.id);
    result.applied.push(m.id);
  }

  if (!result.applied.length) return result;
  const touched = result.overrides_changed.length > 0 || result.providers_changed.length > 0;
  // Fresh installs without saved choices need no marker file; their defaults are already new.
  if (touched || existsSync(opts.userConfigPath)) {
    saveUserOverrides(opts.userConfigPath, { ...patch, model_migrations: [...done] }, opts.cqrRoot);
  }
  return result;
}
