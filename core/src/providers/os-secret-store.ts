import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import { assertWritablePath } from '../security/path-guard.js';

export type SecretStoreBackend = 'windows-dpapi' | 'macos-keychain' | 'memory-test';

export interface MasterKeyStore {
  readonly backend: SecretStoreBackend;
  getOrCreate(opts?: { replaceUnreadable?: boolean }): Buffer;
}

interface DpapiKeyFile {
  version: 1;
  backend: 'windows-dpapi';
  protected_key: string;
}

const MASTER_KEY_BYTES = 32;
const MAC_SERVICE = 'com.cqr-pa.provider-vault';
const MAC_ACCOUNT = 'provider-vault-v2';

function validateMasterKey(value: Buffer): Buffer {
  if (value.length !== MASTER_KEY_BYTES) throw new Error('OS_SECRET_STORE_INVALID_MASTER_KEY');
  return value;
}

function powershellDpapi(operation: 'protect' | 'unprotect', inputBase64: string): string {
  const method = operation === 'protect' ? 'Protect' : 'Unprotect';
  const script = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Security',
    '$raw = [Console]::In.ReadToEnd().Trim()',
    '$data = [Convert]::FromBase64String($raw)',
    '$entropy = [Text.Encoding]::UTF8.GetBytes("MY Agent/provider-vault/v2")',
    `$result = [Security.Cryptography.ProtectedData]::${method}($data, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    '[Console]::Out.Write([Convert]::ToBase64String($result))',
  ].join('; ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const proc = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { input: inputBase64, encoding: 'utf8', windowsHide: true, timeout: 15_000 },
  );
  if (proc.status !== 0 || !proc.stdout.trim()) {
    const detail = proc.error?.message || (proc.stderr || '').trim() || `exit=${String(proc.status)}`;
    throw new Error(`WINDOWS_DPAPI_${operation.toUpperCase()}_FAILED: ${detail.slice(0, 160)}`);
  }
  return proc.stdout.trim();
}

class WindowsDpapiMasterKeyStore implements MasterKeyStore {
  readonly backend = 'windows-dpapi' as const;
  private cached: Buffer | null = null;

  constructor(
    private readonly keyFile: string,
    private readonly cqrRoot: string,
  ) {}

  getOrCreate(opts?: { replaceUnreadable?: boolean }): Buffer {
    if (this.cached) return Buffer.from(this.cached);
    if (existsSync(this.keyFile)) {
      try {
        const doc = JSON.parse(readFileSync(this.keyFile, 'utf8')) as DpapiKeyFile;
        if (doc.version !== 1 || doc.backend !== this.backend || !doc.protected_key) {
          throw new Error('WINDOWS_DPAPI_KEY_FILE_INVALID');
        }
        this.cached = validateMasterKey(Buffer.from(powershellDpapi('unprotect', doc.protected_key), 'base64'));
        return Buffer.from(this.cached);
      } catch (error) {
        if (!opts?.replaceUnreadable) throw error;
      }
    }

    return this.createAndPersist();
  }

  private createAndPersist(): Buffer {
    const key = randomBytes(MASTER_KEY_BYTES);
    const doc: DpapiKeyFile = {
      version: 1,
      backend: this.backend,
      protected_key: powershellDpapi('protect', key.toString('base64')),
    };
    assertWritablePath(this.keyFile, this.cqrRoot);
    writeFileSync(this.keyFile, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    this.cached = key;
    return Buffer.from(key);
  }
}

class MacOsKeychainMasterKeyStore implements MasterKeyStore {
  readonly backend = 'macos-keychain' as const;
  private cached: Buffer | null = null;

  getOrCreate(): Buffer {
    if (this.cached) return Buffer.from(this.cached);
    const found = spawnSync(
      '/usr/bin/security',
      ['find-generic-password', '-s', MAC_SERVICE, '-a', MAC_ACCOUNT, '-w'],
      { encoding: 'utf8', timeout: 15_000 },
    );
    if (found.status === 0 && found.stdout.trim()) {
      this.cached = validateMasterKey(Buffer.from(found.stdout.trim(), 'base64'));
      return Buffer.from(this.cached);
    }

    const key = randomBytes(MASTER_KEY_BYTES);
    // `-w` at the end prompts on stdin, keeping the secret out of argv/process listings.
    const stored = spawnSync(
      '/usr/bin/security',
      ['add-generic-password', '-U', '-s', MAC_SERVICE, '-a', MAC_ACCOUNT, '-l', 'MY Agent Provider Vault', '-w'],
      { input: `${key.toString('base64')}\n`, encoding: 'utf8', timeout: 15_000 },
    );
    if (stored.status !== 0) {
      throw new Error(`MACOS_KEYCHAIN_STORE_FAILED: ${(stored.stderr || '').trim().slice(0, 160)}`);
    }
    this.cached = key;
    return Buffer.from(key);
  }
}

export class MemoryMasterKeyStore implements MasterKeyStore {
  readonly backend = 'memory-test' as const;
  constructor(private readonly key = randomBytes(MASTER_KEY_BYTES)) {}
  getOrCreate(): Buffer {
    return Buffer.from(validateMasterKey(this.key));
  }
}

export function createPlatformMasterKeyStore(
  vaultPath: string,
  cqrRoot: string,
  platform: NodeJS.Platform = process.platform,
): MasterKeyStore {
  if (platform === 'win32') {
    return new WindowsDpapiMasterKeyStore(`${vaultPath}.master-key.json`, cqrRoot);
  }
  if (platform === 'darwin') return new MacOsKeychainMasterKeyStore();
  throw new Error(`OS_SECRET_STORE_UNSUPPORTED: ${platform} (${os.type()})`);
}
