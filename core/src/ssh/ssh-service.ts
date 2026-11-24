/**
 * SSH v1: host-key pinned, one remote command per call.
 *
 * - The host key must be trusted first (probe -> user confirms -> trust). Untrusted servers
 *   are refused before any connection; a different key aborts the handshake.
 * - Key passphrases are kept in this process. Only when the user ticks 「이 PC에 기억」 is a
 *   DPAPI-encrypted copy stored (ssh-secret-store); the plain value is never written to disk.
 * - `ssh2` is loaded on first use, so a PC whose node_modules predates this feature still
 *   starts the core and gets SSH_RUNTIME_MISSING instead of a crash.
 * - Managed connections (signed Organization Feature) arrive with a pinned fingerprint, so
 *   they need no 「이 지문 신뢰」; a different host key is refused like any trusted server.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import type { Client, ClientChannel, ConnectConfig } from 'ssh2';
import { SECRET_MATERIAL_RE } from '../agent/agent-hooks.js';
import {
  describeSshTarget,
  findSshServer,
  listSshProfiles,
  trustSshServer,
  type SshServerProfile,
  type SshShell,
} from './ssh-profile-store.js';
import {
  forgetPassphrase,
  hasRememberedPassphrase,
  recallPassphrase,
  rememberPassphrase,
} from './ssh-secret-store.js';

type Ssh2Module = typeof import('ssh2');

export class SshError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export const SSH_DEFAULT_TIMEOUT_MS = 30_000;
export const SSH_MAX_TIMEOUT_MS = 600_000;
export const SSH_MAX_OUTPUT_BYTES = 64 * 1024;
const CONNECT_TIMEOUT_MS = 15_000;

export type SshKeyState = 'ready' | 'locked' | 'missing' | 'invalid' | 'unknown';

export interface SshExecResult {
  state: 'ok' | 'timeout' | 'cancelled' | 'disconnected';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
}

export interface SshExecRequest {
  serverId: string;
  command: string;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
  /**
   * Internal callers only (fixed dataset export): keep up to this many output bytes from the
   * start instead of the 16KB head + 48KB tail window; more output sets `truncated`.
   */
  captureLimitBytes?: number;
}

/** In-process copy. Cleared on restart, key-file change, or server removal. */
const passphrases = new Map<string, string>();
/** Servers whose stored copy could not be decrypted in this process; not retried until changed. */
const recallFailed = new Set<string>();
/** Fingerprint last seen by a probe; trust accepts only this exact value. */
const lastProbed = new Map<string, string>();
/** One command per server at a time. */
const busyServers = new Set<string>();

let ssh2Promise: Promise<Ssh2Module> | null = null;

async function loadSsh2(): Promise<Ssh2Module> {
  if (!ssh2Promise) {
    ssh2Promise = import('ssh2').then((mod) => {
      const lib = (mod as unknown as { default?: Ssh2Module }).default ?? mod;
      return lib as Ssh2Module;
    });
  }
  try {
    return await ssh2Promise;
  } catch {
    ssh2Promise = null;
    throw new SshError('SSH_RUNTIME_MISSING', 'The ssh2 package is not installed in this MY Agent install.');
  }
}

export function sshFingerprint(hostKey: Buffer): string {
  return `SHA256:${createHash('sha256').update(hostKey).digest('base64').replace(/=+$/, '')}`;
}

