import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Client, ConnectConfig } from 'ssh2';
import { bindDeviceKey, ensureDeviceKey, loadAppKey, loadAppSsh2, writePublicJson, type DeviceKeyInfo } from './ssh-app-keys.js';
import { classifyEndpoint, codeId, codeText, decodeCode, encodeCode, type Endpoint, type HostCode, type InviteCode } from './ssh-codes.js';
import { deviceKeyPath, findSshServer, isSshLoginPart, listSshProfiles, savePairedSshServer, undoPairedSave, type SshServerProfile } from './ssh-profile-store.js';
import { lockSshKey, sshFingerprint, SshError } from './ssh-service.js';

const expired = () => new SshError('SSH_CODE_EXPIRED_OR_USED','코드가 만료됐거나 이미 사용됐습니다.');
const mismatch = () => new SshError('SSH_PAIR_HOST_MISMATCH','서버 지문이 코드나 저장된 연결과 달라 연결하지 않았습니다.');
const unreachable = () => new SshError('SSH_PAIR_UNREACHABLE','서버 PC가 꺼졌거나, 서버가 닫혔거나, 방화벽에 막혔습니다.');
export class InviteKeyNotAdded extends SshError {
  constructor(readonly serverId:string) { super('SSH_INVITE_KEY_NOT_ADDED','서버 관리자가 아직 열쇠를 넣지 않았습니다 · 연결 다시 확인'); }
}
const disallow = (message:string) => new SshError('SSH_INVITE_NOT_ALLOWED',message);

/** Keep one pinned transport, never offer the ticket or device signature to a runner-up. */
async function connectOne(endpoints:Endpoint[], pin:string, config:ConnectConfig, authError:()=>SshError) {
  const { Client } = await loadAppSsh2();
  return new Promise<{ client:Client; endpoint:Endpoint }>((resolve,reject)=>{
    const clients = new Set<Client>(); let elected:Client|undefined, settled = false, wrongKey = false;
    const fail = (err:SshError) => { if (settled) return; settled = true; clearTimeout(timer); for (const c of clients) c.destroy(); reject(err); };
    const timer = setTimeout(()=>fail(wrongKey && !elected ? mismatch() : unreachable()),6000);
    let remaining = endpoints.length;
    for (const endpoint of endpoints) {
      const client = new Client(); clients.add(client); let finished = false;
      const lost = (err?:Error & { level?:string })=>{
        if (finished || settled) return; finished = true; remaining--;
        if (elected === client) return fail(err?.level === 'client-authentication' ? authError() : unreachable());
        if (!remaining) fail(wrongKey ? mismatch() : unreachable());
      };
      client.on('error',lost).once('close',()=>lost());
      client.once('ready',()=>{
        if (settled || elected !== client) { client.destroy(); return; }
        settled = true; clearTimeout(timer); for (const c of clients) if (c !== client) c.destroy();
        resolve({ client,endpoint });
      });
      try { client.connect({ ...config,host:endpoint.host,port:endpoint.port,readyTimeout:6000,hostVerifier:(key:Buffer)=>{
        if (sshFingerprint(key) !== pin) { wrongKey = true; return false; }
        if (settled || (elected && elected !== client)) return false;
        elected = client; return true;
      } }); } catch { lost(); client.destroy(); }
    }
  });
}

async function registerDevice(client:Client,key:DeviceKeyInfo) {
  return new Promise<Record<string,unknown>>((resolve,reject)=>{
    const timer = setTimeout(()=>reject(unreachable()),6000);
    const closed = () => { clearTimeout(timer); reject(unreachable()); };
    client.once('close',closed).once('error',closed);
    client.subsys('myagent-pair@my-agent',(err,ch)=>{
      if (err) return closed(); let data = Buffer.alloc(0);
      ch.on('error',closed).on('data',(buf:Buffer)=>{
        if (data.length+buf.length > 4096) { closed(); client.destroy(); return; }
        data = Buffer.concat([data,buf]);
      });
      ch.once('end',()=>{ clearTimeout(timer); try { const r = JSON.parse(data.toString()); if (!r || r.error) throw Error(); resolve(r); } catch { reject(new SshError('SSH_PAIR_REJECTED','서버가 기기 등록을 거부했습니다. 기기 목록을 확인하세요.')); } });
      ch.write(JSON.stringify({ v:1,public_key:key.public_key,device_label:key.device_label })+'\n');
    });
  });
}

