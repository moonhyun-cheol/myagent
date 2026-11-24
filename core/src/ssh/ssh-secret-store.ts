/**
 * Remembered SSH key passphrases (data/config/ssh-key-secrets.json).
 *
 * Only Windows DPAPI ciphertext (CurrentUser scope, base64) is written; the plain passphrase
 * never touches disk. DPAPI is reached through a PowerShell child and the secret travels over
 * stdin/stdout only, never on a command line. The ciphertext opens only for the Windows
 * account that created it, on this PC.
 *
 * Not Windows, PowerShell unavailable, or ciphertext that cannot be opened: recall returns
 * null and remember returns false. Nothing here throws for those cases.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertWritablePath } from '../security/path-guard.js';

export const SSH_KEY_SECRETS_REL_PATH = 'data/config/ssh-key-secrets.json';
const DPAPI_TIMEOUT_MS = 20_000;
const BASE64_RE = /^[A-Za-z0-9+/]+=*$/;

interface SecretEntry {
  /** base64 of the DPAPI blob. */
  dpapi: string;
  savedAt: string;
}

interface SecretsDoc {
  version: 1;
  secrets: Record<string, SecretEntry>;
}

export function sshKeySecretsPath(cqrRoot: string): string {
  return path.join(cqrRoot, 'data', 'config', 'ssh-key-secrets.json');
}

function loadDoc(cqrRoot: string): SecretsDoc {
  const file = sshKeySecretsPath(cqrRoot);
  const doc: SecretsDoc = { version: 1, secrets: {} };
  if (!existsSync(file)) return doc;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { secrets?: unknown };
    if (raw?.secrets && typeof raw.secrets === 'object') {
      for (const [id, value] of Object.entries(raw.secrets as Record<string, unknown>)) {
        const entry = value as Partial<SecretEntry> | null;
        if (entry && typeof entry.dpapi === 'string' && BASE64_RE.test(entry.dpapi)) {
          doc.secrets[id] = { dpapi: entry.dpapi, savedAt: typeof entry.savedAt === 'string' ? entry.savedAt : '' };
        }
      }
    }
  } catch { /* unreadable file: treat as empty */ }
  return doc;
}

function writeDoc(cqrRoot: string, doc: SecretsDoc): void {
  const file = sshKeySecretsPath(cqrRoot);
  assertWritablePath(file, cqrRoot);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  assertWritablePath(tmp, cqrRoot);
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

/** base64 in (stdin) -> base64 out (stdout). null on any failure. */
async function dpapi(op: 'Protect' | 'Unprotect', inputBase64: string): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Security',
    '$data = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
    "$entropy = [Text.Encoding]::UTF8.GetBytes('MY Agent/ssh-key-passphrase/v1')",
    `$out = [Security.Cryptography.ProtectedData]::${op}($data, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    '[Console]::Out.Write([Convert]::ToBase64String($out))',
  ].join('; ');
  // Absolute path: do not let PATH decide which powershell.exe receives the secret.
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    // Same call shape as providers/os-secret-store.ts (EncodedCommand: no quoting surprises).
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    return await new Promise<string | null>((resolve) => {
      const child = spawn(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        windowsHide: true, timeout: DPAPI_TIMEOUT_MS, stdio: ['pipe', 'pipe', 'ignore'],
      });
      let out = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
      child.once('error', () => resolve(null));
      child.stdin.once('error', () => resolve(null));
      child.once('close', (code) => resolve(code === 0 && BASE64_RE.test(out.trim()) ? out.trim() : null));
      child.stdin.end(inputBase64);
    });
  } catch {
    return null;
  }
}

/** True when ciphertext is stored for this server (does not decrypt). */
export function hasRememberedPassphrase(cqrRoot: string, serverId: string): boolean {
  return Object.prototype.hasOwnProperty.call(loadDoc(cqrRoot).secrets, serverId);
}

/** Encrypt and store. false when it could not be stored; the plain value is never written. */
export async function rememberPassphrase(cqrRoot: string, serverId: string, passphrase: string, current = () => true): Promise<boolean> {
  if (!serverId || !passphrase) return false;
  const cipher = await dpapi('Protect', Buffer.from(passphrase, 'utf8').toString('base64'));
  if (!cipher || !current()) return false;
  try {
    const doc = loadDoc(cqrRoot);
    doc.secrets[serverId] = { dpapi: cipher, savedAt: new Date().toISOString() };
    writeDoc(cqrRoot, doc);
    return true;
  } catch {
    return false;
  }
}

/** The stored passphrase, or null when nothing is stored or it cannot be opened here. */
export async function recallPassphrase(cqrRoot: string, serverId: string): Promise<string | null> {
  const entry = loadDoc(cqrRoot).secrets[serverId];
  if (!entry) return null;
  const plain = await dpapi('Unprotect', entry.dpapi);
  if (!plain) return null;
  try {
    return Buffer.from(plain, 'base64').toString('utf8') || null;
  } catch {
    return null;
  }
}

/** Remove the stored ciphertext for this server. No-op when nothing is stored. */
export function forgetPassphrase(cqrRoot: string, serverId: string): void {
  const doc = loadDoc(cqrRoot);
  if (!Object.prototype.hasOwnProperty.call(doc.secrets, serverId)) return;
  delete doc.secrets[serverId];
  writeDoc(cqrRoot, doc);
}
