import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertWritablePath } from '../security/path-guard.js';
import { codeText, codeTime, encodeCode, keyFingerprint } from './ssh-codes.js';
import { deviceKeyPath, findSshServer } from './ssh-profile-store.js';
import { recallPassphrase, rememberPassphrase, forgetPassphrase } from './ssh-secret-store.js';
import { SshError } from './ssh-service.js';

type Lib = typeof import('ssh2');
export async function loadAppSsh2(): Promise<Lib> {
  try { const mod = await import('ssh2'); return mod.default ?? mod; }
  catch { throw new SshError('SSH_RUNTIME_MISSING','이 설치본에는 SSH 구성 요소가 없습니다. 앱을 업데이트하세요.'); }
}
export function writePublicJson(root: string, file: string, value: unknown) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  assertWritablePath(file,root); assertWritablePath(tmp,root);
  mkdirSync(path.dirname(file),{ recursive: true });
  try { writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{ flag:'wx',mode:0o600 }); renameSync(tmp,file); }
  finally { rmSync(tmp,{ force:true }); }
}
const unreadable = () => new SshError('SSH_APP_KEY_UNREADABLE','이 PC의 열쇠를 열지 못했습니다. 새 코드로 다시 연결하세요.');
const unavailable = () => new SshError('SSH_APP_KEY_SECRET_UNAVAILABLE','이 Windows 계정의 안전 저장소를 사용할 수 없습니다.');
export async function createAppKey(root: string, file: string, secretId: string) {
  const { utils } = await loadAppSsh2();
  assertWritablePath(file,root);
  mkdirSync(path.dirname(file),{ recursive:true });
  const passphrase = randomBytes(32).toString('base64url');
  const pair = utils.generateKeyPairSync('ed25519',{ passphrase,cipher:'aes256-ctr',rounds:16 });
  // Never overwrite an existing identity or generate a plaintext fallback.
  writeFileSync(file,pair.private,{ flag:'wx',mode:0o600 });
  try {
    if (!(await rememberPassphrase(root,secretId,passphrase))) throw unavailable();
    return { key: Buffer.from(pair.private),passphrase,publicKey: pair.public.trim().split(/\s+/).slice(0,2).join(' ') };
  } catch (err) { rmSync(file,{ force:true }); throw err; }
}
export async function loadAppKey(root: string,file: string,secretId: string) {
  const { utils } = await loadAppSsh2();
  try {
    const key = readFileSync(file), passphrase = await recallPassphrase(root,secretId);
    if (!passphrase || !(utils.parseKey(key) instanceof Error)) throw unreadable();
    const parsed = utils.parseKey(key,passphrase);
    if (parsed instanceof Error || parsed.type !== 'ssh-ed25519' || !parsed.isPrivateKey()) throw unreadable();
    return { key,passphrase,publicKey:'ssh-ed25519 '+parsed.getPublicSSH().toString('base64') };
  } catch { throw unreadable(); }
}
const keyId = '@device-key';
export interface DeviceKeyInfo { device_label: string; public_key: string; key_fp: string; created_at: string }
export function deviceKeyInfo(root: string): DeviceKeyInfo | null {
  const file = deviceKeyPath(root)+'.json';
  if (!existsSync(file)) return null;
  try {
    const p = JSON.parse(readFileSync(file,'utf8'));
    if (keyFingerprint(p.public_key) !== p.key_fp) throw unreadable();
    return { device_label:codeText(p.device_label,80),public_key:p.public_key,key_fp:p.key_fp,created_at:codeTime(p.created_at) };
  } catch { throw unreadable(); }
}
const pending = new Map<string,Promise<DeviceKeyInfo>>();
export function ensureDeviceKey(root: string): Promise<DeviceKeyInfo> {
  const file = deviceKeyPath(root), held = pending.get(file);
  if (held) return held;
  const work = (async () => {
    const current = deviceKeyInfo(root);
    if (current) {
      const actual = await loadAppKey(root,file,keyId);
      if (actual.publicKey !== current.public_key) throw unreadable();
      return current;
    }
    if (existsSync(file)) throw unreadable();
    const key = await createAppKey(root,file,keyId);
    const info: DeviceKeyInfo = { device_label:os.hostname(), public_key:key.publicKey,key_fp:keyFingerprint(key.publicKey),created_at:new Date().toISOString() };
    try { writePublicJson(root,file+'.json',info); } catch (e) { rmSync(file); forgetPassphrase(root,keyId); throw e; }
    return info;
  })().finally(() => pending.delete(file));
  pending.set(file,work); return work;
}
export async function renameDeviceKey(root: string,name: unknown) {
  const device_label = codeText(name,80), info = { ...await ensureDeviceKey(root),device_label };
  writePublicJson(root,deviceKeyPath(root)+'.json',info); return info;
}
export const deviceKeyCode = (info: DeviceKeyInfo) => encodeCode({ v:1,kind:'key-request',...info });
export async function bindDeviceKey(root: string,id: string) {
  const current = () => findSshServer(root,id)?.pairing !== undefined;
  const pass = await recallPassphrase(root,keyId);
  if (!pass) throw unreadable();
  if (!current() || !(await rememberPassphrase(root,id,pass,current))) throw unavailable();
}
