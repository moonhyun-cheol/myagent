/**
 * verify-ssh-managed-connections — SSH connections deployed by a signed Organization Feature.
 * In-process ssh2 server on 127.0.0.1; host key, user key and feature packs are generated at
 * run time in temp folders. Nothing leaves this machine.
 *
 * Covers: a pack with a secret field is refused at install, managed connections merge
 * read-only (no trust override, no local id clash), the pinned fingerprint works without
 * 「이 지문 신뢰」, a fingerprint mismatch is refused before any credential is sent, the
 * account is stored without a secret, ssh_exec on a managed connection stays human-only,
 * views/summaries expose no secret, and ~/.ssh key candidates come back without key bodies.
 */
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ssh2 from 'ssh2';
import { canDelegateToolApproval, needsHumanApproval } from '../core/dist/agent/tool-approval.js';
import {
  FEATURE_JSON_SCHEMA,
  buildSignedFeaturePayloadFromDir,
  disableOrganizationFeature,
  enableOrganizationFeature,
  installOrganizationFeatureFromZip,
  isOrganizationFeatureEnabled,
} from '../core/dist/features/organization-feature-manager.js';
import {
  findSshServer,
  listManagedSshConnections,
  listSshKeyCandidates,
  saveManagedSshAccount,
  saveSshServers,
  sshServersPath,
  trustSshServer,
} from '../core/dist/ssh/ssh-profile-store.js';
import {
  closeSshConnections,
  execSshCommand,
  listSshServerSummaries,
  listSshServerViews,
  lockSshKey,
  probeSshFingerprint,
  trustProbedSshFingerprint,
  unlockSshKey,
} from '../core/dist/ssh/ssh-service.js';