export async function checkAppKeyLogin(root:string,id:string) {
  const row = findSshServer(root,id);
  if (!row?.pairing || !row.hostKeySha256 || row.managed) throw disallow('공유 연결에서만 이 PC 열쇠를 확인할 수 있습니다.');
  const key = await loadAppKey(root,deviceKeyPath(root),id);
  const { client } = await connectOne([{host:row.host,port:row.port,type:classifyEndpoint(row.host)}],row.hostKeySha256,{ username:row.username,privateKey:key.key,passphrase:key.passphrase,authHandler:['publickey'] },()=>new SshError('SSH_APP_KEY_REJECTED',row.pairing!.kind === 'host-pair' ? '서버 PC에서 이 기기 연결을 끊었습니다 · 새 코드가 필요합니다.' : '서버가 이 PC 열쇠를 거부했습니다 · 끊겼거나 열쇠가 빠졌습니다.'));
  client.end(); return { id,ready:true }; // No channel and no command.
}
const inProgress = new Set<string>();
async function acceptCode(root:string,c:HostCode|InviteCode,expectedId?:string) {
  if (c.kind === 'host-pair' && Date.parse(c.pair.expires_at)<=Date.now()) throw expired();
  const id = c.kind === 'host-pair' ? 'pc-'+c.host_id.slice(0,8) : listSshProfiles(root).find(s=>s.pairing?.kind==='ssh-invite' && s.hostKeySha256===c.host_key && s.username===c.username)?.id ?? 'inv-'+c.invite_id;
  const before = findSshServer(root,id);
  if ((expectedId && id !== expectedId) || (before && (before.managed || before.pairing?.kind !== c.kind || before.hostKeySha256 !== c.host_key || (c.kind==='host-pair' ? before.pairing.hostId !== c.host_id : before.username !== c.username)))) throw mismatch();
  const key = await ensureDeviceKey(root), base = { id,label:c.name,keyPath:deviceKeyPath(root),hostKeySha256:c.host_key,auth:'key' as const };
  const meta = { hostLabel:c.name,endpoints:c.endpoints,pairedAt:new Date().toISOString() };
  let row:SshServerProfile;
  if (c.kind === 'host-pair') {
    if (!c.caps.includes('exec')) throw new SshError('SSH_CODE_UNSUPPORTED','이 버전에서 지원하지 않는 코드 · 앱 업데이트 필요');
    const { client,endpoint } = await connectOne(c.endpoints,c.host_key,{ username:'myagent-pair',password:c.pair.token,authHandler:['password'] },expired);
    try {
      const r = await registerDevice(client,key);
      if (r.host_id !== c.host_id || typeof r.username !== 'string' || !/^d-[a-z0-9]{8}$/.test(r.username) || r.shell !== c.shell || (r.encoding !== 'utf8' && r.encoding !== 'cp949')) throw mismatch();
      row = { ...base,host:endpoint.host,port:endpoint.port,username:r.username,shell:c.shell,encoding:r.encoding,defaultCwd:codeText(r.default_cwd,1024),pairing:{ ...meta,kind:c.kind,hostId:c.host_id,deviceId:codeId(r.device_id) } };
    } finally { client.end(); }
  } else {
    if (key.key_fp !== c.key_fp) throw new SshError('SSH_INVITE_OTHER_PC','다른 PC 열쇠용 초대 코드입니다. 이 PC의 열쇠 코드로 다시 초대받으세요.');
    const e = c.endpoints[0]; row = { ...base,host:e.host,port:e.port,username:c.username,shell:'posix',encoding:c.encoding,defaultCwd:c.default_cwd,pairing:{ ...meta,kind:c.kind,inviteId:c.invite_id } };
  }
  const saved = savePairedSshServer(root,row);
  try { await bindDeviceKey(root,id); await checkAppKeyLogin(root,id); }
  catch (e) {
    if (c.kind === 'ssh-invite' && e instanceof SshError && e.code === 'SSH_APP_KEY_REJECTED') throw new InviteKeyNotAdded(id); // Deliberately retain for retry.
    if (undoPairedSave(root,saved,before ?? undefined) && !before) lockSshKey(root,id);
    throw e;
  }
  return { kind:c.kind,id };
}
export async function useConnectionCode(root:string,input:unknown,expectedId?:string) {
  const c = decodeCode(input);
  if (c.kind === 'key-request') return { kind:c.kind,device_label:c.device_label,key_fp:c.key_fp };
  if (inProgress.has(root)) throw new SshError('SSH_PAIR_BUSY','이 PC의 다른 연결 등록이 끝난 뒤 다시 시도하세요.');
  inProgress.add(root); try { return await acceptCode(root,c,expectedId); } finally { inProgress.delete(root); }
}

