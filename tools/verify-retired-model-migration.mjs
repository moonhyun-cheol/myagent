// Verifies GPT 5.6 Sol -> 6.1 Sol: bundled default list + one-time migration of saved picks.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateRetiredModelDefaults } from '../core/dist/config/retired-model-migration.js';
import { defaultCompanyModelIds, loadCurateConfig } from '../core/dist/providers/remote-model-curate.js';

const defaults = defaultCompanyModelIds(loadCurateConfig(true));
assert.ok(defaults.includes('openai/gpt-6.1-sol'), 'default company list must include 6.1 Sol');
assert.ok(!defaults.includes('openai/gpt-5.6-sol'), 'default company list must drop 5.6 Sol');

const providersDoc = JSON.parse(readFileSync(new URL('../core/config/defaults/providers.json', import.meta.url), 'utf8'));
const providers = providersDoc.providers ?? providersDoc;
const byId = Object.fromEntries((Array.isArray(providers) ? providers : []).map((p) => [p.id, p]));
if (byId.openai) assert.equal(byId.openai.default_model, 'gpt-6.1-sol');
if (byId.custom) assert.equal(byId.custom.default_model, 'openai/gpt-6.1-sol');

function fakeStore(entries) {
  return {
    entries,
    calls: 0,
    migrateSavedModelIds(map) {
      this.calls += 1;
      const changed = [];
      for (const [id, e] of Object.entries(this.entries)) {
        const next = map[id]?.[e.model_id];
        if (next) { e.model_id = next; changed.push(id); }
      }
      return changed;
    },
  };
}

const root = mkdtempSync(path.join(os.tmpdir(), 'retired-model-'));
try {
  const cfgDir = path.join(root, 'config');
  mkdirSync(cfgDir, { recursive: true });
  const cfg = path.join(cfgDir, 'user-overrides.json');
  const oldPick = `provider:custom@${encodeURIComponent('openai/gpt-5.6-sol')}`;
  writeFileSync(cfg, JSON.stringify({
    default_model: oldPick,
    company_model_ids: ['openai/gpt-5.6-sol', 'anthropic/claude-fable-5.1', 'openai/gpt-6.1-sol'],
  }));
  const store = fakeStore({ custom: { model_id: 'openai/gpt-5.6-sol' }, openai: { model_id: 'gpt-5.6-sol' }, x: { model_id: 'keep' } });

  const r1 = migrateRetiredModelDefaults({ userConfigPath: cfg, cqrRoot: root, providerStore: store });
  assert.deepEqual(r1.applied, ['sol-5.6-to-6.1']);
  const saved = JSON.parse(readFileSync(cfg, 'utf8'));
  assert.equal(saved.default_model, `provider:custom@${encodeURIComponent('openai/gpt-6.1-sol')}`);
  assert.deepEqual(saved.company_model_ids, ['openai/gpt-6.1-sol', 'anthropic/claude-fable-5.1']);
  assert.deepEqual(saved.model_migrations, ['sol-5.6-to-6.1']);
  assert.equal(store.entries.custom.model_id, 'openai/gpt-6.1-sol');
  assert.equal(store.entries.openai.model_id, 'gpt-6.1-sol');
  assert.equal(store.entries.x.model_id, 'keep');

  // Runs once: a later deliberate 5.6 pick is respected.
  writeFileSync(cfg, JSON.stringify({ ...saved, default_model: oldPick }));
  const r2 = migrateRetiredModelDefaults({ userConfigPath: cfg, cqrRoot: root, providerStore: store });
  assert.deepEqual(r2.applied, []);
  assert.equal(JSON.parse(readFileSync(cfg, 'utf8')).default_model, oldPick);
  assert.equal(store.calls, 1);

  // Fresh install: no overrides file is created when nothing changed.
  const fresh = path.join(root, 'fresh', 'user-overrides.json');
  mkdirSync(path.dirname(fresh), { recursive: true });
  migrateRetiredModelDefaults({ userConfigPath: fresh, cqrRoot: root, providerStore: fakeStore({}) });
  assert.equal(existsSync(fresh), false);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ ok: true, checks: ['default list 6.1 Sol', 'saved picks migrated', 'runs once', 'fresh install untouched'] }));
