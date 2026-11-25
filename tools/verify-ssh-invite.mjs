// Local Windows/DPAPI fixture. A set of public keys models the administrator's manual step.
// No authorized_keys file is read, written or executed. No real server, key or secret used.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ssh2 from 'ssh2';
import { CODE_PREFIX, decodeCode, encodeCode, keyFingerprint } from '../core/dist/ssh/ssh-codes.js';
import { deviceKeyCode, ensureDeviceKey, renameDeviceKey } from '../core/dist/ssh/ssh-app-keys.js';
import { assertInviteTarget, checkAppKeyLogin, createInvite, listInvites, previewInvite, removeInviteRecord, useConnectionCode } from '../core/dist/ssh/ssh-pairing.js';
import { assertSshRowAction, deviceKeyPath, findSshServer, loadSshServers, saveSshServers, sshServersPath, trustSshServer } from '../core/dist/ssh/ssh-profile-store.js';
import { hasRememberedPassphrase } from '../core/dist/ssh/ssh-secret-store.js';
import { closeSshConnections, execSshCommand, lockSshKey } from '../core/dist/ssh/ssh-service.js';
const base=mkdtempSync(path.join(os.tmpdir(),'myagent-invite-')),pc=path.join(base,'pc'),admin=path.join(base,'admin'),other=path.join(base,'other');
const err=code=>e=>e.code===code, raw=r=>CODE_PREFIX+Buffer.from(JSON.stringify(r)).toString('base64url');
const key=ssh2.utils.generateKeyPairSync('ed25519'),pin=keyFingerprint(key.public.trim().split(/\s+/).slice(0,2).join(' '));
const allowed=new Map(),clients=new Set(),servers=[],commands=[];
async function fixture(){const s=new ssh2.Server({hostKeys:[key.private]},client=>{
  clients.add(client);client.on('error',()=>{}).once('close',()=>clients.delete(client));
  client.on('authentication',ctx=>{const pub=allowed.get(ctx.username);if(pub&&ctx.method==='publickey'&&ctx.key.data.equals(pub.getPublicSSH())&&(!ctx.signature||pub.verify(ctx.blob,ctx.signature,ctx.hashAlgo)===true))return ctx.accept();ctx.reject(['publickey']);});
  client.on('ready',()=>client.on('session',accept=>accept().on('exec',(open,_,{command})=>{commands.push(command);const ch=open();ch.write('fixture-ok');ch.exit(0);ch.end();})));
});servers.push(s);await new Promise(r=>s.listen(0,'127.0.0.1',r));return s.address().port;}
function checkDisk(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory()){checkDisk(f);continue;}const data=readFileSync(f,'utf8');if(/-----BEGIN .*PRIVATE KEY-----/.test(data)){assert.equal(f,deviceKeyPath(path.dirname(path.dirname(dir))));assert(ssh2.utils.parseKey(data) instanceof Error,'no plaintext key');const blob=Buffer.from(data.replace(/-----[^\n]+-----|\s/g,''),'base64');assert.equal(blob.subarray(19,29).toString(),'aes256-ctr');}assert(!data.includes(key.private));}}
try{
  for(const kind of ['cloud','future'])assert.throws(()=>decodeCode(raw({v:1,kind})),err('SSH_CODE_UNSUPPORTED'));
  const [one,two]=await Promise.all([ensureDeviceKey(pc),ensureDeviceKey(pc)]);assert.deepEqual(one,two);assert.deepEqual(one,await ensureDeviceKey(pc));
  const own=await renameDeviceKey(pc,"My PC 'B'"),keyCode=deviceKeyCode(own),decoded=decodeCode(keyCode);assert.equal(decoded.key_fp,own.key_fp);
  assert.deepEqual(await useConnectionCode(admin,keyCode),{kind:'key-request',device_label:own.device_label,key_fp:own.key_fp});assert(!existsSync(sshServersPath(admin)));assert(!existsSync(deviceKeyPath(admin)));
  const port=await fixture(),direct={id:'direct',label:'Team server',host:'127.0.0.1',port,username:'operator',auth:'password',keyPath:'',shell:'posix'};
  const rows=[direct,{...direct,id:'jumped',jumpServerId:'direct'},{...direct,id:'windows',shell:'cmd'}];saveSshServers(admin,rows);
  const input={serverId:'direct',keyCode,account:'member-a'};
  assert.throws(()=>createInvite(admin,input),err('SSH_INVITE_NOT_ALLOWED'));for(const s of rows)trustSshServer(admin,s.id,pin);
  for(const serverId of ['jumped','windows'])assert.throws(()=>createInvite(admin,{...input,serverId}),err('SSH_INVITE_NOT_ALLOWED'));
  assert.throws(()=>assertInviteTarget({...findSshServer(admin,'direct'),managed:true}),err('SSH_INVITE_NOT_ALLOWED'));
  assert.throws(()=>createInvite(admin,{...input,account:'operator'}),err('SSH_INVITE_SAME_ACCOUNT'));
  const p=previewInvite(admin,input);assert.equal(listInvites(admin,'direct').length,0);assert(!('code' in p));assert.throws(()=>createInvite(admin,{...input,account:'different'},p.invite_id),err('SSH_INVITE_NOT_ALLOWED'));
  const invite=createInvite(admin,input,p.invite_id);const code=decodeCode(invite.code);assert.equal(code.kind,'ssh-invite');assert.equal(code.host_key,pin);
  assert.match(invite.keyLine,/^no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 [A-Za-z0-9+/]+ myagent:[a-z0-9-]+:My_PC__B_$/);assert(invite.keyLine.includes(`myagent:${code.invite_id}:`));assert(invite.addCommand.includes(invite.keyLine));assert(invite.removeCommand.includes(`myagent:${code.invite_id}:`));
  assert.deepEqual(Object.keys(code).sort(),['v','kind','invite_id','name','endpoints','host_key','username','shell','encoding','key_fp','issued_at'].sort());assert(!invite.code.includes(key.private));
  assert.equal(decodeCode(raw({...code,endpoints:[{type:'public',host:'192.0.2.1',port:22}]})).endpoints[0].type,'public');
  await assert.rejects(useConnectionCode(other,invite.code),err('SSH_INVITE_OTHER_PC'));assert.equal(loadSshServers(other).servers.length,0);
  await assert.rejects(useConnectionCode(pc,invite.code),err('SSH_INVITE_KEY_NOT_ADDED'));const received=loadSshServers(pc).servers[0],id=received.id;assert.equal(received.pairing.kind,'ssh-invite');assert.equal(received.hostKeySha256,pin);assert.equal(received.keyPath,deviceKeyPath(pc));assert(hasRememberedPassphrase(pc,id));
  assert.throws(()=>createInvite(pc,{...input,serverId:id}),err('SSH_INVITE_NOT_ALLOWED'));
  allowed.set('member-a',ssh2.utils.parseKey(own.public_key));assert((await checkAppKeyLogin(pc,id)).ready);assert.equal(commands.length,0,'check did not exec');
  const run=await execSshCommand(pc,{serverId:id,command:'echo fixture'});assert.equal(run.exitCode,0);assert.equal(run.stdout,'fixture-ok');
  console.log('PASS code kinds, device key dedup, pinned invite eligibility/account, public-only two-step issue, wrong PC and absent key, verified login/exec');
  const moved=await fixture();const newer=encodeCode({...code,invite_id:'new-fixture',endpoints:[{type:'name',host:'127.0.0.1',port:moved}]});assert.equal((await useConnectionCode(pc,newer)).id,id);
  const current=findSshServer(pc,id);assert.equal(current.port,moved);assert.equal(current.trustedAt,received.trustedAt);assert.equal(loadSshServers(pc).servers.length,1);assert.equal(current.pairing.inviteId,received.pairing.inviteId);
  const mutable={...direct,id:'local',pairing:current.pairing};saveSshServers(pc,[{...current,label:'changed',host:'192.0.2.9',username:'another',port:9,keyPath:'wrong'},mutable]);assert(!findSshServer(pc,'local').pairing);assert.deepEqual(findSshServer(pc,id),{...current,label:'changed'});
  for(const action of ['lock','forget','unlock','trust','account'])assert.throws(()=>assertSshRowAction(pc,id,action),err('SSH_APP_KEY_READONLY'));
  assert.throws(()=>saveSshServers(pc,[current,{...mutable,jumpServerId:id}]),err('SSH_APP_KEY_NO_JUMP'));assert.throws(()=>saveSshServers(pc,[current,{...direct,id:'bad',auth:'key',keyPath:deviceKeyPath(pc)}]),err('SSH_APP_KEY_RESERVED'));
  const b=createInvite(admin,{...input,account:'member-b'});allowed.set('member-b',ssh2.utils.parseKey(own.public_key));const second=(await useConnectionCode(pc,b.code)).id;
  const deleted=saveSshServers(pc,loadSshServers(pc).servers.filter(r=>r.id!==id));assert.deepEqual(deleted.keyChangedIds,[id]);for(const gone of deleted.keyChangedIds)lockSshKey(pc,gone);
  assert(!hasRememberedPassphrase(pc,id));assert(hasRememberedPassphrase(pc,second));assert(hasRememberedPassphrase(pc,'@device-key'));assert(existsSync(deviceKeyPath(pc)));
  assert.equal((await execSshCommand(pc,{serverId:second,command:'echo unaffected'})).state,'ok');allowed.delete('member-b');await assert.rejects(checkAppKeyLogin(pc,second),err('SSH_APP_KEY_REJECTED'));
  removeInviteRecord(admin,code.invite_id);assert.equal(listInvites(admin,'direct').length,1);checkDisk(base);
  console.log('PASS address-only renewal, shared row/action/jump/path controls, per-row DPAPI deletion and disk encryption; removed key rejects new logins');console.log('verify-ssh-invite: PASS');
}finally{closeSshConnections();for(const c of clients)c.end();await Promise.all(servers.map(s=>new Promise(r=>s.close(r))));rmSync(base,{recursive:true,force:true});}