interface InviteInput { serverId:string; keyCode:unknown; account:unknown; defaultCwd?:unknown }
interface InviteRecord { invite_id:string; serverId:string; serverName:string; device_label:string; key_fp:string; account:string; issued_at:string }
const inviteFile = (root:string)=>path.join(root,'data','config','ssh-invites.json');
function records(root:string):InviteRecord[] {
  if (!existsSync(inviteFile(root))) return [];
  try { const rows:unknown = JSON.parse(readFileSync(inviteFile(root),'utf8')); if (Array.isArray(rows)) return rows as InviteRecord[]; } catch { /* fail closed rather than discarding history */ }
  throw new SshError('SSH_INVITE_STORE_INVALID','초대 기록을 읽을 수 없습니다.');
}
// Grep status 1 means the last (matching) line was removed; >1 is an error. Same directory, atomic rename.
function removal(id:string) {
  const marker = `myagent:${codeId(id)}:`;
  return `umask 077; (cd ~/.ssh && t=$(mktemp ./authorized_keys.XXXXXX) && { grep -Fv '${marker}' authorized_keys > "$t"; s=$?; if [ "$s" -le 1 ]; then mv "$t" authorized_keys; else rm -f "$t"; exit "$s"; fi; })`;
}
export function listInvites(root:string,serverId:string) { return records(root).filter(r=>r.serverId===serverId).map(r=>({ ...r,removeCommand:removal(r.invite_id) })); }
export function removeInviteRecord(root:string,id:string) { writePublicJson(root,inviteFile(root),records(root).filter(r=>r.invite_id!==codeId(id))); }
export function assertInviteTarget(server:SshServerProfile|null): asserts server is SshServerProfile & {hostKeySha256:string} {
  if (!server || server.managed || server.pairing || server.jumpServerId) throw disallow('이 PC에서 직접 추가한 경유 없는 서버만 팀원을 초대할 수 있습니다.');
  if ((server.shell ?? 'posix') !== 'posix') throw disallow('Windows 서버는 그 PC에서 「이 PC 서버」를 쓰세요.');
  if (!server.hostKeySha256 || !server.trustedAt) throw disallow('먼저 직접 등록한 서버의 지문을 확인하세요.');
}
function buildInvite(root:string,input:InviteInput,id:string) {
  const server = findSshServer(root,input.serverId);
  assertInviteTarget(server);
  const key = decodeCode(input.keyCode); if (key.kind !== 'key-request') throw disallow('팀원이 보낸 내 열쇠 코드를 넣으세요.');
  if (!isSshLoginPart(input.account,64)) throw disallow('팀원이 쓸 서버 계정을 확인하세요.');
  const account = input.account;
  if (account === server.username || account === 'root') throw new SshError('SSH_INVITE_SAME_ACCOUNT','운영자 계정은 팀원과 같이 쓰지 않습니다. 서버에 팀원용 계정을 만드세요.');
  const issued_at = new Date().toISOString();
  const record:InviteRecord = { invite_id:id,serverId:server.id,serverName:server.label,device_label:key.device_label,key_fp:key.key_fp,account,issued_at };
  const code:InviteCode = { v:1,kind:'ssh-invite',invite_id:id,name:server.label,endpoints:[{type:classifyEndpoint(server.host),host:server.host,port:server.port}],host_key:server.hostKeySha256,username:account,shell:'posix',encoding:server.encoding ?? 'utf8',key_fp:key.key_fp,issued_at,...(input.defaultCwd ? {default_cwd:codeText(input.defaultCwd,1024)} : {}) };
  const label = key.device_label.replace(/[^\p{L}\p{N}._-]/gu,'_');
  const keyLine = `no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ${key.public_key} myagent:${id}:${label}`;
  return { record,code,keyLine,addCommand:`umask 077; mkdir -p ~/.ssh && printf '%s\\n' '${keyLine}' >> ~/.ssh/authorized_keys`,removeCommand:removal(id) };
}
// A preview exposes only the instructions. Issue must refer to exactly that preview and target.
const drafts = new Map<string,{ root:string; identity:string }>();
const identity = (p:ReturnType<typeof buildInvite>)=>JSON.stringify({...p.code,issued_at:'',keyLine:p.keyLine,serverId:p.record.serverId});
export function previewInvite(root:string,input:InviteInput) {
  const id = randomUUID(), p = buildInvite(root,input,id); if (drafts.size>=100) drafts.delete(drafts.keys().next().value!);
  drafts.set(id,{root,identity:identity(p)}); return { invite_id:id,keyLine:p.keyLine,addCommand:p.addCommand };
}
export function createInvite(root:string,input:InviteInput,previewId?:string) {
  const id = previewId ? codeId(previewId) : randomUUID(), p = buildInvite(root,input,id);
  if (previewId && (drafts.get(id)?.root!==root || drafts.get(id)?.identity!==identity(p))) throw disallow('계정이나 열쇠가 바뀌었습니다. 서버에 넣을 명령을 다시 준비하세요.');
  const code = encodeCode(p.code); writePublicJson(root,inviteFile(root),[...records(root),p.record]); drafts.delete(id);
  return { invite_id:id,code,keyLine:p.keyLine,addCommand:p.addCommand,removeCommand:p.removeCommand };
}