export function redactSshOutput(text: string): string {
  if (!SECRET_MATERIAL_RE.test(text)) return text;
  return text
    .replace(/-----BEGIN[^\n-]*PRIVATE KEY-----[\s\S]*?(?:-----END[^\n-]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
    .replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED ACCESS KEY]');
}

/**
 * Enter the folder, then run the command; the folder is quoted so it cannot inject shell syntax.
 * - posix: `cd -- '<cwd>' && <command>`
 * - cmd: `cd /d "<cwd>" && <command>` (`"` and `%` cannot be quoted safely in cmd, so they are refused)
 * - powershell: `Set-Location -LiteralPath '<cwd>' -ErrorAction Stop; <command>` — without
 *   `-ErrorAction Stop` PowerShell would run the command in the wrong folder when cwd is missing.
 */
export function buildRemoteCommand(command: string, cwd?: string, shell: SshShell = 'posix'): string {
  const dir = String(cwd ?? '').trim();
  if (!dir) return command;
  if (shell === 'cmd') {
    if (/["%]/.test(dir)) throw new SshError('SSH_COMMAND_INVALID', 'cwd for a Windows(cmd) server cannot contain " or %');
    return `cd /d "${dir}" && ${command}`;
  }
  if (shell === 'powershell') {
    return `Set-Location -LiteralPath '${dir.replace(/'/g, "''")}' -ErrorAction Stop; ${command}`;
  }
  return `cd -- '${dir.replace(/'/g, `'\\''`)}' && ${command}`;
}

export interface SshOutputDecoder {
  write(data: Buffer): string;
  end(): string;
}

/**
 * posix servers send UTF-8. Windows servers (cmd / powershell) are read as euc-kr (CP949,
 * Korean Windows). Falls back to UTF-8 when this Node build has no euc-kr table.
 */
export function createSshOutputDecoder(shell: SshShell = 'posix', encoding?: SshServerProfile['encoding']): SshOutputDecoder {
  if (encoding === 'cp949' || (!encoding && shell !== 'posix')) {
    try {
      const decoder = new TextDecoder('euc-kr');
      return {
        write: (data) => decoder.decode(data, { stream: true }),
        end: () => decoder.decode(),
      };
    } catch { /* small-icu Node: keep UTF-8 */ }
  }
  const decoder = new StringDecoder('utf8');
  return { write: (data) => decoder.write(data), end: () => decoder.end() };
}

export function clampSshTimeout(timeoutMs: unknown): number {
  const n = Number(timeoutMs);
  if (!Number.isFinite(n) || n <= 0) return SSH_DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.round(n), 1_000), SSH_MAX_TIMEOUT_MS);
}

function readKeyFile(server: SshServerProfile): Buffer {
  if (!server.keyPath) {
    throw new SshError('SSH_KEY_NOT_FOUND', `No key file is selected for ${server.label}.`);
  }
  if (!existsSync(server.keyPath)) {
    throw new SshError('SSH_KEY_NOT_FOUND', `Key file not found: ${server.keyPath}`);
  }
  try {
    return readFileSync(server.keyPath);
  } catch {
    throw new SshError('SSH_KEY_NOT_FOUND', `Key file cannot be read: ${server.keyPath}`);
  }
}

/** null when the key parses with the given passphrase, else the ssh2 parser message. */
function keyParseProblem(lib: Ssh2Module, key: Buffer, passphrase?: string): string | null {
  const parsed = lib.utils.parseKey(key, passphrase) as unknown;
  return parsed instanceof Error ? parsed.message || 'unparsable key' : null;
}

function looksEncrypted(problem: string): boolean {
  return /passphrase|encrypted/i.test(problem);
}

/**
 * Passphrase for this key: the in-process copy, else the remembered one (loaded once).
 * A remembered passphrase that no longer opens the key is deleted from disk.
 */
const pendingRecall = new Map<string, Promise<string | undefined>>();
const mutations = new Map<string, symbol>();
interface Connection { client: Client; target: string; idle?: NodeJS.Timeout }
// Dedicated bastion transports, including probes and handshakes not yet in the idle pool.
const tunnels = new Map<Client, [string, string]>();
const connections = new Map<string, Connection>();
function closeConnection(id: string) {
  const entry = connections.get(id);
  if (!entry) return;
  connections.delete(id);
  clearTimeout(entry.idle);
  entry.client.destroy();
}
export function closeSshConnections() {
  for (const id of connections.keys()) closeConnection(id);
}
function invalidate(id: string) {
  for (const [client, [via, target]] of tunnels) {
    if (id === via || id === target) { closeConnection(target); client.destroy(); }
  }
  closeConnection(id);
  pendingRecall.delete(id);
  mutations.set(id, Symbol());
}
async function usablePassphrase(cqrRoot: string, lib: Ssh2Module, server: SshServerProfile, key?: Buffer): Promise<string | undefined> {
  const held = passphrases.get(server.id);
  if (held) return held;
  if (recallFailed.has(server.id) || !hasRememberedPassphrase(cqrRoot, server.id)) return undefined;
  const pending = pendingRecall.get(server.id);
  if (pending) return pending;
  const generation = mutations.get(server.id);
  const work = (async () => {
    const recalled = await recallPassphrase(cqrRoot, server.id);
    if (mutations.get(server.id) !== generation) return undefined;
    if (recalled === null) {
      recallFailed.add(server.id);
      return undefined;
    }
    if (key && keyParseProblem(lib, key, recalled)) {
      try { forgetPassphrase(cqrRoot, server.id); } catch { /* stays stored; rejected again next start */ }
      return undefined;
    }
    passphrases.set(server.id, recalled);
    return recalled;
  })();
  pendingRecall.set(server.id, work);
  try { return await work; } finally { if (pendingRecall.get(server.id) === work) pendingRecall.delete(server.id); }
}

async function keyStateOf(cqrRoot: string, server: SshServerProfile): Promise<SshKeyState> {
  let lib: Ssh2Module;
  try {
    lib = await loadSsh2();
  } catch {
    return 'unknown';
  }
  if (server.auth === 'password') return await usablePassphrase(cqrRoot, lib, server) ? 'ready' : 'locked';
  let key: Buffer;
  try {
    key = readKeyFile(server);
  } catch {
    return 'missing';
  }
  const problem = keyParseProblem(lib, key, await usablePassphrase(cqrRoot, lib, server, key));
  if (!problem) return 'ready';
  return looksEncrypted(problem) ? 'locked' : 'invalid';
}

/** Password auth, or a key file that does not open without a passphrase. */
async function secretRequired(server: SshServerProfile): Promise<boolean> {
  if (server.auth === 'password') return true;
  try {
    const lib = await loadSsh2();
    const problem = keyParseProblem(lib, readKeyFile(server));
    return Boolean(problem && looksEncrypted(problem));
  } catch {
    return false;
  }
}

export interface SshServerView extends SshServerProfile {
  trusted: boolean;
  keyState: SshKeyState;
  /** An encrypted copy of the key passphrase is stored on this PC. */
  remembered: boolean;
  rememberState: 'none' | 'stored' | 'unreadable';
  /** A password or key passphrase is needed to unlock (false for a key without passphrase). */
  needsSecret: boolean;
}

/** Settings view: every stored field plus trust and key state. Never a secret. */
export async function listSshServerViews(cqrRoot: string): Promise<SshServerView[]> {
  const servers = listSshProfiles(cqrRoot);
  return Promise.all(servers.map(async (server) => {
    // Key state first: it drops a remembered passphrase that no longer opens the key.
    const keyState = await keyStateOf(cqrRoot, server);
    const remembered = hasRememberedPassphrase(cqrRoot, server.id);
    return {
      ...server,
      trusted: Boolean(server.hostKeySha256),
      keyState,
      remembered,
      rememberState: !remembered ? 'none' : recallFailed.has(server.id) ? 'unreadable' : 'stored',
      needsSecret: await secretRequired(server),
    };
  }));
}

/** Model-facing view (`ssh_list_servers`): no key path, no fingerprint. */
export async function listSshServerSummaries(cqrRoot: string): Promise<Array<{
  id: string;
  label: string;
  target: string;
  defaultCwd?: string;
  shell: SshShell;
  auth: 'key' | 'password';
  encoding: 'utf8' | 'cp949';
  trusted: boolean;
  unlocked: boolean;
  keyState: SshKeyState;
  managed?: boolean;
}>> {
  const views = await listSshServerViews(cqrRoot);
  return views.map((server) => ({
    id: server.id,
    label: server.label,
    target: `${server.username || '?'}@${server.host}:${server.port}`,
    ...(server.defaultCwd ? { defaultCwd: server.defaultCwd } : {}),
    auth: server.auth ?? 'key',
    shell: server.shell ?? 'posix',
    encoding: server.encoding ?? (!server.shell || server.shell === 'posix' ? 'utf8' : 'cp949'),
    trusted: server.trusted,
    unlocked: server.keyState === 'ready',
    keyState: server.keyState,
    ...(server.managed ? { managed: true } : {}),
  }));
}

/** Key file changed or server removed: drop the in-process passphrase and the remembered copy. */
export function lockSshKey(cqrRoot: string, serverId: string): void {
  lastProbed.delete(serverId);
  invalidate(serverId);
  passphrases.delete(serverId);
  recallFailed.delete(serverId);
  forgetPassphrase(cqrRoot, serverId);
}

/** 「기억 지우기」: delete only the remembered copy. The key stays usable until restart. */
export function forgetSshKey(cqrRoot: string, serverId: string): void {
  requireServer(cqrRoot, serverId);
  invalidate(serverId);
  recallFailed.delete(serverId);
  forgetPassphrase(cqrRoot, serverId);
}

export async function retrySshRecall(cqrRoot: string, serverId: string) {
  const server = requireServer(cqrRoot, serverId);
  recallFailed.delete(serverId);
  await keyStateOf(cqrRoot, server);
}

/** Drops in-process passphrases only, as an app restart does. Used by verify scripts. */
export function clearSshPassphraseMemory(): void {
  closeSshConnections();
  passphrases.clear();
  recallFailed.clear();
}

/**
 * Keep the passphrase in memory after checking that it really opens the key file.
 * With `remember`, the verified passphrase is also stored encrypted on this PC.
 */
export async function unlockSshKey(cqrRoot: string, serverId: string, passphrase: string, remember = false): Promise<void> {
  const server = findSshServer(cqrRoot, serverId);
  if (!server) throw new SshError('SSH_SERVER_NOT_FOUND', `Unknown server: ${serverId}`);
  invalidate(serverId);
  const generation = mutations.get(serverId);
  const current = () => mutations.get(serverId) === generation;
  const lib = await loadSsh2();
  if (!current()) return;
  if (server.auth === 'password') {
    if (!passphrase) throw new SshError('SSH_AUTH_FAILED', '비밀번호를 입력하세요.');
    const client = await openAuthenticated(cqrRoot, lib, server, undefined, passphrase);
    if (client === 'cancelled') return;
    client.end();
    if (!current()) return;
  } else {
    const key = readKeyFile(server);
    const problem = keyParseProblem(lib, key, passphrase || undefined);
    if (problem) {
      throw new SshError(
        looksEncrypted(problem) || passphrase ? 'SSH_KEY_PASSPHRASE_WRONG' : 'SSH_KEY_INVALID',
        passphrase ? 'The passphrase does not open this key file.' : 'This key file needs a passphrase.',
      );
    }
  }
  if (passphrase) {
    passphrases.set(serverId, passphrase);
    if (remember && await rememberPassphrase(cqrRoot, serverId, passphrase, current)) recallFailed.delete(serverId);
  } else {
    passphrases.delete(serverId);
    forgetPassphrase(cqrRoot, serverId);
  }
}

function requireServer(cqrRoot: string, serverId: string): SshServerProfile {
  const server = findSshServer(cqrRoot, serverId);
  if (!server) throw new SshError('SSH_SERVER_NOT_FOUND', `Unknown server: ${serverId}`);
  return server;
}

/**
 * Read the host key fingerprint without trusting it and without authenticating: the
 * verifier rejects the handshake as soon as the key is seen, so no key or user is sent.
 */
export async function probeSshFingerprint(
  cqrRoot: string,
  serverId: string,
): Promise<{ fingerprint: string; trusted: boolean; changed: boolean }> {
  const server = requireServer(cqrRoot, serverId);
  const lib = await loadSsh2();
  const client: Client = new lib.Client();
  const tunnel = await openTunnel(cqrRoot, lib, server);
  const fingerprint = await new Promise<string>((resolve, reject) => {
    let seen = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try { client.destroy(); } catch { /* already closed */ }
      fn();
    };
    client.on('error', (error: Error) => finish(() => (seen
      ? resolve(seen)
      : reject(new SshError('SSH_CONNECT_FAILED', error.message || 'connection failed')))));
    client.on('close', () => finish(() => (seen
      ? resolve(seen)
      : reject(new SshError('SSH_CONNECT_FAILED', 'connection closed before the host key was received')))));
    client.on('ready', () => finish(() => resolve(seen)));
    try {
      client.connect({
        host: server.host,
        port: server.port,
        // The verifier aborts during key exchange, before any user name is sent.
        username: server.username || 'probe',
        sock: tunnel?.sock,
        readyTimeout: CONNECT_TIMEOUT_MS,
        hostVerifier: (key: Buffer) => {
          seen = sshFingerprint(key);
          return false;
        },
      });
    } catch (error) {
      finish(() => reject(new SshError('SSH_CONNECT_FAILED', error instanceof Error ? error.message : String(error))));
    }
  }).finally(() => tunnel?.via.destroy());
  if (!fingerprint) throw new SshError('SSH_CONNECT_FAILED', 'host key was not received');
  lastProbed.set(server.id, fingerprint);
  return {
    fingerprint,
    trusted: server.hostKeySha256 === fingerprint,
    changed: Boolean(server.hostKeySha256) && server.hostKeySha256 !== fingerprint,
  };
}

/** Trust only the fingerprint the last connection test actually returned for this server. */
export function trustProbedSshFingerprint(cqrRoot: string, serverId: string, fingerprint: string): SshServerProfile {
  if (lastProbed.get(serverId) !== fingerprint) {
    throw new SshError('SSH_FINGERPRINT_NOT_PROBED', 'Run the connection test first; only the fingerprint it returned can be trusted.');
  }
  return trustSshServer(cqrRoot, serverId, fingerprint);
}

function connectTrusted(
  lib: Ssh2Module,
  server: SshServerProfile,
  config: ConnectConfig,
  signal: AbortSignal | undefined,
): Promise<Client | 'cancelled'> {
  const client: Client = new lib.Client();
  return new Promise((resolve, reject) => {
    let seen = '';
    let settled = false;
    const onAbort = () => finish(() => {
      try { client.destroy(); } catch { /* already closed */ }
      resolve('cancelled');
    });
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const fail = (error: SshError) => finish(() => {
      try { client.destroy(); } catch { /* already closed */ }
      reject(error);
    });
    client.on('ready', () => finish(() => resolve(client)));
    client.on('error', (error: Error & { level?: string }) => {
      if (seen && seen !== server.hostKeySha256) {
        return fail(new SshError(
          'SSH_HOST_KEY_CHANGED',
          `Host key of ${describeSshTarget(server)} differs from the trusted fingerprint. Nothing was sent. The user must re-check it in Settings > SSH 서버.`,
        ));
      }
      if (error.level === 'client-authentication') {
        return fail(new SshError('SSH_AUTH_FAILED', 'The server rejected this user/key.'));
      }
      return fail(new SshError('SSH_CONNECT_FAILED', error.message || 'connection failed'));
    });
    client.on('close', () => fail(new SshError('SSH_CONNECT_FAILED', 'connection closed during handshake')));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      client.connect({
        host: server.host,
        port: server.port,
        username: server.username,
        ...config,
        readyTimeout: CONNECT_TIMEOUT_MS,
        hostVerifier: (key: Buffer) => {
          seen = sshFingerprint(key);
          return seen === server.hostKeySha256;
        },
      });
    } catch (error) {
      fail(new SshError('SSH_CONNECT_FAILED', error instanceof Error ? error.message : String(error)));
    }
  });
}

async function credentials(root: string, lib: Ssh2Module, server: SshServerProfile, password?: string): Promise<ConnectConfig> {
  if (!server.hostKeySha256) throw new SshError('SSH_HOST_NOT_TRUSTED', `${server.label}: 서버 지문을 먼저 신뢰하세요.`);
  if (!server.username) throw new SshError('SSH_ACCOUNT_REQUIRED', `${server.label}: 설정에서 계정을 먼저 입력하세요.`);
  if (server.auth === 'password') {
    password ??= await usablePassphrase(root, lib, server);
    if (!password) throw new SshError('SSH_KEY_LOCKED', '설정에서 비밀번호로 잠금을 해제하세요.');
    return { password, authHandler: ['password'] };
  }
  const privateKey = readKeyFile(server);
  const passphrase = await usablePassphrase(root, lib, server, privateKey);
  const problem = keyParseProblem(lib, privateKey, passphrase);
  if (problem) throw looksEncrypted(problem)
    ? new SshError('SSH_KEY_LOCKED', `The key for ${server.label} is locked.`)
    : new SshError('SSH_KEY_INVALID', `The key file for ${server.label} cannot be used.`);
  return { privateKey, passphrase };
}

async function openTunnel(root: string, lib: Ssh2Module, server: SshServerProfile, signal?: AbortSignal) {
  if (!server.jumpServerId) return;
  const jump = requireServer(root, server.jumpServerId);
  if (jump.jumpServerId) throw new SshError('SSH_SERVER_INVALID', '경유 서버는 한 단계만 사용할 수 있습니다.');
  const generation = mutations.get(jump.id);
  const via = await connectTrusted(lib, jump, await credentials(root, lib, jump), signal);
  if (via === 'cancelled') throw new SshError('SSH_CANCELLED', '연결이 취소됐습니다.');
  if (generation !== mutations.get(jump.id)) { via.destroy(); throw new SshError('SSH_KEY_LOCKED', '경유 서버 설정이 변경됐습니다.'); }
  tunnels.set(via, [jump.id, server.id]);
  via.once('close', () => tunnels.delete(via));
  const abort = () => via.destroy();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, CONNECT_TIMEOUT_MS);
  try {
    const sock = await new Promise<ClientChannel>((resolve, reject) => {
      const closed = () => reject(new SshError('SSH_CONNECT_FAILED', '경유 서버 연결이 종료됐습니다.'));
      via.once('close', closed);
      via.forwardOut('127.0.0.1', 0, server.host, server.port, (err, channel) => {
        via.off('close', closed);
        if (err) reject(new SshError('SSH_CONNECT_FAILED', '경유 서버에서 목적지로 연결하지 못했습니다.')); else resolve(channel);
      });
      if (signal?.aborted) abort();
    });
    return { via, sock };
  } catch (err) { via.destroy(); throw err; }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

async function openAuthenticated(root: string, lib: Ssh2Module, server: SshServerProfile, signal?: AbortSignal, password?: string) {
  const config = await credentials(root, lib, server, password);
  const tunnel = await openTunnel(root, lib, server, signal).catch(err => { if (!signal?.aborted) throw err; });
  if (signal?.aborted) { tunnel?.via.destroy(); return 'cancelled' as const; }
  try {
    const client = await connectTrusted(lib, server, { ...config, sock: tunnel?.sock }, signal);
    if (tunnel) {
      if (client === 'cancelled') tunnel.via.destroy();
      else client.once('close', () => tunnel.via.destroy());
    }
    return client;
  } catch (err) { tunnel?.via.destroy(); throw err; }
}

/** Run exactly one command on a trusted server. Approval is the caller's (step loop) duty. */
export async function execSshCommand(cqrRoot: string, req: SshExecRequest): Promise<SshExecResult> {
  const started = Date.now();
  const server = requireServer(cqrRoot, req.serverId);
  if (!server.hostKeySha256) {
    throw new SshError(
      'SSH_HOST_NOT_TRUSTED',
      `${describeSshTarget(server)} has no trusted host key. The user must run 연결 테스트 and 「이 지문 신뢰」 in Settings > SSH 서버.`,
    );
  }
  const command = String(req.command ?? '').trim();
  if (!command || command.includes('\0')) throw new SshError('SSH_COMMAND_INVALID', 'command is required');
  const cwd = String(req.cwd ?? '').trim() || server.defaultCwd || '';
  if (/[\r\n\0]/.test(cwd)) throw new SshError('SSH_COMMAND_INVALID', 'cwd must be a single path');
  const shell: SshShell = server.shell ?? 'posix';
  const remoteCommand = buildRemoteCommand(command, cwd, shell);
  const timeoutMs = clampSshTimeout(req.timeoutMs);
  const empty = (state: SshExecResult['state']): SshExecResult => ({
    state, exitCode: null, stdout: '', stderr: '', truncated: false, durationMs: Date.now() - started,
  });
  if (req.signal?.aborted) return empty('cancelled');
  if (busyServers.has(server.id)) {
    throw new SshError('SSH_SERVER_BUSY', `Another command is still running on ${server.label}. Wait for it to finish.`);
  }
  busyServers.add(server.id);
  try {
    const lib = await loadSsh2();
    const jump = server.jumpServerId ? requireServer(cqrRoot, server.jumpServerId) : null;
    const target = JSON.stringify([cqrRoot, server.host, server.port, server.username, server.keyPath, server.auth, server.hostKeySha256, jump]);
    let entry = connections.get(server.id);
    if (entry?.target !== target) { closeConnection(server.id); entry = undefined; }
    if (!entry) {
      const generation = mutations.get(server.id);
      const client = await openAuthenticated(cqrRoot, lib, server, req.signal);
      if (client === 'cancelled') return empty('cancelled');
      if (generation !== mutations.get(server.id)) { client.destroy(); return empty('disconnected'); }
      entry = { client, target };
      connections.set(server.id, entry);
      const discard = () => { if (connections.get(server.id)?.client === client) closeConnection(server.id); };
      client.once('close', discard).once('error', discard).once('end', discard);
    }
    clearTimeout(entry.idle);
    const connection = entry;
    const { client } = entry;
    return await new Promise<SshExecResult>((resolve) => {
      type Piece = { stream: 'stdout' | 'stderr'; data: Buffer };
      const head: Piece[] = [], tail: Piece[] = [];
      let headBytes = 0, tailBytes = 0, truncated = false;
      const capture = Number.isSafeInteger(req.captureLimitBytes) && (req.captureLimitBytes ?? 0) > 0 ? req.captureLimitBytes! : 0;
      const headLimit = capture || 16384;
      const tailLimit = capture ? 0 : 49152;
      const render = (stream: Piece['stream']) => {
        const decoder = () => createSshOutputDecoder(shell, server.encoding);
        const decode = (parts: Piece[]) => { const d = decoder(); return parts.filter(p => p.stream === stream).map(p => d.write(p.data)).join('') + d.end(); };
        if (!truncated) return redactSshOutput(decode([...head, ...tail]));
        const first = decode(head), last = decode(tail);
        return first || last ? redactSshOutput(first + '\n[… 생략 …]\n' + last) : '';
      };
      const live = { stdout: createSshOutputDecoder(shell, server.encoding), stderr: createSshOutputDecoder(shell, server.encoding) };
      let displayed = 0;
      let exitCode: number | null = null;
      let channel: ClientChannel | null = null;
      let settled = false;

      const settle = (state: SshExecResult['state']) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
        client.off('error', disconnected).off('close', disconnected).off('end', disconnected);
        if (connections.get(server.id) === connection) {
          if (state === 'ok') connection.idle = setTimeout(() => closeConnection(server.id), 60_000).unref();
          else closeConnection(server.id);
        }
        resolve({
          state,
          exitCode: state === 'ok' ? exitCode : null,
          stdout: render('stdout'),
          stderr: render('stderr'),
          truncated,
          durationMs: Date.now() - started,
        });
      };
      /** Stop the remote process first, then close; the result does not wait for the server. */
      const kill = (state: 'timeout' | 'cancelled') => {
        if (settled) return;
        try { channel?.signal('KILL'); } catch { /* server may not support signals */ }
        try { channel?.close(); } catch { /* already closed */ }
        settle(state);
      };
      const onAbort = () => kill('cancelled');
      const timer = setTimeout(() => kill('timeout'), timeoutMs);
      req.signal?.addEventListener('abort', onAbort, { once: true });

      const take = (stream: 'stdout' | 'stderr', data: Buffer) => {
        if (settled) return;
        const n = Math.min(data.length, headLimit - headBytes);
        if (n) { head.push({ stream, data: Buffer.from(data.subarray(0,n)) }); headBytes += n; }
        if (n < data.length) {
          tail.push({ stream, data: Buffer.from(data.subarray(n)) }); tailBytes += data.length - n;
          while (tailBytes > tailLimit) {
            truncated = true;
            const first = tail[0]!, drop = Math.min(first.data.length, tailBytes - tailLimit);
            if (drop === first.data.length) tail.shift(); else first.data = Buffer.from(first.data.subarray(drop));
            tailBytes -= drop;
          }
        }
        const count = Math.min(data.length, SSH_MAX_OUTPUT_BYTES - displayed);
        if (count && req.onOutput) {
          displayed += count;
          const chunk = live[stream].write(data.subarray(0, count));
          try { if (chunk) req.onOutput(stream, redactSshOutput(chunk)); } catch { /* display only */ }
        }
      };
      const disconnected = () => settle('disconnected');
      client.once('error', disconnected).once('close', disconnected).once('end', disconnected);
      if (req.signal?.aborted) return kill('cancelled');
      client.exec(remoteCommand, (error, stream) => {
        if (error) return settle('disconnected');
        channel = stream;
        if (settled) {
          try { stream.close(); } catch { /* already closed */ }
          return;
        }
        stream.on('data', (data: Buffer) => take('stdout', data));
        stream.stderr.on('data', (data: Buffer) => take('stderr', data));
        stream.on('exit', (code: number | null) => {
          exitCode = typeof code === 'number' ? code : null;
        });
        stream.on('error', disconnected);
        stream.on('close', () => settle(exitCode === null ? 'disconnected' : 'ok'));
      });
    });
  } finally {
    busyServers.delete(server.id);
  }
}
