/**
 * SSH server profiles (data/config/ssh-servers.json).
 *
 * The file holds connection facts only: no private key body, passphrase or password field
 * exists in the schema, and unknown fields are dropped on every load and save. `keyPath`
 * points at a key file on this PC; the passphrase stays in memory unless explicitly remembered in the separate DPAPI store.
 *
 * Managed connections come from signed Organization Features (managed-ssh-connections.json):
 * name, address, port, server kind, encoding and a pinned fingerprint, never a secret. They
 * are merged read-only; this PC only stores its own account for them under `managed`.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEnabledFeatureEntrypointDocuments } from '../features/organization-feature-manager.js';
import { assertWritablePath } from '../security/path-guard.js';
import { codeEndpoints, codeId, codeText, codeTime, type Endpoint } from './ssh-codes.js';

/** Remote login shell. Decides how the folder is entered and how output bytes are read. */
export type SshShell = 'posix' | 'cmd' | 'powershell';
const SSH_SHELLS: readonly SshShell[] = ['posix', 'cmd', 'powershell'];

export interface SshPairing {
  kind: 'host-pair' | 'ssh-invite'; hostLabel: string; endpoints: Endpoint[]; pairedAt: string;
  hostId?: string; deviceId?: string; inviteId?: string;
}
export interface SshServerProfile {
  pairing?: SshPairing;
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  /** Path of the private key file on this PC. The key body is never stored here. */
  keyPath: string;
  auth?: 'key' | 'password';
  jumpServerId?: string;
  defaultCwd?: string;
  /** Missing means `posix` (Linux/macOS). `cmd` / `powershell` are Windows servers. */
  shell?: SshShell;
  encoding?: 'utf8' | 'cp949';
  /** `SHA256:<base64>` of the trusted host key. Set only through trustSshServer. */
  hostKeySha256?: string;
  trustedAt?: string;
  /** Deployed by a signed Organization Feature: address, kind and fingerprint are read-only. */
  managed?: boolean;
  /** Label of the feature that deployed a managed connection. */
  managedBy?: string;
}

/** This PC's own account for a managed connection. Not a secret. */
export interface ManagedSshAccount {
  username: string;
  keyPath?: string;
}

export interface SshServersDoc {
  version: 1;
  servers: SshServerProfile[];
  /** Account per managed connection id. Written only when at least one is set. */
  managed?: Record<string, ManagedSshAccount>;
}

