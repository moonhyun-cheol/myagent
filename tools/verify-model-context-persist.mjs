#!/usr/bin/env node
/**
 * Remote model context windows survive an app restart (data/model-context-remote.json).
 * Regression: unseeded models ran at the 128k fallback after every cold start until the
 * model list was refreshed by hand. Requires `npx tsc -p tsconfig.json` (core/dist).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dist = new URL('../core/dist/', import.meta.url);
const limits = await import(new URL('providers/model-context-limits.js', dist));
const picker = await import(new URL('models/model-picker.js', dist));

const dir = mkdtempSync(path.join(tmpdir(), 'model-context-'));
try {
  const file = path.join(dir, 'model-context-remote.json');
  const MODEL = 'vendor/brand-new-model-x';

  // 1. Unknown model, nothing persisted -> flagged 128k fallback
  limits.setRemoteModelContextFileForTest(file);
  assert.equal(limits.hasRemoteModelContexts(), false);
  assert.equal(limits.resolveModelContextLength(MODEL), limits.DEFAULT_CONTEXT_LENGTH);
  assert.equal(limits.usedContextLimitsFallback(MODEL), true);

  // 2. Remembering alone does not write; persist does, once
  limits.rememberRemoteModelContext(MODEL, 1_050_000);
  limits.rememberRemoteModelContext('vendor/too-small', 100); // ignored (< 1024)
  assert.equal(existsSync(file), false, 'no write per model');
  limits.persistRemoteModelContexts();
  assert.ok(existsSync(file), 'remote windows persisted');
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(doc.version, 1);
  assert.deepEqual(doc.models, { [MODEL]: 1_050_000 });

  // 3. "Restart": memory dropped, value comes back from disk for every id spelling
  limits.setRemoteModelContextFileForTest(file);
  assert.equal(limits.resolveModelContextLength(MODEL), 1_050_000);
  assert.equal(limits.resolveModelContextLength('vendor.brand-new-model-x'), 1_050_000);
  assert.equal(limits.usedContextLimitsFallback(MODEL), false);
  assert.equal(limits.resolveContextBudgets(MODEL).limitsFallback, false);
  assert.equal(limits.hasRemoteModelContexts(), true);

  // 4. Unchanged listing does not rewrite; a changed value does
  const before = readFileSync(file, 'utf8');
  limits.rememberRemoteModelContext(MODEL, 1_050_000);
  limits.persistRemoteModelContexts();
  assert.equal(readFileSync(file, 'utf8'), before, 'no rewrite when nothing changed');
  limits.rememberRemoteModelContext(MODEL, 400_000);
  limits.persistRemoteModelContexts();
  limits.setRemoteModelContextFileForTest(file);
  assert.equal(limits.resolveModelContextLength(MODEL), 400_000, 'newer listing replaces the stored value');

  // 5. clear = memory only: file stays, and is not re-read behind the caller's back
  limits.clearRemoteModelContextCache();
  assert.equal(limits.resolveModelContextLength(MODEL), limits.DEFAULT_CONTEXT_LENGTH);
  assert.ok(existsSync(file));

  // 6. Corrupt / wrong-shaped file -> fallback, no throw
  const bad = path.join(dir, 'bad.json');
  writeFileSync(bad, '{not json');
  limits.setRemoteModelContextFileForTest(bad);
  assert.equal(limits.resolveModelContextLength(MODEL), limits.DEFAULT_CONTEXT_LENGTH);
  writeFileSync(bad, JSON.stringify({ version: 1, models: { [MODEL]: 'big', 'vendor/ok': 300_000 } }));
  limits.setRemoteModelContextFileForTest(bad);
  assert.equal(limits.resolveModelContextLength(MODEL), limits.DEFAULT_CONTEXT_LENGTH);
  assert.equal(limits.resolveModelContextLength('vendor/ok'), 300_000);

  // 7. No app root (memory only) -> never writes, no warm-up
  limits.setRemoteModelContextFileForTest(null);
  limits.rememberRemoteModelContext(MODEL, 1_050_000);
  limits.persistRemoteModelContexts();
  assert.equal(limits.canPersistRemoteModelContexts(), false);
  let fetches = 0;
  const fakeStore = {
    getConfiguredIds: () => ['custom'],
    getDefinition: () => ({ custom: true, base_url: 'http://127.0.0.1:9' }),
    getSecret: () => { fetches += 1; return null; }, // no key -> fetch path exits without network
  };
  assert.equal(picker.warmModelContextIfMissing(fakeStore), false, 'no warm without a persist target');

  // 8. Windows already known -> no warm; none known -> exactly one warm per process
  limits.setRemoteModelContextFileForTest(file);
  assert.equal(picker.warmModelContextIfMissing(fakeStore), false, 'no warm once windows are persisted');
  limits.setRemoteModelContextFileForTest(path.join(dir, 'empty.json'));
  assert.equal(
    picker.warmModelContextIfMissing({ ...fakeStore, getDefinition: () => ({ custom: false }) }),
    false,
    'no warm without a custom provider',
  );
  assert.equal(picker.warmModelContextIfMissing(fakeStore), true, 'cold start without windows warms once');
  assert.equal(picker.warmModelContextIfMissing(fakeStore), false, 'never repeated in the same process');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fetches, 1, 'single background listing');

  // 9. Per-model warm: a model whose window is unknown triggers one background listing even
  //    when other windows are already persisted (model released after the table was written).
  limits.setRemoteModelContextFileForTest(file);
  picker.resetModelContextWarmForTest();
  assert.equal(limits.hasRemoteModelContexts(), true);
  const NEW_MODEL = 'vendor/released-later';
  const t0 = 1_000_000;
  fetches = 0;
  assert.equal(picker.warmModelContextForModel(fakeStore, 'custom', MODEL, t0), false, 'known window -> no fetch');
  assert.equal(picker.warmModelContextForModel(fakeStore, 'custom', '', t0), false, 'no model id -> no fetch');
  assert.equal(
    picker.warmModelContextForModel({ ...fakeStore, getDefinition: () => ({ custom: false }) }, 'openai', NEW_MODEL, t0),
    false,
    'non-custom provider -> no fetch',
  );
  assert.equal(picker.warmModelContextForModel(fakeStore, 'custom', NEW_MODEL, t0), true, 'unknown model warms');
  assert.equal(picker.warmModelContextForModel(fakeStore, 'custom', NEW_MODEL, t0 + 60_000), false, 'throttled per model');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fetches, 1, 'one listing for the unknown model');
  assert.equal(picker.warmModelContextForModel(fakeStore, 'custom', NEW_MODEL, t0 + 11 * 60_000), true, 'retried after cooldown');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fetches, 2);
  limits.rememberRemoteModelContext(NEW_MODEL, 500_000);
  assert.equal(
    picker.warmModelContextForModel(fakeStore, 'custom', NEW_MODEL, t0 + 60 * 60_000),
    false,
    'no fetch once the window is known',
  );

  // 10. A chat turn resolving its model triggers the warm-up without waiting for it.
  picker.resetModelContextWarmForTest();
  fetches = 0;
  const turnStore = {
    ...fakeStore,
    listDefinitions: () => [{ id: 'custom', custom: true }],
    getDefaultId: () => 'custom',
    resolveProvider: (_id, modelId) => ({ def: { name: 'Custom' }, modelId, baseUrl: 'http://127.0.0.1:9' }),
  };
  const registry = { load: () => ({ models: [], default_llm_id: null }) };
  const TURN_MODEL = 'vendor/turn-model';
  const resolved = await picker.resolveChatModelAsync(
    `provider:custom@${encodeURIComponent(TURN_MODEL)}`,
    registry,
    {},
    turnStore,
  );
  assert.equal(resolved.route.type, 'provider');
  assert.equal(resolved.route.modelId, TURN_MODEL);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fetches, 1, 'turn start warms the unknown model in the background');
  await picker.resolveChatModelAsync(`provider:custom@${encodeURIComponent(TURN_MODEL)}`, registry, {}, turnStore);
  await picker.resolveChatModelAsync(`provider:custom@${encodeURIComponent(MODEL)}`, registry, {}, turnStore);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fetches, 1, 'no repeat for the same model, none for a known model');

  console.log('verify-model-context-persist: OK');
} finally {
  limits.setRemoteModelContextFileForTest(undefined);
  rmSync(dir, { recursive: true, force: true });
}
