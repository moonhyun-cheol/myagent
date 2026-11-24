/**
 * SSH server profiles (data/config/ssh-servers.json).
 *
 * The file holds connection facts only: no private key body, passphrase or password field
 * exists in the schema, and unknown fields are dropped on every load and save. `keyPath`
 * points at a key file on this PC; the passphrase lives only in ssh-service memory.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertWritablePath } from '../security/path-guard.js';

export interface SshServerProfile {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  /** Path of the private key file on this PC. The key body is never stored here. */
  keyPath: string;
  defaultCwd?: string;
  /** `SHA256:<base64>` of the trusted host key. Set only through trustSshServer. */
  hostKeySha256?: string;
  trustedAt?: string;
}

export interface SshServersDoc {
  version: 1;
  servers: SshServerProfile[];
}

export class SshProfileError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export const SSH_SERVERS_REL_PATH = 'data/config/ssh-servers.json';
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/;
const FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;
const MAX_SERVERS = 50;

export function sshServersPath(cqrRoot: string): string {
  return path.join(cqrRoot, 'data', 'config', 'ssh-servers.json');
}

export function isSshFingerprint(value: unknown): value is string {
  return typeof value === 'string' && FINGERPRINT_RE.test(value);
}

/** `label (user@host:port)` — the wording shown on the approval card. */
export function describeSshTarget(server: SshServerProfile): string {
  return `${server.label} (${server.username}@${server.host}:${server.port})`;
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Keeps only schema fields. Returns a reason string when the row is unusable. */
function cleanServer(raw: unknown): SshServerProfile | string {
  if (!raw || typeof raw !== 'object') return 'server must be an object';
  const row = raw as Record<string, unknown>;
  const id = text(row.id, 40);
  if (!ID_RE.test(id)) return `invalid id: ${id || '(empty)'} (letters, digits, _ and - only)`;
  const host = text(row.host, 255);
  if (!host || /[\s'"`$;|&<>\\]/.test(host)) return `invalid host for ${id}`;
  const username = text(row.username, 64);
  if (!username || /[\s'"`$;|&<>\\]/.test(username)) return `invalid username for ${id}`;
  const keyPath = text(row.keyPath, 1024);
  if (!keyPath) return `keyPath required for ${id}`;
  const portRaw = row.port === undefined || row.port === null || row.port === '' ? 22 : Number(row.port);
  if (!Number.isInteger(portRaw) || portRaw < 1 || portRaw > 65535) return `invalid port for ${id}`;
  const defaultCwd = text(row.defaultCwd, 1024);
  if (/[\r\n\0]/.test(defaultCwd)) return `invalid defaultCwd for ${id}`;
  const server: SshServerProfile = {
    id,
    label: text(row.label, 80) || id,
    host,
    port: portRaw,
    username,
    keyPath,
  };
  if (defaultCwd) server.defaultCwd = defaultCwd;
  if (isSshFingerprint(row.hostKeySha256)) {
    server.hostKeySha256 = row.hostKeySha256;
    const trustedAt = text(row.trustedAt, 40);
    if (trustedAt) server.trustedAt = trustedAt;
  }
  return server;
}

export function loadSshServers(cqrRoot: string): SshServersDoc {
  const file = sshServersPath(cqrRoot);
  if (!existsSync(file)) return { version: 1, servers: [] };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { servers?: unknown };
    const rows = Array.isArray(raw?.servers) ? raw.servers : [];
    const servers: SshServerProfile[] = [];
    for (const row of rows.slice(0, MAX_SERVERS)) {
      const cleaned = cleanServer(row);
      if (typeof cleaned !== 'string' && !servers.some((s) => s.id === cleaned.id)) servers.push(cleaned);
    }
    return { version: 1, servers };
  } catch {
    return { version: 1, servers: [] };
  }
}

function writeDoc(cqrRoot: string, doc: SshServersDoc): void {
  const file = sshServersPath(cqrRoot);
  assertWritablePath(file, cqrRoot);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  assertWritablePath(tmp, cqrRoot);
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

export function findSshServer(cqrRoot: string, id: string): SshServerProfile | null {
  const wanted = String(id ?? '').trim();
  if (!wanted) return null;
  return loadSshServers(cqrRoot).servers.find((server) => server.id === wanted) ?? null;
}

/**
 * Replace the server list from the Settings UI. Trust is never taken from the request:
 * a stored fingerprint survives only while host and port are unchanged, so editing the
 * address forces a new 「이 지문 신뢰」. `keyChangedIds` lists servers whose key file
 * changed or that were removed, so the caller can drop their in-memory passphrase.
 */
export function saveSshServers(
  cqrRoot: string,
  rawServers: unknown[],
): { doc: SshServersDoc; keyChangedIds: string[] } {
  if (rawServers.length > MAX_SERVERS) {
    throw new SshProfileError('SSH_TOO_MANY_SERVERS', `at most ${MAX_SERVERS} servers`);
  }
  const prev = loadSshServers(cqrRoot);
  const servers: SshServerProfile[] = [];
  for (const raw of rawServers) {
    const cleaned = cleanServer(raw);
    if (typeof cleaned === 'string') throw new SshProfileError('SSH_SERVER_INVALID', cleaned);
    if (servers.some((s) => s.id === cleaned.id)) {
      throw new SshProfileError('SSH_SERVER_DUPLICATE', `duplicate id: ${cleaned.id}`);
    }
    delete cleaned.hostKeySha256;
    delete cleaned.trustedAt;
    const before = prev.servers.find((s) => s.id === cleaned.id);
    if (before?.hostKeySha256 && before.host === cleaned.host && before.port === cleaned.port) {
      cleaned.hostKeySha256 = before.hostKeySha256;
      if (before.trustedAt) cleaned.trustedAt = before.trustedAt;
    }
    servers.push(cleaned);
  }
  const doc: SshServersDoc = { version: 1, servers };
  writeDoc(cqrRoot, doc);
  const keyChangedIds = prev.servers
    .filter((before) => {
      const after = servers.find((s) => s.id === before.id);
      return !after || after.keyPath !== before.keyPath;
    })
    .map((s) => s.id);
  return { doc, keyChangedIds };
}

/** Record the host key the user confirmed. */
export function trustSshServer(cqrRoot: string, id: string, fingerprint: string): SshServerProfile {
  if (!isSshFingerprint(fingerprint)) {
    throw new SshProfileError('SSH_FINGERPRINT_INVALID', 'fingerprint must look like SHA256:<base64>');
  }
  const doc = loadSshServers(cqrRoot);
  const server = doc.servers.find((s) => s.id === id);
  if (!server) throw new SshProfileError('SSH_SERVER_NOT_FOUND', `unknown server: ${id}`);
  server.hostKeySha256 = fingerprint;
  server.trustedAt = new Date().toISOString();
  writeDoc(cqrRoot, doc);
  return server;
}