/** A connection deployed by an Organization Feature. The fingerprint is pinned. */
export interface ManagedSshConnection {
  id: string;
  label: string;
  host: string;
  port: number;
  auth: 'key' | 'password';
  shell?: SshShell;
  encoding?: 'utf8' | 'cp949';
  defaultCwd?: string;
  hostKeySha256: string;
  featureId: string;
  featureLabel?: string;
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
export function describeSshTarget(server: SshServerProfile & { jumpLabel?: string }): string {
  const via = server.jumpServerId ? ` · 경유: ${server.jumpLabel ?? server.jumpServerId}` : '';
  return `${server.label} (${server.username}@${server.host}:${server.port})${via}`;
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

const UNSAFE_LOGIN_RE = /[\s'"`$;|&<>\\]/;

export function isSshLoginPart(s: unknown, max: number): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= max && !UNSAFE_LOGIN_RE.test(s) && !/[\x00-\x1f\x7f]/.test(s);
}

function cleanPairing(raw: unknown): SshPairing {
  const p = raw as SshPairing;
  if (!p || (p.kind !== 'host-pair' && p.kind !== 'ssh-invite')) throw new SshProfileError('SSH_SERVER_INVALID','공유 연결 종류가 올바르지 않습니다.');
  return { kind: p.kind, hostLabel: codeText(p.hostLabel,80), endpoints: codeEndpoints(p.endpoints, p.kind === 'ssh-invite' ? 1 : 4), pairedAt: codeTime(p.pairedAt),
    ...(p.kind === 'host-pair' ? { hostId: codeId(p.hostId), deviceId: codeId(p.deviceId) } : { inviteId: codeId(p.inviteId) }) };
}

function cleanPort(value: unknown): number | null {
  const port = value === undefined || value === null || value === '' ? 22 : Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/** Keeps only schema fields. Returns a reason string when the row is unusable. */
function cleanServer(raw: unknown): SshServerProfile | string {
  if (!raw || typeof raw !== 'object') return 'server must be an object';
  const row = raw as Record<string, unknown>;
  const id = text(row.id, 40);
  if (!ID_RE.test(id)) return `invalid id: ${id || '(empty)'} (letters, digits, _ and - only)`;
  const host = text(row.host, 255);
  if (!host || UNSAFE_LOGIN_RE.test(host)) return `invalid host for ${id}`;
  const username = text(row.username, 64);
  if (!username || UNSAFE_LOGIN_RE.test(username)) return `invalid username for ${id}`;
  const keyPath = text(row.keyPath, 1024);
  if (row.auth !== undefined && row.auth !== 'key' && row.auth !== 'password') return `unsupported auth for ${id}`;
  if (row.auth !== 'password' && !keyPath) return `keyPath required for ${id}`;
  const portRaw = cleanPort(row.port);
  if (portRaw === null) return `invalid port for ${id}`;
  const defaultCwd = text(row.defaultCwd, 1024);
  if (/[\r\n\0]/.test(defaultCwd)) return `invalid defaultCwd for ${id}`;
  const server: SshServerProfile = {
    id,
    label: text(row.label, 80) || id,
    host,
    port: portRaw,
    username,
    keyPath: row.auth === 'password' ? '' : keyPath,
    ...(row.auth ? { auth: row.auth } : {}),
    ...(row.jumpServerId ? { jumpServerId: String(row.jumpServerId) } : {}),
  };
  if (row.encoding === 'utf8' || row.encoding === 'cp949') server.encoding = row.encoding;
  if (defaultCwd) server.defaultCwd = defaultCwd;
  if (SSH_SHELLS.includes(row.shell as SshShell)) server.shell = row.shell as SshShell;
  if (isSshFingerprint(row.hostKeySha256)) {
    server.hostKeySha256 = row.hostKeySha256;
    const trustedAt = text(row.trustedAt, 40);
    if (trustedAt) server.trustedAt = trustedAt;
  }
  if (row.pairing !== undefined) {
    try { server.pairing = cleanPairing(row.pairing); } catch { return 'invalid sharing metadata'; }
    if (!server.hostKeySha256 || server.jumpServerId || server.auth !== 'key') return 'invalid shared server';
  }
  return server;
}

function cleanManagedAccounts(raw: unknown): Record<string, ManagedSshAccount> {
  const out: Record<string, ManagedSshAccount> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>).slice(0, MAX_SERVERS)) {
    if (!ID_RE.test(id) || !value || typeof value !== 'object') continue;
    const row = value as Record<string, unknown>;
    const username = text(row.username, 64);
    if (!username || UNSAFE_LOGIN_RE.test(username)) continue;
    const keyPath = text(row.keyPath, 1024);
    out[id] = { username, ...(keyPath ? { keyPath } : {}) };
  }
  return out;
}

export function loadSshServers(cqrRoot: string): SshServersDoc {
  const file = sshServersPath(cqrRoot);
  if (!existsSync(file)) return { version: 1, servers: [] };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { servers?: unknown; managed?: unknown };
    const rows = Array.isArray(raw?.servers) ? raw.servers : [];
    const servers: SshServerProfile[] = [];
    for (const row of rows.slice(0, MAX_SERVERS)) {
      const cleaned = cleanServer(row);
      if (typeof cleaned !== 'string' && !servers.some((s) => s.id === cleaned.id)) servers.push(cleaned);
    }
    const managed = cleanManagedAccounts(raw?.managed);
    return { version: 1, servers, ...(Object.keys(managed).length ? { managed } : {}) };
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

/** Only schema fields; the pinned fingerprint is required, a secret field is never read. */
function cleanManagedConnection(raw: unknown, featureId: string, featureLabel?: string): ManagedSshConnection | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const id = text(row.id, 40);
  if (!ID_RE.test(id)) return null;
  const host = text(row.host, 255);
  if (!host || UNSAFE_LOGIN_RE.test(host)) return null;
  const port = cleanPort(row.port);
  if (port === null) return null;
  const fingerprint = row.host_key_sha256 ?? row.hostKeySha256;
  if (!isSshFingerprint(fingerprint)) return null;
  const defaultCwd = text(row.default_cwd ?? row.defaultCwd, 1024);
  if (/[\r\n\0]/.test(defaultCwd)) return null;
  const connection: ManagedSshConnection = {
    id,
    label: text(row.label, 80) || id,
    host,
    port,
    auth: row.auth === 'key' ? 'key' : 'password',
    hostKeySha256: fingerprint,
    featureId,
    ...(featureLabel ? { featureLabel } : {}),
  };
  if (SSH_SHELLS.includes(row.shell as SshShell)) connection.shell = row.shell as SshShell;
  if (row.encoding === 'utf8' || row.encoding === 'cp949') connection.encoding = row.encoding;
  if (defaultCwd) connection.defaultCwd = defaultCwd;
  return connection;
}

/** Connections deployed by enabled Organization Features (`{ connections: [...] }`). */
export function listManagedSshConnections(cqrRoot: string): ManagedSshConnection[] {
  const out: ManagedSshConnection[] = [];
  for (const { featureId, featureLabel, document } of readEnabledFeatureEntrypointDocuments(cqrRoot, 'managed_ssh_connections')) {
    const rows = (document as { connections?: unknown } | null)?.connections;
    if (!Array.isArray(rows)) continue;
    for (const row of rows.slice(0, MAX_SERVERS)) {
      const connection = cleanManagedConnection(row, featureId, featureLabel);
      if (connection && !out.some((c) => c.id === connection.id)) out.push(connection);
    }
  }
  return out;
}

function managedProfile(connection: ManagedSshConnection, account?: ManagedSshAccount): SshServerProfile {
  return {
    id: connection.id,
    label: connection.label,
    host: connection.host,
    port: connection.port,
    username: account?.username ?? '',
    keyPath: connection.auth === 'key' ? account?.keyPath ?? '' : '',
    auth: connection.auth,
    ...(connection.defaultCwd ? { defaultCwd: connection.defaultCwd } : {}),
    ...(connection.shell ? { shell: connection.shell } : {}),
    ...(connection.encoding ? { encoding: connection.encoding } : {}),
    hostKeySha256: connection.hostKeySha256,
    managed: true,
    ...(connection.featureLabel ? { managedBy: connection.featureLabel } : {}),
  };
}

/**
 * Every usable server: this PC's own servers, then managed connections. A local row with
 * the id of a managed connection is shadowed (kept on disk, not used).
 */
export function listSshProfiles(cqrRoot: string): SshServerProfile[] {
  const doc = loadSshServers(cqrRoot);
  const managed = listManagedSshConnections(cqrRoot).map((connection) => managedProfile(connection, doc.managed?.[connection.id]));
  const managedIds = new Set(managed.map((server) => server.id));
  return [...doc.servers.filter((server) => !managedIds.has(server.id)), ...managed];
}

export function findSshServer(cqrRoot: string, id: string): (SshServerProfile & { jumpLabel?: string }) | null {
  const wanted = String(id ?? '').trim();
  if (!wanted) return null;
  const servers = listSshProfiles(cqrRoot);
  const server = servers.find(s => s.id === wanted);
  return server?.jumpServerId ? { ...server, jumpLabel: servers.find(s => s.id === server.jumpServerId)?.label } : server ?? null;
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
  const managedIds = new Set(listManagedSshConnections(cqrRoot).map((connection) => connection.id));
  const servers: SshServerProfile[] = [];
  for (const raw of rawServers) {
    const row = (raw ?? {}) as Partial<SshServerProfile>;
    const original = prev.servers.find(s => s.id === text(row.id,40));
    const cleaned = cleanServer(original?.pairing ? { ...original, label: row.label ?? original.label, defaultCwd: row.defaultCwd } : { ...row, pairing: undefined });
    if (typeof cleaned === 'string') throw new SshProfileError('SSH_SERVER_INVALID', cleaned);
    if (servers.some((s) => s.id === cleaned.id)) {
      throw new SshProfileError('SSH_SERVER_DUPLICATE', `duplicate id: ${cleaned.id}`);
    }
    if (managedIds.has(cleaned.id)) {
      throw new SshProfileError('SSH_SERVER_DUPLICATE', `관리형 연결과 같은 ID는 쓸 수 없습니다: ${cleaned.id}`);
    }
    if (!cleaned.pairing) assertNotAppKey(cqrRoot, cleaned.keyPath);
    delete cleaned.hostKeySha256;
    delete cleaned.trustedAt;
    const before = prev.servers.find((s) => s.id === cleaned.id);
    if (before?.hostKeySha256 && before.host === cleaned.host && before.port === cleaned.port && before.jumpServerId === cleaned.jumpServerId) {
      cleaned.hostKeySha256 = before.hostKeySha256;
      if (before.trustedAt) cleaned.trustedAt = before.trustedAt;
    }
    servers.push(cleaned);
  }
  for (const server of servers) {
    if (!server.jumpServerId) continue;
    const jump = servers.find(s => s.id === server.jumpServerId);
    if (jump?.pairing) throw new SshProfileError('SSH_APP_KEY_NO_JUMP', '공유 연결은 경유 서버로 쓸 수 없습니다.');
    if (!jump || jump.jumpServerId) throw new SshProfileError('SSH_SERVER_INVALID', '경유 서버는 등록된 다른 직접 연결 서버여야 합니다.');
  }
  // Rows shadowed by a managed connection are not shown in Settings; keep them unchanged.
  const shadowed = prev.servers.filter((server) => managedIds.has(server.id));
  const doc: SshServersDoc = {
    version: 1,
    servers: [...servers, ...shadowed],
    ...(prev.managed ? { managed: prev.managed } : {}),
  };
  writeDoc(cqrRoot, doc);
  // A shadowed id belongs to the managed connection now; its secret must survive this save.
  const keyChangedIds = prev.servers
    .filter((before) => {
      if (managedIds.has(before.id)) return false;
      const after = servers.find((s) => s.id === before.id);
      return !after || after.keyPath !== before.keyPath || after.host !== before.host || after.port !== before.port || after.username !== before.username || (after.auth ?? 'key') !== (before.auth ?? 'key') || after.jumpServerId !== before.jumpServerId;
    })
    .map((s) => s.id);
  return { doc, keyChangedIds };
}

export function deviceKeyPath(root: string) { return path.resolve(root, 'data','config','ssh-device-key'); }
function assertNotAppKey(root: string, file: string) {
  if (!file) return;
  const norm = (s: string) => path.resolve(s).replace(/^\\\\\?\\/, '').replace(/[. ]+$/, '').toLowerCase();
  for (const reserved of [deviceKeyPath(root), path.join(root,'data','config','ssh-host-key')]) {
    let same = norm(file) === norm(reserved);
    if (!same && existsSync(reserved) && existsSync(file)) {
      const a = statSync(reserved, { bigint: true }), b = statSync(file, { bigint: true });
      same = a.ino !== 0n && a.ino === b.ino && a.dev === b.dev;
    }
    if (same) throw new SshProfileError('SSH_APP_KEY_RESERVED', '앱이 만든 열쇠는 공유 연결에서만 씁니다.');
  }
}
export function assertSshRowAction(root: string, id: string, action: string) {
  if (!['lock','forget','unlock','trust','account'].includes(action.replace(/^\//,''))) return;
  if (!ID_RE.test(id) || findSshServer(root,id)?.pairing) throw new SshProfileError('SSH_APP_KEY_READONLY','공유 연결의 열쇠와 지문은 직접 바꿀 수 없습니다.');
}
/** Only the pinned code path may create a shared row. Existing IDs never change ownership. */
export function savePairedSshServer(root: string, row: SshServerProfile): SshServerProfile {
  const doc = loadSshServers(root);
  const p = cleanPairing(row.pairing);
  const previous = doc.servers.find(s => s.id === row.id);
  if (listManagedSshConnections(root).some(s => s.id === row.id) || (previous && (!previous.pairing || previous.hostKeySha256 !== row.hostKeySha256 || previous.username !== row.username || previous.pairing.kind !== p.kind || (p.kind === 'host-pair' && previous.pairing.hostId !== p.hostId)))) {
    throw new SshProfileError('SSH_PAIR_HOST_MISMATCH','저장된 서버와 지문 또는 계정이 다릅니다.');
  }
  if (!previous && doc.servers.length >= MAX_SERVERS) throw new SshProfileError('SSH_TOO_MANY_SERVERS','서버 목록이 가득 찼습니다.');
  const value = previous?.pairing ? { ...previous, host: row.host, port: row.port, pairing: { ...previous.pairing, endpoints: p.endpoints } } : { ...row, auth: 'key', keyPath: deviceKeyPath(root), pairing: p, trustedAt: new Date().toISOString() };
  const cleaned = cleanServer(value);
  if (typeof cleaned === 'string' || !cleaned.pairing) throw new SshProfileError('SSH_SERVER_INVALID','공유 연결 정보가 올바르지 않습니다.');
  doc.servers = previous ? doc.servers.map(s => s.id === row.id ? cleaned : s) : [...doc.servers, cleaned];
  writeDoc(root,doc);
  return cleaned;
}
/** Roll back just our revision; never replace an unrelated row edited while login was pending. */
export function undoPairedSave(root: string, saved: SshServerProfile, before?: SshServerProfile) {
  const doc = loadSshServers(root);
  if (!doc.servers.some(s => s.id === saved.id && JSON.stringify(s) === JSON.stringify(saved))) return false;
  doc.servers = doc.servers.flatMap(s => s.id !== saved.id ? [s] : before ? [before] : []);
  writeDoc(root,doc); return true;
}

/** Record the host key the user confirmed. */
export function trustSshServer(cqrRoot: string, id: string, fingerprint: string): SshServerProfile {
  assertSshRowAction(cqrRoot,id,'trust');
  if (!isSshFingerprint(fingerprint)) {
    throw new SshProfileError('SSH_FINGERPRINT_INVALID', 'fingerprint must look like SHA256:<base64>');
  }
  if (listManagedSshConnections(cqrRoot).some((connection) => connection.id === id)) {
    throw new SshProfileError(
      'SSH_MANAGED_READONLY',
      '배포된 관리형 연결의 지문은 바꿀 수 없습니다. 서버가 다른 지문을 보내면 연결하지 않으니 운영 담당자에게 알리세요.',
    );
  }
  const doc = loadSshServers(cqrRoot);
  const server = doc.servers.find((s) => s.id === id);
  if (!server) throw new SshProfileError('SSH_SERVER_NOT_FOUND', `unknown server: ${id}`);
  server.hostKeySha256 = fingerprint;
  server.trustedAt = new Date().toISOString();
  writeDoc(cqrRoot, doc);
  return server;
}

/**
 * This PC's account (and key file for key auth) for a managed connection. `changed` tells
 * the caller to drop the in-memory and remembered secret of the old account.
 */
export function saveManagedSshAccount(
  cqrRoot: string,
  id: string,
  raw: { username?: unknown; keyPath?: unknown },
): { changed: boolean } {
  const connection = listManagedSshConnections(cqrRoot).find((item) => item.id === id);
  if (!connection) throw new SshProfileError('SSH_SERVER_NOT_FOUND', `unknown managed connection: ${id}`);
  const username = text(raw.username, 64);
  if (!username || UNSAFE_LOGIN_RE.test(username)) {
    throw new SshProfileError('SSH_SERVER_INVALID', '계정에는 공백이나 따옴표·특수 기호를 쓸 수 없습니다.');
  }
  const keyPath = connection.auth === 'key' ? text(raw.keyPath, 1024) : '';
  assertNotAppKey(cqrRoot,keyPath);
  if (connection.auth === 'key' && !keyPath) throw new SshProfileError('SSH_SERVER_INVALID', '키 파일을 고르세요.');
  const doc = loadSshServers(cqrRoot);
  const before = doc.managed?.[id];
  const next: ManagedSshAccount = { username, ...(keyPath ? { keyPath } : {}) };
  const changed = before?.username !== next.username || (before?.keyPath ?? '') !== (next.keyPath ?? '');
  if (changed) writeDoc(cqrRoot, { ...doc, managed: { ...(doc.managed ?? {}), [id]: next } });
  return { changed };
}

export interface SshKeyCandidate {
  name: string;
  path: string;
}

const KEY_HEADER_RE = /^(?:-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----|PuTTY-User-Key-File-\d+:)/;
const NOT_A_KEY_NAME_RE = /(?:\.pub|\.old|\.bak|\.tmp)$|^(?:known_hosts.*|config|authorized_keys.*|environment)$/i;

/**
 * Private key files in `~/.ssh`, by name and path. Only the first bytes are read to see the
 * key header; the key body is never returned.
 */
export function listSshKeyCandidates(homeDir: string = os.homedir()): { dir: string; candidates: SshKeyCandidate[] } {
  const dir = path.join(homeDir, '.ssh');
  const candidates: SshKeyCandidate[] = [];
  let names: string[];
  try {
    names = readdirSync(dir).sort((a, b) => a.localeCompare(b));
  } catch {
    return { dir, candidates };
  }
  for (const name of names) {
    if (candidates.length >= 30) break;
    if (NOT_A_KEY_NAME_RE.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const st = statSync(file);
      if (!st.isFile() || st.size === 0 || st.size > 64 * 1024) continue;
      const fd = openSync(file, 'r');
      try {
        const head = Buffer.alloc(64);
        const read = readSync(fd, head, 0, head.length, 0);
        if (KEY_HEADER_RE.test(head.subarray(0, read).toString('utf8').replace(/^\uFEFF/, ''))) {
          candidates.push({ name, path: file });
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      /* unreadable file: not offered */
    }
  }
  return { dir, candidates };
}
