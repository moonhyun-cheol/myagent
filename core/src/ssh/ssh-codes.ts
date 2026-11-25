import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { isSshFingerprint, isSshLoginPart, SshProfileError } from './ssh-profile-store.js';

export const CODE_KINDS = {
  'host-pair': { secret: true, caps: ['exec'], reservedCaps: ['forward', 'files'] },
  'key-request': { secret: false }, 'ssh-invite': { secret: false },
  cloud: { reserved: true, routes: ['aws-ssm', 'gcp-iap', 'azure-bastion'] },
} as const;
export const CODE_PREFIX = 'MYAGENT-SSH1.';
export type Endpoint = { type: 'lan' | 'tailscale' | 'name' | 'public'; host: string; port: number };
export type HostCode = { v: 1; kind: 'host-pair'; host_id: string; name: string; endpoints: Endpoint[]; host_key: string; shell: 'powershell' | 'cmd'; caps: 'exec'[]; pair: { token: string; expires_at: string } };
export type KeyCode = { v: 1; kind: 'key-request'; device_label: string; public_key: string; key_fp: string; created_at: string };
export type InviteCode = { v: 1; kind: 'ssh-invite'; invite_id: string; name: string; endpoints: Endpoint[]; host_key: string; username: string; shell: 'posix'; encoding: 'utf8' | 'cp949'; default_cwd?: string; key_fp: string; issued_at: string };
export type ConnectionCode = HostCode | KeyCode | InviteCode;
const invalid = (): never => { throw new SshProfileError('SSH_CODE_INVALID', '코드 형식이 올바르지 않습니다. 코드를 처음부터 끝까지 복사하세요.'); };
const unsupported = (): never => { throw new SshProfileError('SSH_CODE_UNSUPPORTED', '이 버전에서 지원하지 않는 코드 · 앱 업데이트 필요'); };
export function codeText(x: unknown, max: number): string {
  if (typeof x !== 'string' || !x.trim() || x.length > max || /[\x00-\x1f\x7f]/.test(x)) return invalid();
  return x.trim();
}
export function codeId(x: unknown): string {
  return typeof x === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,35}$/.test(x) ? x : invalid();
}
export function codeTime(value: unknown): string {
  const s = codeText(value, 40);
  return /^\d{4}-\d\d-\d\dT/.test(s) && Number.isFinite(Date.parse(s)) ? s : invalid();
}
export function codeFingerprint(x: unknown): string { return isSshFingerprint(x) ? x : invalid(); }
export function keyFingerprint(publicKey: unknown): string {
  const match = typeof publicKey === 'string' && /^ssh-ed25519 ([A-Za-z0-9+/]{68})$/.exec(publicKey);
  if (!match) return invalid();
  const blob = Buffer.from(match[1], 'base64');
  if (blob.length !== 51 || blob.readUInt32BE(0) !== 11 || blob.toString('ascii', 4, 15) !== 'ssh-ed25519' || blob.readUInt32BE(15) !== 32) return invalid();
  return `SHA256:${createHash('sha256').update(blob).digest('base64url').replace(/-/g, '+').replace(/_/g, '/')}`;
}
export function classifyEndpoint(host: string): Endpoint['type'] {
  if (!isIP(host)) return 'name';
  if (isIP(host) === 4) {
    const [a,b] = host.split('.').map(Number);
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'lan';
    if (a === 100 && b >= 64 && b <= 127) return 'tailscale';
  }
  return 'public';
}
export function codeEndpoints(raw: unknown, max = 4): Endpoint[] {
  if (!Array.isArray(raw) || raw.length > max) return invalid();
  const out: Endpoint[] = [];
  for (const ep of raw) {
    if (!ep || typeof ep !== 'object') return invalid();
    if (!['lan','tailscale','name','public'].includes(ep.type)) continue;
    if (!isSshLoginPart(ep.host, 255) || !Number.isInteger(ep.port) || ep.port < 1 || ep.port > 65535) return invalid();
    out.push({ type: classifyEndpoint(ep.host), host: ep.host, port: ep.port });
  }
  return out.length ? out : unsupported();
}
// Project onto the schema in both directions. Never forward arbitrary JSON fields into a file or code.
function normalize(raw: unknown): ConnectionCode {
  if (!raw || typeof raw !== 'object') return invalid();
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || typeof r.kind !== 'string' || !r.kind) return invalid();
  switch (r.kind) {
    case 'key-request': {
      const fp = keyFingerprint(r.public_key);
      if (r.key_fp !== fp) return invalid();
      return { v: 1, kind: r.kind, device_label: codeText(r.device_label, 80), public_key: String(r.public_key), key_fp: fp, created_at: codeTime(r.created_at) };
    }
    case 'host-pair': {
      const p = r.pair as HostCode['pair'] | null;
      if (!p || typeof p.token !== 'string' || !/^[A-Z2-7]{32}$/.test(p.token) || !Array.isArray(r.caps) || (r.shell !== 'cmd' && r.shell !== 'powershell')) return invalid();
      return { v: 1, kind: r.kind, host_id: codeId(r.host_id), name: codeText(r.name,80), endpoints: codeEndpoints(r.endpoints), host_key: codeFingerprint(r.host_key), shell: r.shell, caps: r.caps.includes('exec') ? ['exec'] : [], pair: { token: p.token, expires_at: codeTime(p.expires_at) } };
    }
    case 'ssh-invite': {
      if (!isSshLoginPart(r.username, 64) || r.shell !== 'posix' || (r.encoding !== 'utf8' && r.encoding !== 'cp949')) return invalid();
      return { v: 1, kind: r.kind, invite_id: codeId(r.invite_id), name: codeText(r.name,80), endpoints: codeEndpoints(r.endpoints,1), host_key: codeFingerprint(r.host_key), username: r.username, shell: r.shell, encoding: r.encoding, ...(r.default_cwd === undefined ? {} : { default_cwd: codeText(r.default_cwd,1024) }), key_fp: codeFingerprint(r.key_fp), issued_at: codeTime(r.issued_at) };
    }
    default: return unsupported();
  }
}
export function encodeCode(raw: ConnectionCode): string {
  const code = CODE_PREFIX + Buffer.from(JSON.stringify(normalize(raw))).toString('base64url');
  return code.length <= 4096 ? code : invalid();
}
export function decodeCode(input: unknown): ConnectionCode {
  if (typeof input !== 'string' || Buffer.byteLength(input) > 4096) return invalid();
  const code = input.trim();
  if (!code.startsWith(CODE_PREFIX)) return invalid();
  const payload = code.slice(CODE_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) return invalid();
  const bytes = Buffer.from(payload,'base64url');
  if (bytes.toString('base64url') !== payload) return invalid();
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return invalid(); }
  return normalize(raw);
}
