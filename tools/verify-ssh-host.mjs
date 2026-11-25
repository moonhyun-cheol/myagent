// Loopback only. No firewall changes, external host, real key or real profile. Windows/DPAPI required.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import ssh2 from 'ssh2';
import { classifyEndpoint, decodeCode, encodeCode } from '../core/dist/ssh/ssh-codes.js';
import { ensureDeviceKey, loadAppKey } from '../core/dist/ssh/ssh-app-keys.js';
import { closeSshHost, createSshHostCode, getSshHostStatus, isAllowedSource, openSshHost, revokeSshHostDevice, startSshHostOnBoot, stopSshHost, updateSshHostSettings } from '../core/dist/ssh/ssh-host-server.js';
import { checkAppKeyLogin, useConnectionCode } from '../core/dist/ssh/ssh-pairing.js';
import { deviceKeyPath, findSshServer } from '../core/dist/ssh/ssh-profile-store.js';
import { closeSshConnections, execSshCommand, listSshServerViews, sshFingerprint } from '../core/dist/ssh/ssh-service.js';

const base=mkdtempSync(path.join(os.tmpdir(),'myagent-host-')), host=path.join(base,'host'), pc=path.join(base,'client'), loop={bind:'127.0.0.1',port:0};
const peers=new Set(),tokens=[], oldEnv=process.env.VERIFY_API_KEY;let dummy;
const error=code=>e=>e.code===code;
const raw=r=>'MYAGENT-SSH1.'+Buffer.from(JSON.stringify(r)).toString('base64url');
const issue=()=>{const r=createSshHostCode(host);tokens.push(decodeCode(r.code).pair.token);return r.code;};
function client(config){const c=new ssh2.Client();peers.add(c);c.on('error',()=>{}).once('close',()=>peers.delete(c));const ready=once(c,'ready');c.connect(config);return ready.then(()=>c);}
const request=f=>new Promise((res,rej)=>f((e,r)=>e?rej(e):res(r)));
const listen=s=>new Promise((res,rej)=>s.once('error',rej).listen(0,'127.0.0.1',res));
function diskContents(dir){return readdirSync(dir,{withFileTypes:true}).map(e=>e.isDirectory()?diskContents(path.join(dir,e.name)):readFileSync(path.join(dir,e.name),'utf8')).join('\n');}
try {
  await ensureDeviceKey(pc);await updateSshHostSettings(host,{defaultCwd:base});
  const start=await openSshHost(host,loop);assert(start.open&&start.configured);const original=issue(), c=decodeCode(original), pin=c.host_key, endpoint=c.endpoints[0];
  assert.deepEqual(decodeCode(encodeCode(c)),c);assert.equal(endpoint.host,'127.0.0.1');
  for(const s of ['x'.repeat(4097),raw({...c,host_key:'bad'}),raw({...c,endpoints:[{...endpoint,port:0}]}),raw({...c,endpoints:[{...endpoint,port:65536}]}),raw({...c,endpoints:[{...endpoint,host:'two words'}]})])assert.throws(()=>decodeCode(s),error('SSH_CODE_INVALID'));
  assert.deepEqual(decodeCode(raw({...c,endpoints:[{type:'future'},endpoint],caps:['exec','files','future']})).caps,['exec']);assert.deepEqual(decodeCode(raw({...c,endpoints:[{type:'future'},endpoint]})).endpoints,[endpoint]);assert.throws(()=>decodeCode(raw({...c,endpoints:[{type:'future'}]})),error('SSH_CODE_UNSUPPORTED'));
  for(const ip of ['127.0.0.1','10.0.0.1','172.31.255.255','192.168.1.1','100.127.255.255','::ffff:100.64.0.1'])assert(isAllowedSource(ip),ip);
  for(const ip of ['127.0.0.2','::1','172.32.0.0','172.15.1.1','100.128.0.1','192.0.2.1','not-an-ip'])assert(!isAllowedSource(ip),ip);
  assert.equal(classifyEndpoint('100.63.255.255'),'public');
  console.log('PASS host code round trip, limits, endpoint/cap filtering and LAN/Tailscale source boundaries');
  let credentials=0;
  dummy=new ssh2.Server({hostKeys:[ssh2.utils.generateKeyPairSync('ed25519').private]},d=>d.on('error',()=>{}).on('authentication',ctx=>{credentials++;ctx.reject();}));await listen(dummy);
  await assert.rejects(useConnectionCode(pc,raw({...c,endpoints:[{...endpoint,port:dummy.address().port}]})),error('SSH_PAIR_HOST_MISMATCH'));assert.equal(credentials,0);
  const config={host:endpoint.host,port:endpoint.port,readyTimeout:3000,hostVerifier:k=>sshFingerprint(k)===pin};
  const pairConfig=c=>({...config,username:'myagent-pair',password:decodeCode(c).pair.token,authHandler:['password']});
  const expired=issue();const now=Date.now;try{Date.now=()=>now()+601000;assert.equal(getSshHostStatus(host).expiresAt,null);await assert.rejects(useConnectionCode(pc,expired),error('SSH_CODE_EXPIRED_OR_USED'));}finally{Date.now=now;}
  await assert.rejects(client(pairConfig(expired)));
  const fresh=issue();await assert.rejects(useConnectionCode(pc,original),error('SSH_CODE_EXPIRED_OR_USED'));
  const {id}=await useConnectionCode(pc,fresh);assert(id);await assert.rejects(useConnectionCode(pc,fresh),error('SSH_CODE_EXPIRED_OR_USED'));
  const view=(await listSshServerViews(pc)).find(x=>x.id===id);assert.equal(view.keyState,'ready');assert.equal(view.hostKeySha256,pin);assert.equal(view.pairing.kind,'host-pair');
  process.env.VERIFY_API_KEY='fixture-only-never-in-child';const result=await execSshCommand(pc,{serverId:id,command:"if ($env:VERIFY_API_KEY) { exit 91 }; [Console]::WriteLine((Get-Location).Path); exit 7"});
  assert.equal(result.state,'ok');assert.equal(result.exitCode,7);assert.equal(result.stdout.trim().toLowerCase(),base.toLowerCase());
  const audit=getSshHostStatus(host).audit;assert.equal(audit.length,1);assert.equal(audit[0].cwd,base);assert.equal(audit[0].exitCode,7);
  console.log('PASS pinned handshake sends no credentials to mismatched host; expired, rotated, replayed tickets rejected; paired exec/cwd/exit/env/audit');
  const key=await loadAppKey(pc,deviceKeyPath(pc),id), deviceAuth={...config,username:view.username,privateKey:key.key,passphrase:key.passphrase,authHandler:['publickey']};
  const paired=await client(deviceAuth), pairing=await client(pairConfig(issue()));
  await assert.rejects(request(cb=>pairing.exec('echo NOT-RUN',cb)));
  await assert.rejects(request(cb=>paired.exec('echo NOT-RUN',{pty:true},cb)));
  await assert.rejects(request(cb=>paired.shell(false,cb)));await assert.rejects(request(cb=>paired.sftp(cb)));
  await assert.rejects(request(cb=>paired.subsys('myagent-pair@my-agent',cb)));
  await assert.rejects(request(cb=>paired.forwardOut('127.0.0.1',0,'127.0.0.1',endpoint.port,cb)));
  await assert.rejects(request(cb=>paired.forwardIn('127.0.0.1',0,cb)));
  await assert.rejects(client({...config,username:view.username,password:'not-a-device-credential',authHandler:['password']}));assert.equal(getSshHostStatus(host).audit.length,1);
  pairing.end();const closed=once(paired,'close');revokeSshHostDevice(host,view.pairing.deviceId);await closed;
  await assert.rejects(checkAppKeyLogin(pc,id),error('SSH_APP_KEY_REJECTED'));await assert.rejects(execSshCommand(pc,{serverId:id,command:'echo NOT-RUN'}),error('SSH_AUTH_FAILED'));
  assert.equal((await useConnectionCode(pc,issue())).id,id);assert.equal(getSshHostStatus(host).devices.length,1);
  await closeSshHost(host);await assert.rejects(request(cb=>{const s=net.connect(endpoint.port,'127.0.0.1',()=>{s.destroy();cb(null);});s.on('error',cb);}));
  const restarted=await openSshHost(host,loop);const updated=decodeCode(issue());assert.equal(updated.host_id,c.host_id);
  // Same pinned server, new loopback port; never dial a remote network in this check.
  assert.equal((await useConnectionCode(pc,encodeCode(updated))).id,id);const updatedRow=findSshServer(pc,id);assert.equal(updatedRow.port,restarted.port);assert.equal(updatedRow.hostKeySha256,pin);assert.equal(getSshHostStatus(host).devices.length,1);
  console.log('PASS forbidden channels/device password, live revoke/next auth rejection, re-pair, close and same-host address update');
  const addr={...config,port:restarted.port};const valid=issue();for(let i=0;i<10;i++)await assert.rejects(client({...addr,username:'myagent-pair',password:'invalid',authHandler:['password']}));
  await assert.rejects(client({...pairConfig(valid),port:restarted.port}));assert(getSshHostStatus(host).expiresAt,'blocked source cannot spend a valid ticket');
  await closeSshHost(host);const logs=[];startSshHostOnBoot(host,s=>logs.push(s),loop);await sleep(3250);assert.equal(getSshHostStatus(host).open,false);
  await updateSshHostSettings(host,{autoStart:true});startSshHostOnBoot(host,s=>logs.push(s),loop);
  for(let i=0;i<150&&!getSshHostStatus(host).open;i++)await sleep(100);assert(getSshHostStatus(host).open);assert.equal(logs.length,1);
  const disk=diskContents(base);for(const t of tokens)assert(!disk.includes(t),'ticket stored on disk');assert(!disk.includes('MYAGENT-SSH1.'));
  console.log('PASS rate limit, boot opt-in/opt-out, ticket not present in temp data or logs');
}finally{if(oldEnv===undefined)delete process.env.VERIFY_API_KEY;else process.env.VERIFY_API_KEY=oldEnv;for(const c of peers)c.destroy();closeSshConnections();await stopSshHost();if(dummy?.address())await new Promise(r=>dummy.close(r));rmSync(base,{recursive:true,force:true});}
console.log('verify-ssh-host: PASS');
