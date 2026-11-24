/**
 * verify-ssh-service — ssh-service against an in-process ssh2 server on 127.0.0.1.
 * Keys are generated at run time in a temp folder; nothing leaves this machine.
 * Covers: untrusted refusal, fingerprint probe without auth, trust only after a probe,
 * locked key / unlock, exec result, cwd quoting, timeout, cancel, 64KB cap, changed host key,
 * Windows shells (cmd / powershell folder entry, euc-kr output), activity-log target line,
 * remembered passphrase (DPAPI ciphertext only on disk, recall after memory loss, forget,
 * key-file change), model-facing summaries (shell + keyState, no key path).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ssh2 from 'ssh2';
import { readFileSync } from 'node:fs';
import { createToolActivity } from '../core/dist/agent/tool-activity.js';
import { saveSshServers, trustSshServer, loadSshServers, sshServersPath } from '../core/dist/ssh/ssh-profile-store.js';
import { sshKeySecretsPath } from '../core/dist/ssh/ssh-secret-store.js';
import {
  buildRemoteCommand,
  clearSshPassphraseMemory,
  createSshOutputDecoder,
  execSshCommand,
  forgetSshKey,
  listSshServerSummaries,
  listSshServerViews,
  lockSshKey,
  retrySshRecall,
  probeSshFingerprint,
  trustProbedSshFingerprint,
  unlockSshKey,
} from '../core/dist/ssh/ssh-service.js';

const { Server, utils } = ssh2;
const root = mkdtempSync(path.join(os.tmpdir(), 'my-agent-sshsvc-'));
const hostKey = utils.generateKeyPairSync('ed25519');
const userKey = utils.generateKeyPairSync('ed25519', { passphrase: 'correct horse', cipher: 'aes256-ctr' });
const userPublic = utils.parseKey(userKey.public);
const keyPath = path.join(root, 'id_test');
writeFileSync(keyPath, userKey.private, 'utf8');

let authAttempts = 0;
const commands = [];
const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
  client.on('error', () => {});
  client.on('authentication', (ctx) => {
    authAttempts += 1;
    if (ctx.method === 'publickey' && ctx.key.data.equals(userPublic.getPublicSSH())) return ctx.accept();
    return ctx.reject(['publickey']);
  });
  client.on('ready', () => {
    client.on('session', (accept) => {
      accept().on('exec', (acceptExec, _reject, info) => {
        const stream = acceptExec();
        commands.push(info.command);
        if (info.command.includes('hang')) return; // never exits: timeout / cancel cases
        if (info.command.includes('flood')) {
          stream.write(Buffer.alloc(200 * 1024, 0x61));
        } else if (info.command.includes('korean')) {
          // "한글\n" in euc-kr (CP949), as a Korean Windows console sends it.
          stream.write(Buffer.from([0xc7, 0xd1, 0xb1, 0xdb, 0x0a]));
        } else {
          stream.write(`ran:${info.command}\n`);
          stream.stderr.write('warn\n');
        }
        stream.exit(3);
        stream.end();
      });
    });
  });
});

const fail = async (promise, code) => {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
};

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  saveSshServers(root, [{ id: 'dev', label: '개발 서버', host: '127.0.0.1', port, username: 'deploy', keyPath, defaultCwd: '/srv/app' }]);

  // 1. Untrusted: refused before any connection.
  await fail(execSshCommand(root, { serverId: 'dev', command: 'id' }), 'SSH_HOST_NOT_TRUSTED');
  assert.equal(authAttempts, 0);

  // 2. Probe returns the real fingerprint and never authenticates or trusts.
  const expected = `SHA256:${createHash('sha256').update(utils.parseKey(hostKey.public).getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
  const probe = await probeSshFingerprint(root, 'dev');
  assert.deepEqual(probe, { fingerprint: expected, trusted: false, changed: false });
  assert.equal(authAttempts, 0, 'probe sends no credentials');
  assert.equal(loadSshServers(root).servers[0].hostKeySha256, undefined, 'probe does not trust');

  // 3. Only the probed fingerprint can be trusted.
  assert.throws(() => trustProbedSshFingerprint(root, 'dev', 'SHA256:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'), /connection test/);
  trustProbedSshFingerprint(root, 'dev', expected);
  assert.equal((await probeSshFingerprint(root, 'dev')).trusted, true);

  // 4. Locked key -> unlock in memory.
  assert.deepEqual((await listSshServerSummaries(root))[0], {
    id: 'dev', label: '개발 서버', target: `deploy@127.0.0.1:${port}`, defaultCwd: '/srv/app', shell: 'posix', trusted: true, unlocked: false, keyState: 'locked',
  });
  await fail(execSshCommand(root, { serverId: 'dev', command: 'id' }), 'SSH_KEY_LOCKED');
  await fail(unlockSshKey(root, 'dev', 'wrong'), 'SSH_KEY_PASSPHRASE_WRONG');
  await unlockSshKey(root, 'dev', 'correct horse');
  assert.equal((await listSshServerSummaries(root))[0].unlocked, true);
  assert.equal(authAttempts, 0);

  // 5. One command, default folder quoted, streamed output.
  const chunks = [];
  const ok = await execSshCommand(root, { serverId: 'dev', command: 'df -h', onOutput: (stream, chunk) => chunks.push(`${stream}:${chunk}`) });
  assert.equal(ok.state, 'ok');
  assert.equal(ok.exitCode, 3);
  assert.equal(ok.stdout, "ran:cd -- '/srv/app' && df -h\n");
  assert.equal(ok.stderr, 'warn\n');
  assert.equal(ok.truncated, false);
  assert.ok(chunks.includes("stdout:ran:cd -- '/srv/app' && df -h\n"));
  const custom = await execSshCommand(root, { serverId: 'dev', command: 'ls', cwd: "/tmp/it's" });
  assert.equal(custom.stdout, "ran:cd -- '/tmp/it'\\''s' && ls\n");

  // 6. Output cap.
  const flood = await execSshCommand(root, { serverId: 'dev', command: 'flood' });
  assert.equal(flood.truncated, true);
  assert.equal(flood.stdout.length, 64 * 1024);

  // 7. Timeout and cancel end the call; the server slot is free again afterwards.
  const slow = await execSshCommand(root, { serverId: 'dev', command: 'hang', timeoutMs: 1000 });
  assert.equal(slow.state, 'timeout');
  assert.equal(slow.exitCode, null);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const cancelled = await execSshCommand(root, { serverId: 'dev', command: 'hang', signal: controller.signal });
  assert.equal(cancelled.state, 'cancelled');
  const [first, second] = await Promise.allSettled([
    execSshCommand(root, { serverId: 'dev', command: 'hang', timeoutMs: 1000 }),
    execSshCommand(root, { serverId: 'dev', command: 'id' }),
  ]);
  assert.equal(first.value?.state, 'timeout');
  assert.equal(second.reason?.code, 'SSH_SERVER_BUSY', 'one command per server at a time');

  // 7b. Model-facing summary: server kind and key state, never the key path or fingerprint.
  const summary = (await listSshServerSummaries(root))[0];
  assert.equal(summary.shell, 'posix');
  assert.equal(summary.keyState, 'ready');
  assert.equal(summary.unlocked, true);
  assert.deepEqual(Object.keys(summary).sort(), ['defaultCwd', 'id', 'keyState', 'label', 'shell', 'target', 'trusted', 'unlocked']);
  assert.doesNotMatch(JSON.stringify(summary), /id_test|SHA256:|correct horse/, 'no key path, fingerprint or passphrase in the summary');

  // 7c. Remembered passphrase (Windows DPAPI). Skipped where DPAPI does not exist.
  const secretsFile = sshKeySecretsPath(root);
  const plainServer = { id: 'dev', label: '개발 서버', host: '127.0.0.1', port, username: 'deploy', keyPath, defaultCwd: '/srv/app' };
  const view = async () => (await listSshServerViews(root))[0];
  assert.equal(existsSync(secretsFile), false, 'unlock without remember stores nothing');
  assert.equal((await view()).remembered, false);
  let rememberChecked = false;
  if (process.platform === 'win32') {
    await fail(unlockSshKey(root, 'dev', 'wrong', true), 'SSH_KEY_PASSPHRASE_WRONG');
    assert.equal(existsSync(secretsFile), false, 'a wrong passphrase is never stored');
    await unlockSshKey(root, 'dev', 'correct horse', true);
    assert.equal((await view()).remembered, true);
    const storedText = readFileSync(secretsFile, 'utf8');
    assert.doesNotMatch(storedText, /correct horse/, 'no plain passphrase in the secrets file');
    assert.ok(!storedText.includes(Buffer.from('correct horse', 'utf8').toString('base64')), 'not merely base64 of the passphrase');
    assert.ok(!readFileSync(secretsFile).includes(Buffer.from('correct horse', 'utf16le')), 'no UTF-16 plain passphrase either');
    assert.doesNotMatch(readFileSync(sshServersPath(root), 'utf8'), /passphrase|password|secret|dpapi|remember|correct horse/i, 'ssh-servers.json gains no secret field');

    clearSshPassphraseMemory();
    const corrupt = JSON.parse(storedText);
    corrupt.secrets.dev.dpapi = 'AAAA';
    writeFileSync(secretsFile, JSON.stringify(corrupt));
    let ticked = false;
    const reading = view();
    setTimeout(() => { ticked = true; }, 0);
    assert.equal((await reading).rememberState, 'unreadable');
    assert.equal(ticked, true, 'DPAPI recall leaves event loop responsive');
    writeFileSync(secretsFile, storedText);
    await retrySshRecall(root, 'dev');
    assert.equal((await view()).keyState, 'ready');
    lockSshKey(root, 'dev');
    await fail(execSshCommand(root, { serverId: 'dev', command: 'id' }), 'SSH_KEY_LOCKED');
    await unlockSshKey(root, 'dev', 'correct horse', true);
    // Restart: memory is empty, the stored copy opens the key without asking again.
    clearSshPassphraseMemory();
    assert.equal((await execSshCommand(root, { serverId: 'dev', command: 'id' })).state, 'ok', 'exec works after memory loss');
    clearSshPassphraseMemory();
    assert.deepEqual([(await view()).keyState, (await view()).remembered], ['ready', true]);

    // 「기억 지우기」: usable until restart, locked after it.
    forgetSshKey(root, 'dev');
    assert.equal((await view()).remembered, false);
    assert.equal((await execSshCommand(root, { serverId: 'dev', command: 'id' })).state, 'ok', 'still unlocked in this process');
    clearSshPassphraseMemory();
    await fail(execSshCommand(root, { serverId: 'dev', command: 'id' }), 'SSH_KEY_LOCKED');
    assert.equal((await view()).keyState, 'locked');

    // Key file path changed in Settings: the stored copy goes away with the memory copy.
    await unlockSshKey(root, 'dev', 'correct horse', true);
    const movedKey = path.join(root, 'id_moved');
    writeFileSync(movedKey, userKey.private, 'utf8');
    const moved = saveSshServers(root, [{ ...plainServer, keyPath: movedKey }]);
    assert.deepEqual(moved.keyChangedIds, ['dev']);
    for (const changedId of moved.keyChangedIds) lockSshKey(root, changedId);
    assert.deepEqual([(await view()).keyState, (await view()).remembered], ['locked', false]);
    await fail(execSshCommand(root, { serverId: 'dev', command: 'id' }), 'SSH_KEY_LOCKED');
    saveSshServers(root, [plainServer]);

    // Key file content replaced behind the app: the stale stored passphrase is dropped, key stays locked.
    await unlockSshKey(root, 'dev', 'correct horse', true);
    const otherKey = utils.generateKeyPairSync('ed25519', { passphrase: 'another one', cipher: 'aes256-ctr' });
    writeFileSync(keyPath, otherKey.private, 'utf8');
    clearSshPassphraseMemory();
    assert.deepEqual([(await view()).keyState, (await view()).remembered], ['locked', false]);
    writeFileSync(keyPath, userKey.private, 'utf8');

    // Removing the server removes its stored copy.
    await unlockSshKey(root, 'dev', 'correct horse', true);
    for (const removedId of saveSshServers(root, []).keyChangedIds) lockSshKey(root, removedId);
    assert.doesNotMatch(readFileSync(secretsFile, 'utf8'), /"dev"/, 'no stored copy for a removed server');
    saveSshServers(root, [plainServer]);
    trustSshServer(root, 'dev', expected);
    rememberChecked = true;
  }
  clearSshPassphraseMemory();
  await unlockSshKey(root, 'dev', 'correct horse');
  assert.equal((await view()).remembered, false, 'later sections run with the passphrase in memory only');

  // 8. Server kind: folder entry per shell, euc-kr output, and no secret field on disk.
  assert.equal(buildRemoteCommand('ls', '/srv/app'), "cd -- '/srv/app' && ls");
  assert.equal(buildRemoteCommand('ls', '/srv/app', 'posix'), "cd -- '/srv/app' && ls");
  assert.equal(buildRemoteCommand('dir', 'C:\\Users', 'cmd'), 'cd /d "C:\\Users" && dir');
  assert.equal(buildRemoteCommand('dir', "C:\\it's", 'powershell'), "Set-Location -LiteralPath 'C:\\it''s' -ErrorAction Stop; dir");
  for (const shell of ['posix', 'cmd', 'powershell']) assert.equal(buildRemoteCommand('dir', '', shell), 'dir');
  for (const bad of ['C:\\a"b', 'C:\\%TEMP%']) {
    assert.throws(() => buildRemoteCommand('dir', bad, 'cmd'), (error) => error.code === 'SSH_COMMAND_INVALID');
  }
  const eucKr = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]);
  for (const shell of ['cmd', 'powershell']) {
    const decoder = createSshOutputDecoder(shell);
    // Split inside a 2-byte character: stream mode must hold the first byte.
    assert.equal(decoder.write(eucKr.subarray(0, 1)) + decoder.write(eucKr.subarray(1)) + decoder.end(), '한글');
  }
  const utf8 = createSshOutputDecoder('posix');
  assert.equal(utf8.write(Buffer.from('한글', 'utf8')) + utf8.end(), '한글');

  const baseServer = { id: 'dev', label: '개발 서버', host: '127.0.0.1', port, username: 'deploy', keyPath, defaultCwd: '/srv/app' };
  saveSshServers(root, [{ ...baseServer, shell: 'cmd' }]);
  assert.equal(loadSshServers(root).servers[0].shell, 'cmd');
  assert.equal(loadSshServers(root).servers[0].hostKeySha256, expected, 'changing the server kind keeps trust');
  const winDir = await execSshCommand(root, { serverId: 'dev', command: 'dir', cwd: 'C:\\Users' });
  assert.equal(winDir.stdout, 'ran:cd /d "C:\\Users" && dir\n');
  const korean = await execSshCommand(root, { serverId: 'dev', command: 'korean', cwd: 'C:\\Users' });
  assert.equal(korean.stdout, '한글\n', 'euc-kr bytes from a Windows server read as Korean');
  const sentBeforeBadCwd = commands.length;
  await fail(execSshCommand(root, { serverId: 'dev', command: 'dir', cwd: 'C:\\a"b' }), 'SSH_COMMAND_INVALID');
  assert.equal(commands.length, sentBeforeBadCwd, 'a refused cwd sends nothing');
  assert.equal((await execSshCommand(root, { serverId: 'dev', command: 'id' })).state, 'ok', 'server slot is free after a refused cwd');
  saveSshServers(root, [{ ...baseServer, shell: 'powershell' }]);
  const psDir = await execSshCommand(root, { serverId: 'dev', command: 'ls', cwd: "C:\\it's" });
  assert.equal(psDir.stdout, "ran:Set-Location -LiteralPath 'C:\\it''s' -ErrorAction Stop; ls\n");
  saveSshServers(root, [{ ...baseServer, shell: 'powershell', passphrase: 'p', password: 'q', privateKey: 'r', keyBody: 's' }]);
  const onDisk = readFileSync(sshServersPath(root), 'utf8');
  assert.match(onDisk, /"shell": "powershell"/);
  assert.doesNotMatch(onDisk, /passphrase|password|privateKey|keyBody|correct horse/i, 'no key or passphrase field on disk');
  saveSshServers(root, [{ ...baseServer, shell: 'bash' }]);
  assert.equal(loadSshServers(root).servers[0].shell, undefined, 'unknown server kind is dropped (posix)');

  // 9. Activity-log line names the server and folder; other tools keep their target.
  const rows = [];
  createToolActivity('a1', 'ssh_exec', { server_id: 'test', cwd: 'C:\\Users', command: 'dir' }, (row) => rows.push(row));
  createToolActivity('a2', 'ssh_exec', { server_id: 'test', command: 'x'.repeat(900) }, (row) => rows.push(row));
  createToolActivity('a3', 'run_terminal', { command: 'npm test' }, (row) => rows.push(row));
  assert.equal(rows[0].target, '[test] C:\\Users $ dir');
  assert.ok(rows[1].target.startsWith('[test] $ xxx') && rows[1].target.length === 600);
  assert.equal(rows[2].target, 'npm test');

  // 10. A different host key aborts before credentials are sent.
  const before = authAttempts;
  const sent = commands.length;
  trustSshServer(root, 'dev', 'SHA256:DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD');
  await fail(execSshCommand(root, { serverId: 'dev', command: 'id' }), 'SSH_HOST_KEY_CHANGED');
  assert.equal(authAttempts, before, 'no credentials sent to a server with a changed key');
  assert.equal(commands.length, sent);
  assert.equal((await probeSshFingerprint(root, 'dev')).changed, true);

  console.log(rememberChecked
    ? 'PASS: remembered passphrase is DPAPI ciphertext only, survives memory loss, and is dropped on forget / key change / server removal'
    : 'SKIP: remembered-passphrase checks need Windows DPAPI');
  console.log('PASS: ssh-service refuses untrusted/changed hosts, probes without auth, keeps the passphrase in memory, runs one command with cwd quoting, timeout, cancel and 64KB cap, enters folders on cmd/powershell servers, reads euc-kr output, stores no secret with shell, and names the server in the activity log');
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