const { Server, utils } = ssh2;
const root = mkdtempSync(path.join(os.tmpdir(), 'my-agent-sshmanaged-'));
const scratch = mkdtempSync(path.join(os.tmpdir(), 'my-agent-sshmanaged-pack-'));
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } }).privateKey;
const pinned = `SHA256:${createHash('sha256').update(utils.parseKey(hostKey).getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
const wrongPin = `SHA256:${'Q'.repeat(43)}`;
const PASSWORD = 'managed fixture pw';

let authAttempts = 0;
const commands = [];
const server = new Server({ hostKeys: [hostKey] }, (client) => {
  client.on('error', () => {});
  client.on('authentication', (ctx) => {
    authAttempts += 1;
    if (ctx.method === 'password' && ctx.username === 'kim' && ctx.password === PASSWORD) return ctx.accept();
    return ctx.reject(['password']);
  });
  client.on('ready', () => {
    client.on('session', (accept) => {
      accept().on('exec', (acceptExec, _reject, info) => {
        const stream = acceptExec();
        commands.push(info.command);
        stream.write(`ran:${info.command}\n`);
        stream.exit(0);
        stream.end();
      });
    });
  });
});

function zipDirectory(sourceDir, zipPath) {
  const zip = spawnSync('powershell', ['-NoProfile', '-Command', [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `[IO.Compression.ZipFile]::CreateFromDirectory('${sourceDir.replace(/'/g, "''")}', '${zipPath.replace(/'/g, "''")}', [IO.Compression.CompressionLevel]::Optimal, $false, [Text.Encoding]::UTF8)`,
  ].join('; ')], { encoding: 'utf8' });
  if (zip.status !== 0 || !existsSync(zipPath)) throw new Error(zip.stderr?.toString() || 'zip failed');
}

/** Signed pack with feature.json + managed-ssh-connections.json. */
function buildPack(name, featureId, connections) {
  const stage = path.join(scratch, name);
  mkdirSync(stage, { recursive: true });
  writeFileSync(path.join(stage, 'feature.json'), `${JSON.stringify({
    schema: FEATURE_JSON_SCHEMA,
    id: featureId,
    version: '1.0.0',
    update_sequence: 1,
    label: '데이터 연결 배포',
    capabilities: ['managed-ssh'],
    entrypoints: { managed_ssh_connections: 'managed-ssh-connections.json' },
  }, null, 2)}\n`);
  writeFileSync(path.join(stage, 'managed-ssh-connections.json'), `${JSON.stringify({ version: 1, connections }, null, 2)}\n`);
  const { envelopeJson } = buildSignedFeaturePayloadFromDir(stage, privatePem);
  writeFileSync(path.join(stage, 'update-payload.json'), envelopeJson);
  const zipPath = path.join(scratch, `${name}.zip`);
  zipDirectory(stage, zipPath);
  return zipPath;
}

const fail = async (promise, code) => {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
};

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const featureId = 'org.example.data-connection';

  // 1. A pack that carries a credential never installs.
  const secretZip = buildPack('secret', featureId, [{ id: 'dw', host: '127.0.0.1', port, host_key_sha256: pinned, password: 'leak' }]);
  assert.throws(
    () => installOrganizationFeatureFromZip(root, secretZip, { publicKeyPem: publicPem, enable: true }),
    (error) => error.code === 'FEATURE_SECRET_FIELD',
  );
  assert.equal(isOrganizationFeatureEnabled(root, featureId), false, 'refused pack is not installed');
  assert.deepEqual(listManagedSshConnections(root), []);

  // 2. Signed pack: rows without a pinned fingerprint are dropped.
  const zip = buildPack('good', featureId, [
    { id: 'dw', label: '데이터 서버', host: '127.0.0.1', port, shell: 'posix', host_key_sha256: pinned },
    { id: 'dw-wrong', label: '지문 다른 서버', host: '127.0.0.1', port, host_key_sha256: wrongPin },
    { id: 'nofp', label: '지문 없음', host: '127.0.0.1', port },
  ]);
  installOrganizationFeatureFromZip(root, zip, { publicKeyPem: publicPem, enable: false });
  assert.deepEqual(listManagedSshConnections(root), [], 'disabled feature deploys nothing');
  enableOrganizationFeature(root, featureId, { confirm: true });
  assert.deepEqual(listManagedSshConnections(root).map((c) => c.id), ['dw', 'dw-wrong']);

  // 3. Read-only merge: pinned = trusted, no account yet, trust cannot be overridden, no id clash.
  const views = await listSshServerViews(root);
  const dwView = views.find((s) => s.id === 'dw');
  assert.equal(dwView.managed, true);
  assert.equal(dwView.trusted, true, 'pinned fingerprint needs no 「이 지문 신뢰」');
  assert.equal(dwView.hostKeySha256, pinned);
  assert.equal(dwView.username, '');
  assert.equal(dwView.keyState, 'locked');
  assert.equal(dwView.needsSecret, true);
  assert.throws(() => trustSshServer(root, 'dw', wrongPin), (error) => error.code === 'SSH_MANAGED_READONLY');
  assert.throws(() => saveSshServers(root, [{ id: 'dw', label: 'x', host: '10.0.0.1', username: 'u', auth: 'password' }]), (error) => error.code === 'SSH_SERVER_DUPLICATE');

  // 4. Without an account nothing is sent; the probe reads the key without credentials.
  await fail(unlockSshKey(root, 'dw', PASSWORD), 'SSH_ACCOUNT_REQUIRED');
  await fail(execSshCommand(root, { serverId: 'dw', command: 'id' }), 'SSH_ACCOUNT_REQUIRED');
  assert.deepEqual(await probeSshFingerprint(root, 'dw'), { fingerprint: pinned, trusted: true, changed: false });
  assert.throws(() => trustProbedSshFingerprint(root, 'dw', pinned), (error) => error.code === 'SSH_MANAGED_READONLY');
  assert.equal(authAttempts, 0, 'no credential sent before an account exists');

  // 5. Account + password only: unlock and run without any manual trust.
  assert.deepEqual(saveManagedSshAccount(root, 'dw', { username: 'kim' }), { changed: true });
  assert.deepEqual(saveManagedSshAccount(root, 'dw', { username: 'kim' }), { changed: false });
  await unlockSshKey(root, 'dw', PASSWORD);
  const ran = await execSshCommand(root, { serverId: 'dw', command: 'echo ok' });
  assert.equal(ran.state, 'ok');
  assert.equal(ran.stdout, 'ran:echo ok\n');

  // 6. Fingerprint mismatch: refused during the handshake, the password never leaves this PC.
  saveManagedSshAccount(root, 'dw-wrong', { username: 'kim' });
  const mismatch = await probeSshFingerprint(root, 'dw-wrong');
  assert.equal(mismatch.trusted, false);
  assert.equal(mismatch.changed, true);
  const attemptsBefore = authAttempts;
  const commandsBefore = commands.length;
  await fail(unlockSshKey(root, 'dw-wrong', PASSWORD), 'SSH_HOST_KEY_CHANGED');
  assert.equal(authAttempts, attemptsBefore, 'no credential sent to a mismatched fingerprint');
  assert.equal(commands.length, commandsBefore);

  // 7. ssh_exec on a managed connection is still a human-only approval card.
  const need = needsHumanApproval('ssh_exec', { server_id: 'dw', command: 'df -h' }, {}, { cqrRoot: root, workspaceRoot: root });
  assert.equal(need.needed, true);
  assert.equal(need.access, 'remote_exec');
  assert.equal(need.targets[0], `서버: 데이터 서버 (kim@127.0.0.1:${port})`);
  assert.equal(canDelegateToolApproval('ssh_exec', { server_id: 'dw', command: 'df -h' }, root, [root]), false);

  // 8. No secret on disk or in what the UI / model reads.
  const onDisk = readFileSync(sshServersPath(root), 'utf8');
  assert.deepEqual(JSON.parse(onDisk).managed, { dw: { username: 'kim' }, 'dw-wrong': { username: 'kim' } });
  assert.doesNotMatch(onDisk, /managed fixture pw|"(?:password|passphrase|privateKey|secret)"\s*:/i);
  const summaries = await listSshServerSummaries(root);
  assert.equal(summaries.find((s) => s.id === 'dw').managed, true);
  assert.doesNotMatch(JSON.stringify(summaries), /SHA256:|managed fixture pw/, 'model summary has no fingerprint or password');
  assert.doesNotMatch(JSON.stringify(await listSshServerViews(root)), /managed fixture pw/);

  // 9. A new account drops the old secret.
  assert.deepEqual(saveManagedSshAccount(root, 'dw', { username: 'lee' }), { changed: true });
  lockSshKey(root, 'dw');
  assert.equal((await listSshServerViews(root)).find((s) => s.id === 'dw').keyState, 'locked');

  // 10. Disabling the feature removes its connections.
  disableOrganizationFeature(root, featureId, { confirm: true });
  assert.equal(findSshServer(root, 'dw'), null);

  // 11. ~/.ssh key candidates: names and paths of private keys only, never the key body.
  const home = path.join(scratch, 'home');
  mkdirSync(path.join(home, '.ssh'), { recursive: true });
  const userKey = utils.generateKeyPairSync('ed25519');
  writeFileSync(path.join(home, '.ssh', 'id_ed25519'), userKey.private, 'utf8');
  writeFileSync(path.join(home, '.ssh', 'id_ed25519.pub'), userKey.public, 'utf8');
  writeFileSync(path.join(home, '.ssh', 'known_hosts'), 'host ssh-ed25519 AAAA\n', 'utf8');
  writeFileSync(path.join(home, '.ssh', 'config'), 'Host *\n', 'utf8');
  writeFileSync(path.join(home, '.ssh', 'notes.txt'), 'not a key\n', 'utf8');
  const found = listSshKeyCandidates(home);
  assert.deepEqual(found.candidates.map((c) => c.name), ['id_ed25519']);
  assert.equal(found.candidates[0].path, path.join(home, '.ssh', 'id_ed25519'));
  assert.ok(!JSON.stringify(found).includes(userKey.private.split('\n')[1]), 'key body is not returned');
  assert.deepEqual(listSshKeyCandidates(path.join(scratch, 'no-home')).candidates, []);

  console.log('PASS: managed SSH connections — secret pack refused, read-only merge, pinned fingerprint without manual trust, mismatch refused before credentials, account-only local storage, human-only ssh_exec, no secret exposed, .ssh key candidates without key bodies');
} finally {
  closeSshConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
}
