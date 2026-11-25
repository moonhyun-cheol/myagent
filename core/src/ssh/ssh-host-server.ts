import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createServer, isIPv4, type Server as Listener, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Connection, ServerChannel } from 'ssh2';
import { killProcessTree } from '../agent/run-terminal.js';
import { buildTerminalEnv } from '../security/terminal-env.js';
import { classifyEndpoint, codeText, encodeCode, type Endpoint } from './ssh-codes.js';
import { loadAppSsh2 } from './ssh-app-keys.js';
import { appendHostAudit, loadHostKey, pairDevice, readHost, recentHostAudit, saveHost, type HostConfig, type HostDevice } from './ssh-host-store.js';
import { SshError } from './ssh-service.js';

const TTL = 600_000;
export const PAIR_SUBSYSTEM = 'myagent-pair@my-agent';
const ip4 = (s:string) => s.replace(/^::ffff:/i,'');
export function isAllowedSource(ip:string) {
  const s = ip4(ip); return isIPv4(s) && (s === '127.0.0.1' || ['lan','tailscale'].includes(classifyEndpoint(s)));
}
function endpoints(port:number, bind:string):Endpoint[] {
  if (bind === '127.0.0.1') return [{ type:'public',host:bind,port }];
  const ips = new Set<string>();
  for (const [name,nic] of Object.entries(os.networkInterfaces())) {
    if (/vethernet|wsl|hyper-v|vmware|virtualbox|docker/i.test(name)) continue;
    for (const i of nic ?? []) if (!i.internal && i.family === 'IPv4' && isAllowedSource(i.address)) ips.add(i.address);
  }
  const list = [...ips].map(host => ({ type:classifyEndpoint(host),host,port }));
  const tails = list.filter(e => e.type === 'tailscale'), lan = list.filter(e => e.type === 'lan').slice(0,tails.length ? 2 : 3);
  return [...lan,...tails.slice(0,3-lan.length),{ type:'name' as const,host:os.hostname(),port }];
}
function exe(shell:'powershell'|'cmd') {
  return path.resolve(process.env.SystemRoot || 'C:\\Windows','System32',shell === 'cmd' ? 'cmd.exe' : 'WindowsPowerShell/v1.0/powershell.exe');
}
async function outputEncoding():Promise<'cp949'|'utf8'> {
  const { stdout } = await promisify(execFile)(exe('powershell'),['-NoLogo','-NoProfile','-NonInteractive','-Command','[Console]::OutputEncoding.CodePage'],{ windowsHide:true,timeout:10_000,env:buildTerminalEnv() });
  return stdout.trim() === '949' ? 'cp949' : 'utf8';
}
interface Peer { socket:Socket; deviceId?:string; jobs:Set<() => void> }
interface Live {
  root:string; bind:string; listener:Listener; peers:Map<string,Peer>; blocked:number; encoding:'cp949'|'utf8';
  attempts:Map<string,{ times:number[]; until:number }>; active:Map<string,number>;
  ticket?:{ digest:Buffer; until:number }; generation:number;
}
let live:Live|undefined, boot:NodeJS.Timeout|undefined;
let lifecycle:Promise<unknown> = Promise.resolve();
function ordered<T>(f:()=>Promise<T>) { const job = lifecycle.then(f); lifecycle = job.catch(()=>{}); return job; }
const validTicket = (l:Live) => { if (l.ticket && l.ticket.until <= Date.now()) l.ticket = undefined; return l.ticket; };
const digest = (token:string) => createHash('sha256').update(token).digest();
function throttled(l:Live,ip:string) {
  const now = Date.now();
  for (const [source,f] of l.attempts) if (f.until <= now && (f.times.at(-1) ?? 0) <= now-TTL) l.attempts.delete(source);
  return (l.attempts.get(ip)?.until ?? 0) > now;
}
function failed(l:Live,ip:string) {
  const now = Date.now(), f = l.attempts.get(ip) ?? { times:[],until:0 };
  f.times = [...f.times.filter(t=>t>now-TTL),now].slice(-10); if (f.times.length >= 10) f.until = now+TTL;
  l.attempts.set(ip,f); return f.until > now;
}

