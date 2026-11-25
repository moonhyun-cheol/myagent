import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertWritablePath } from '../security/path-guard.js';
import { createAppKey, loadAppKey, writePublicJson } from './ssh-app-keys.js';
import { codeFingerprint, codeId, codeText, codeTime, keyFingerprint } from './ssh-codes.js';
import { redactSshOutput, SshError } from './ssh-service.js';

export interface HostDevice { id:string; label:string; username:string; publicKey:string; fingerprint:string; caps:['exec']; pairedAt:string; lastSeenAt:string }
export interface HostConfig { hostId:string; label:string; port:number; shell:'powershell'|'cmd'; defaultCwd:string; autoStart:boolean; hostKeySha256:string; devices:HostDevice[] }
const file = (root:string) => path.join(root,'data','config','ssh-host.json');
export function readHost(root:string): HostConfig {
  if (!existsSync(file(root))) return { hostId:'',label:os.hostname(),port:0,shell:'powershell',defaultCwd:os.homedir(),autoStart:false,hostKeySha256:'',devices:[] };
  try {
    const h = JSON.parse(readFileSync(file(root),'utf8'));
    if (!['cmd','powershell'].includes(h.shell) || !Number.isInteger(h.port) || h.port < 0 || h.port > 65535 || !Array.isArray(h.devices) || h.devices.length > 20) throw Error();
    const devices: HostDevice[] = h.devices.map((d:HostDevice) => {
      const fp = keyFingerprint(d.publicKey);
      if (!/^d-[a-z0-9]{8}$/.test(d.username) || fp !== d.fingerprint || d.caps?.length !== 1 || d.caps[0] !== 'exec') throw Error();
      return { id:codeId(d.id),label:codeText(d.label,80),username:d.username,publicKey:d.publicKey,fingerprint:fp,caps:['exec'],pairedAt:codeTime(d.pairedAt),lastSeenAt:codeTime(d.lastSeenAt) };
    });
    return { hostId:codeId(h.hostId),label:codeText(h.label,80),port:h.port,shell:h.shell,defaultCwd:codeText(h.defaultCwd,1024),autoStart:h.autoStart === true,hostKeySha256:h.hostKeySha256 === '' ? '' : codeFingerprint(h.hostKeySha256),devices };
  } catch { throw new SshError('SSH_HOST_CONFIG_INVALID','이 PC 서버 설정을 읽을 수 없습니다. 서버를 열지 않았습니다.'); }
}
export function saveHost(root:string,h:HostConfig) {
  if (!h.hostId) h.hostId = randomUUID();
  writePublicJson(root,file(root),h);
}
/** Single access path to the host identity. A lost pinned identity must not silently rotate. */
export async function loadHostKey(root:string,h:HostConfig) {
  const keyFile = path.join(root,'data','config','ssh-host-key'), id = '@ssh-host-key';
  const key = existsSync(keyFile) || h.hostKeySha256 ? await loadAppKey(root,keyFile,id) : await createAppKey(root,keyFile,id);
  const fingerprint = keyFingerprint(key.publicKey);
  if (h.hostKeySha256 && h.hostKeySha256 !== fingerprint) throw new SshError('SSH_PAIR_HOST_MISMATCH','저장된 서버 지문과 열쇠가 다릅니다.');
  return { key:key.key,passphrase:key.passphrase,fingerprint };
}
export function pairDevice(root:string, publicKey:string, label:unknown) {
  const h = readHost(root), fingerprint = keyFingerprint(publicKey), name = codeText(label,80), now = new Date().toISOString();
  let d = h.devices.find(x => x.publicKey === publicKey);
  if (!d) {
    if (h.devices.length >= 20) throw new SshError('SSH_HOST_DEVICE_LIMIT','연결된 기기가 20대입니다. 쓰지 않는 기기를 끊으세요.');
    // The same identity can pair again after revocation without unlocking or replacing a pinned row.
    const id = createHash('sha256').update(publicKey).digest('hex').slice(0,32);
    let username = 'd-'+id.slice(0,8);
    for (let n=1;h.devices.some(x=>x.username===username);n++) username = 'd-'+createHash('sha256').update(id+':'+n).digest('hex').slice(0,8);
    d = { id,label:name,username,publicKey,fingerprint,caps:['exec'],pairedAt:now,lastSeenAt:now }; h.devices.push(d);
  } else d.lastSeenAt = now;
  saveHost(root,h); return d;
}
export interface HostAudit { time:string; device:string; ip:string; command:string; cwd:string; exitCode:number|null; durationMs:number; result:string }
const auditFile = (root:string) => path.join(root,'logs','ssh-host-audit.jsonl');
function scrub(value:string) {
  return redactSshOutput(value).replace(/MYAGENT-SSH1\.[A-Za-z0-9_-]+|\b[A-Z2-7]{32}\b/g,'[가림]');
}
export function appendHostAudit(root:string, row:HostAudit) {
  const f = auditFile(root); assertWritablePath(f,root); mkdirSync(path.dirname(f),{ recursive:true });
  appendFileSync(f,JSON.stringify({ ...row,device:scrub(row.device),command:scrub(row.command).slice(0,300),cwd:scrub(row.cwd) })+'\n');
  if (statSync(f).size <= 1024*1024) return;
  const data = readFileSync(f), newline = data.indexOf(10,Math.floor(data.length/2));
  const tmp = f+'.tmp'; assertWritablePath(tmp,root); writeFileSync(tmp,data.subarray(newline+1)); renameSync(tmp,f);
}
export function recentHostAudit(root:string):HostAudit[] {
  const f = auditFile(root); if (!existsSync(f)) return [];
  return readFileSync(f,'utf8').trimEnd().split('\n').slice(-20).reverse().flatMap(line => { try {return [JSON.parse(line) as HostAudit];} catch {return [];} });
}
