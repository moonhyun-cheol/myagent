import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProviderStore } from '../core/dist/providers/provider-store.js';
import {
  MemoryMasterKeyStore,
  createPlatformMasterKeyStore,
} from '../core/dist/providers/os-secret-store.js';
import { computePortableVaultMachineId } from '../core/dist/providers/vault-machine-id.js';
import { encryptSecret } from '../core/dist/providers/vault-crypto.js';

const tempRoot = mkdtempSync(path.join(tmpdir(), 'cqr-secret-store-'));

try {
  const vaultPath = path.join(tempRoot, 'provider-keys.json');
  const masterKeys = new MemoryMasterKeyStore();
  const store = new ProviderStore(vaultPath, tempRoot, masterKeys);
  store.saveKey('openai', 'sk-test-envelope-secret', { model_id: 'gpt-5.6-terra-pro' });

  const raw = JSON.parse(readFileSync(vaultPath, 'utf8'));
  assert.equal(raw.version, 2);
  assert.equal(raw.entries.openai.cipher, 'envelope-v2');
  assert.equal(JSON.stringify(raw).includes('sk-test-envelope-secret'), false);
  assert.equal(new ProviderStore(vaultPath, tempRoot, masterKeys).getSecret('openai')?.api_key, 'sk-test-envelope-secret');
  assert.equal(new ProviderStore(vaultPath, tempRoot, new MemoryMasterKeyStore()).getSecret('openai'), null);

  class FlakyMasterKeyStore {
    backend = 'memory-test';
    calls = 0;
    constructor(key) {
      this.key = key;
    }
    getOrCreate() {
      this.calls += 1;
      if (this.calls < 3) throw new Error('TRANSIENT_OS_SECRET_STORE_FAILURE');
      return this.key.getOrCreate();
    }
  }
  const flakyKeys = new FlakyMasterKeyStore(masterKeys);
  const recoveredStore = new ProviderStore(vaultPath, tempRoot, flakyKeys);
  assert.equal(recoveredStore.getSecret('openai')?.api_key, 'sk-test-envelope-secret');
  assert.ok(flakyKeys.calls >= 3, 'OS secret store transient failure must be retried');

  const legacyPath = path.join(tempRoot, 'provider-keys-legacy.json');
  const legacySecret = 'sk-test-legacy-migration';
  writeFileSync(legacyPath, `${JSON.stringify({
    version: 1,
    default_provider_id: 'custom',
    entries: {
      custom: {
        api_key_enc: encryptSecret(legacySecret, computePortableVaultMachineId()),
        base_url: 'https://openrouter.ai/api/v1',
        model_id: 'anthropic/claude-opus-5',
        wire_api: 'responses',
        updated_at: new Date().toISOString(),
      },
    },
    user_defs: {},
  }, null, 2)}\n`, 'utf8');
  const legacyMasterKeys = new MemoryMasterKeyStore();
  const legacyStore = new ProviderStore(legacyPath, tempRoot, legacyMasterKeys);
  assert.equal(legacyStore.getSecret('custom')?.api_key, legacySecret);
  assert.equal(legacyStore.migrateVaultIfNeeded().migrated, true);
  const migratedRaw = JSON.parse(readFileSync(legacyPath, 'utf8'));
  assert.equal(migratedRaw.version, 2);
  assert.equal(migratedRaw.entries.custom.cipher, 'envelope-v2');
  assert.equal(new ProviderStore(legacyPath, tempRoot, legacyMasterKeys).getSecret('custom')?.api_key, legacySecret);

  if (process.platform === 'win32') {
    const nativeVault = path.join(tempRoot, 'native-provider-keys.json');
    const nativeOne = createPlatformMasterKeyStore(nativeVault, tempRoot);
    const first = nativeOne.getOrCreate();
    const sidecar = `${nativeVault}.master-key.json`;
    assert.equal(existsSync(sidecar), true);
    assert.equal(readFileSync(sidecar, 'utf8').includes(first.toString('base64')), false);
    const second = createPlatformMasterKeyStore(nativeVault, tempRoot).getOrCreate();
    assert.deepEqual(second, first);
    assert.equal(nativeOne.backend, 'windows-dpapi');

    const unreadableDoc = JSON.parse(readFileSync(sidecar, 'utf8'));
    unreadableDoc.protected_key = 'invalid-current-dpapi-payload';
    writeFileSync(sidecar, `${JSON.stringify(unreadableDoc, null, 2)}\n`, 'utf8');
    assert.throws(() => createPlatformMasterKeyStore(nativeVault, tempRoot).getOrCreate());

    const replacementStore = new ProviderStore(nativeVault, tempRoot);
    replacementStore.saveKey('openai', 'sk-test-replacement-secret', { model_id: 'gpt-5.6-terra-pro' });
    const replacedDoc = JSON.parse(readFileSync(sidecar, 'utf8'));
    assert.notEqual(replacedDoc.protected_key, unreadableDoc.protected_key);
    assert.equal(
      new ProviderStore(nativeVault, tempRoot).getSecret('openai')?.api_key,
      'sk-test-replacement-secret',
    );
  }

  const source = readFileSync(path.join(process.cwd(), 'core', 'src', 'providers', 'os-secret-store.ts'), 'utf8');
  assert.match(source, /platform === 'darwin'/);
  assert.match(source, /find-generic-password/);
  assert.match(source, /add-generic-password/);
  assert.match(source, /input: `\$\{key\.toString\('base64'\)\}\\n`/);
  assert.equal(source.includes("'-w', key.toString('base64')"), false, 'macOS key must not be placed in argv');
  assert.equal(source.includes('CQR_PA/provider-vault/v2'), false, 'legacy DPAPI entropy must stay disabled');

  console.log('os-secret-store verify: PASS');
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