/** This is the only remote process launcher. No interactive stdin, inherited provider secrets or detached shell. */
function runHostCommand(l:Live,peer:Peer,h:HostConfig,d:HostDevice,command:string,ch:ServerChannel) {
  const since = Date.now(), key = d.id, ip = ip4(peer.socket.remoteAddress ?? '');
  l.active.set(key,(l.active.get(key) ?? 0)+1);
  const ps = h.shell === 'powershell';
  const args = ps ? ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from("$ProgressPreference='SilentlyContinue';\n"+command,'utf16le').toString('base64')] : ['/d','/s','/c','"'+command+'"'];
  const child = spawn(exe(h.shell),args,{ cwd:h.defaultCwd,env:buildTerminalEnv({ ...process.env,MY_AGENT_TERMINAL_ENV_ALLOW:'' }),stdio:['ignore','pipe','pipe'],windowsHide:true,windowsVerbatimArguments:!ps });
  let finished = false, result = '완료', killed = false;
  const kill = () => { if (!finished && !killed) { killed = true; result = '중단'; killProcessTree(child); } };
  peer.jobs.add(kill); peer.socket.setTimeout(0);
  const timer = setTimeout(() => { kill(); result = '시간 초과'; },660_000).unref();
  ch.once('close',kill).on('error',kill); ch.stderr.on('error',kill);
  child.stdout.pipe(ch,{end:false}); child.stderr.pipe(ch.stderr,{end:false});
  child.once('error',()=>{result='실행 실패';});
  child.once('close',code=>{
    finished = true; clearTimeout(timer); peer.jobs.delete(kill); if (!peer.jobs.size && !peer.socket.destroyed) peer.socket.setTimeout(TTL);
    const count = (l.active.get(key) ?? 1)-1; if (count) l.active.set(key,count); else l.active.delete(key);
    if (result === '완료' && code !== 0) result = '오류';
    try { appendHostAudit(l.root,{ time:new Date().toISOString(),device:d.label,ip,command,cwd:h.defaultCwd,exitCode:code,durationMs:Date.now()-since,result }); }
    catch { result = '기록 실패'; }
    if (!ch.destroyed) { ch.exit(result === '기록 실패' ? 1 : code ?? 1); ch.end(); }
  });
}

type Lib = Awaited<ReturnType<typeof loadAppSsh2>>;
function wireConnection(l:Live,peer:Peer,client:Connection,ip:string,lib:Lib) {
  let failures = 0, discovery = false, pairGeneration:number|undefined, pairUntil = 0, usedChannel = false, sessions = 0;
  client.on('error',()=>peer.socket.destroy());
  client.on('authentication',ctx=>{
    const methods:('publickey'|'password')[] = ctx.username === 'myagent-pair' && validTicket(l) ? ['password'] : ['publickey'];
    if (throttled(l,ip)) { peer.socket.destroy(); return; }
    if (ctx.method === 'none' && !discovery) { discovery = true; return ctx.reject(methods); } // normal SSH method discovery
    if (ctx.username === 'myagent-pair' && ctx.method === 'password') {
      const ticket = validTicket(l);
      if (ticket && /^[A-Z2-7]{32}$/.test(ctx.password) && timingSafeEqual(ticket.digest,digest(ctx.password))) {
        pairGeneration = l.generation; pairUntil = ticket.until; l.ticket = undefined; return ctx.accept();
      }
    } else if (ctx.method === 'publickey' && ctx.key.algo === 'ssh-ed25519') {
      const h = readHost(l.root), d = h.devices.find(d=>d.username === ctx.username);
      if (d && Buffer.from(d.publicKey.split(' ')[1],'base64').equals(ctx.key.data)) {
        if (!ctx.signature) return ctx.accept(); // ssh2 replies PK_OK, not USERAUTH_SUCCESS
        const k = lib.utils.parseKey(d.publicKey);
        if (!(k instanceof Error) && ctx.blob && k.verify(ctx.blob,ctx.signature,ctx.hashAlgo) === true) {
          peer.deviceId = d.id; d.lastSeenAt = new Date().toISOString(); saveHost(l.root,h); return ctx.accept();
        }
      }
    }
    const block = failed(l,ip); ctx.reject(methods);
    if (++failures >= 3 || block) peer.socket.destroy();
  });
  client.on('ready',()=>{
    peer.socket.setTimeout(pairGeneration === undefined ? TTL : 15_000);
    // All other global/channel requests have no listener and are rejected by ssh2.
    client.on('session',(accept,reject)=>{
      if (sessions >= 4) return reject();
      const s = accept(); sessions++; s.once('close',()=>sessions--);
      s.on('subsystem',(open,deny,info)=>{
        if (info.name !== PAIR_SUBSYSTEM || usedChannel || pairGeneration !== l.generation || pairUntil <= Date.now()) return deny();
        usedChannel = true;
        const ch = open(); let input = Buffer.alloc(0), answered = false;
        ch.on('error',()=>peer.socket.destroy());
        ch.on('data',(buf:Buffer)=>{
          if (answered || buf.length+input.length > 4096) return peer.socket.destroy();
          input = Buffer.concat([input,buf]); const end = input.indexOf(10); if (end < 0) return;
          answered = true;
          try {
            if (end !== input.length-1 || pairGeneration !== l.generation || Date.now() >= pairUntil || peer.socket.destroyed) throw Error();
            const r = JSON.parse(input.subarray(0,end).toString('utf8'));
            if (r.v !== 1) throw Error();
            const d = pairDevice(l.root,r.public_key,r.device_label), h = readHost(l.root);
            ch.end(JSON.stringify({ device_id:d.id,username:d.username,label:h.label,shell:h.shell,encoding:l.encoding,default_cwd:h.defaultCwd,host_id:h.hostId })+'\n');
          } catch { ch.end('{"error":"SSH_PAIR_REJECTED"}\n'); }
        });
      });
      s.on('exec',(open,deny,req)=>{
        const h = readHost(l.root), d = h.devices.find(d=>d.id === peer.deviceId);
        if (!d || !d.caps.includes('exec') || !req.command.trim() || req.command.includes('\0') || Buffer.byteLength(req.command)>8192 || (l.active.get(d.id) ?? 0)>=2) return deny();
        runHostCommand(l,peer,h,d,req.command,open());
      });
    });
  });
}
export function getSshHostStatus(root:string) {
  const h = readHost(root), l = live?.root === root ? live : undefined;
  const expires = l && validTicket(l)?.until;
  return { ...h,configured:Boolean(h.hostKeySha256),open:Boolean(l),endpoints:l ? endpoints(h.port,l.bind) : [],encoding:l?.encoding,expiresAt:expires ? new Date(expires).toISOString() : null,blockedExternal:l?.blocked ?? 0,audit:recentHostAudit(root) };
}
interface OpenOptions { bind?:'127.0.0.1'; port?:0 }
function listen(s:Listener,port:number,bind:string):Promise<void> {
  return new Promise((ok,no)=>{
    const error = (e:Error) => { s.off('listening',ready); no(e); };
    const ready = () => { s.off('error',error); ok(); };
    s.once('error',error).once('listening',ready); s.listen(port,bind);
  });
}
export function openSshHost(root:string,options:OpenOptions={}) {
  return ordered(async()=>{
    if (live) { if (live.root !== root) throw new SshError('SSH_HOST_BUSY','다른 서버가 이미 열려 있습니다.'); return getSshHostStatus(root); }
    if (process.platform !== 'win32') throw new SshError('SSH_APP_KEY_SECRET_UNAVAILABLE','이 PC 서버는 Windows에서만 열 수 있습니다.');
    const h = readHost(root), lib = await loadAppSsh2(), key = await loadHostKey(root,h);
    const encoding = await outputEncoding(), bind = options.bind ?? '0.0.0.0';
    const listener = createServer(), state:Live = { root,listener,bind,encoding,blocked:0,attempts:new Map(),active:new Map(),peers:new Map(),generation:0 };
    const ssh = new lib.Server({ hostKeys:[{ key:key.key,passphrase:key.passphrase }] },(client,info)=>{
      const peer = state.peers.get(`${info.ip}:${info.port}`);
      if (!peer) { client.end(); return; } wireConnection(state,peer,client,ip4(info.ip),lib);
    });
    // Check the actual TCP peer before SSH negotiation; no forwarded headers or interface-name trust.
    listener.on('connection',socket=>{
      const ip = ip4(socket.remoteAddress ?? '');
      if (!isAllowedSource(ip)) { state.blocked++; socket.destroy(); return; }
      if (live !== state || state.peers.size >= 16 || throttled(state,ip)) { socket.destroy(); return; }
      const id = `${socket.remoteAddress}:${socket.remotePort}`, peer:Peer = { socket,jobs:new Set() };
      state.peers.set(id,peer); socket.setTimeout(15_000,()=>socket.destroy()); socket.on('error',()=>socket.destroy());
      socket.once('close',()=>{ for (const kill of peer.jobs) kill(); state.peers.delete(id); });
      ssh.injectSocket(socket);
    });
    const ports = options.port === 0 && bind === '127.0.0.1' ? [0] : h.port ? [h.port] : Array.from({length:78},(_,i)=>2222+i);
    for (const port of ports) {
      try { await listen(listener,port,bind); break; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e; }
    }
    const addr = listener.address();
    if (!addr || typeof addr === 'string') throw new SshError('SSH_HOST_PORT_BUSY','포트 사용 중 · 포트를 바꾼 뒤 연결한 기기에 새 코드를 보내세요.');
    try { saveHost(root,{ ...readHost(root),port:addr.port,hostKeySha256:key.fingerprint }); live = state; }
    catch (e) { listener.close(); throw e; }
    return getSshHostStatus(root);
  });
}
async function shut() {
  const l = live; if (!l) return; live = undefined; l.ticket = undefined; l.generation++;
  for (const {socket,jobs} of l.peers.values()) { for (const kill of jobs) kill(); socket.destroy(); }
  await new Promise<void>(done=>l.listener.close(()=>done()));
}
export function closeSshHost(root:string) { clearTimeout(boot); return ordered(async()=>{ if (live?.root === root) await shut(); return getSshHostStatus(root); }); }
export function updateSshHostSettings(root:string,raw:Partial<Pick<HostConfig,'label'|'port'|'shell'|'defaultCwd'|'autoStart'>>) {
  return ordered(async()=>{
    const h = readHost(root);
    if (raw.port !== undefined && raw.port !== h.port) {
      if (live || !Number.isInteger(raw.port) || raw.port<1 || raw.port>65535) throw new SshError('SSH_HOST_PORT_INVALID','서버를 닫고 1~65535 사이 포트를 고르세요.'); h.port = raw.port;
    }
    if (raw.label !== undefined) h.label = codeText(raw.label,80);
    if (raw.defaultCwd !== undefined) { const cwd = codeText(raw.defaultCwd,1024); if (!path.isAbsolute(cwd)) throw new SshError('SSH_HOST_CWD','시작 폴더는 전체 경로로 지정하세요.'); h.defaultCwd = cwd; }
    if (raw.shell !== undefined) { if (raw.shell !== 'cmd' && raw.shell !== 'powershell') throw new SshError('SSH_HOST_SHELL','명령 창 종류를 확인하세요.'); h.shell = raw.shell; }
    if (raw.autoStart !== undefined) h.autoStart = raw.autoStart === true && Boolean(h.hostKeySha256);
    saveHost(root,h); return getSshHostStatus(root);
  });
}
export function createSshHostCode(root:string) {
  const l = live; if (!l || l.root !== root) throw new SshError('SSH_HOST_CLOSED','먼저 서버를 여세요.');
  const h = readHost(root), token = Array.from(randomBytes(32),b=>'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[b&31]).join(''), until = Date.now()+TTL;
  const code = encodeCode({v:1,kind:'host-pair',host_id:h.hostId,name:h.label,endpoints:endpoints(h.port,l.bind),host_key:h.hostKeySha256,shell:h.shell,caps:['exec'],pair:{token,expires_at:new Date(until).toISOString()}});
  l.generation++; l.ticket = {digest:digest(token),until}; return { code,status:getSshHostStatus(root) };
}
export function renameSshHostDevice(root:string,id:string,label:unknown) {
  const h = readHost(root), d = h.devices.find(d=>d.id===id); if (!d) throw new SshError('SSH_HOST_DEVICE_UNKNOWN','목록에서 기기를 다시 고르세요.');
  d.label = codeText(label,80); saveHost(root,h); return getSshHostStatus(root);
}
export function revokeSshHostDevice(root:string,id:string|'*') {
  const h = readHost(root); h.devices = h.devices.filter(d=>id !== '*' && d.id !== id); saveHost(root,h);
  if (live?.root === root) {
    if (id === '*') { live.generation++; live.ticket = undefined; }
    for (const peer of live.peers.values()) if (id === '*' || peer.deviceId === id) { for (const kill of peer.jobs) kill(); peer.socket.destroy(); }
  }
  return getSshHostStatus(root);
}
export function startSshHostOnBoot(root:string,log:(s:string)=>void,options:OpenOptions={}) {
  clearTimeout(boot); boot = setTimeout(async()=>{
    try { if (readHost(root).autoStart) { await openSshHost(root,options); log('ssh-host 자동 열기 성공'); } }
    catch (e) { log('ssh-host 자동 열기 실패: '+(e instanceof SshError ? e.code : 'SSH_HOST_OPEN_FAILED')); }
  },3000).unref();
}
export function stopSshHost() { clearTimeout(boot); return ordered(shut); }
