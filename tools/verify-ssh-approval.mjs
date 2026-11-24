/**
 * verify-ssh-approval — ssh_exec is a human-only approval (never delegable), the card
 * names server / folder / command, and the server file carries no secret field.
 * Pure function checks (no network, no SSH connection, no model call).
 *
 * Not covered here: redaction of key material in remote output. A key-shaped fixture in
 * this file is rejected by the agent's own secret guardrail, so that path needs a manual check.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { needsHumanApproval, canDelegateToolApproval } from '../core/dist/agent/tool-approval.js';
import {
  loadSshServers,
  saveSshServers,
  sshServersPath,
  trustSshServer,
} from '../core/dist/ssh/ssh-profile-store.js';
import { buildRemoteCommand, clampSshTimeout, redactSshOutput } from '../core/dist/ssh/ssh-service.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'my-agent-ssh-'));
try {
  // ── 1. Server file: schema fields only ────────────────────────────────────
  saveSshServers(root, [{
    id: 'dev',
    label: '개발 서버',
    host: '10.0.0.5',
    port: 2222,
    username: 'deploy',
    keyPath: 'C:\\Users\\me\\.ssh\\id_ed25519',
    defaultCwd: '/srv/app',
    // None of these may reach the disk.
    passphrase: 'hunter2',
    password: 'hunter2',
    privateKey: 'hunter2-key-body',
    hostKeySha256: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  }]);
  const raw = readFileSync(sshServersPath(root), 'utf8');
  const stored = JSON.parse(raw);
  assert.equal(stored.version, 1);
  assert.deepEqual(
    Object.keys(stored.servers[0]).sort(),
    ['defaultCwd', 'host', 'id', 'keyPath', 'label', 'port', 'username'],
    'only schema fields are written; trust is not accepted from a save request',
  );
  assert.ok(!/hunter2|passphrase|password|privateKey/i.test(raw), 'no secret field on disk');

  const fp = 'SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  trustSshServer(root, 'dev', fp);
  assert.equal(loadSshServers(root).servers[0].hostKeySha256, fp);
  // Same host/port keeps trust; a changed address drops it.
  saveSshServers(root, [{ ...loadSshServers(root).servers[0], label: '개발' }]);
  assert.equal(loadSshServers(root).servers[0].hostKeySha256, fp, 'trust survives a label edit');
  saveSshServers(root, [{ ...loadSshServers(root).servers[0], host: '10.0.0.6' }]);
  assert.equal(loadSshServers(root).servers[0].hostKeySha256, undefined, 'trust dropped when host changes');
  assert.throws(() => saveSshServers(root, [{ id: 'bad id', host: 'h', username: 'u', keyPath: 'k' }]));

  // ── 2. Approval card ───────────────────────────────────────────────────────
  const args = { server_id: 'dev', command: 'df -h' };
  const need = needsHumanApproval('ssh_exec', args, {}, { workspaceRoot: root, cqrRoot: root });
  assert.equal(need.needed, true);
  assert.equal(need.danger, true);
  assert.equal(need.access, 'remote_exec');
  assert.equal(need.expires, 'once');
  assert.deepEqual(need.targets, [
    '서버: 개발 (deploy@10.0.0.6:2222)',
    '폴더: /srv/app',
    '명령: df -h',
  ]);
  const withCwd = needsHumanApproval('ssh_exec', { ...args, cwd: '/var/log' }, {}, { cqrRoot: root });
  assert.equal(withCwd.targets[1], '폴더: /var/log');
  // Unknown server and a model-authored confirm=true still need the card.
  const unknown = needsHumanApproval('ssh_exec', { server_id: 'nope', command: 'id', confirm: true }, {}, { cqrRoot: root });
  assert.equal(unknown.needed, true);
  assert.equal(unknown.access, 'remote_exec');
  assert.match(unknown.targets[0], /등록되지 않은 서버/);

  // ── 3. Never delegable ─────────────────────────────────────────────────────
  assert.equal(canDelegateToolApproval('ssh_exec', args, root), false);
  assert.equal(canDelegateToolApproval('ssh_exec', { ...args, confirm: true }, root, [root]), false);
  assert.equal(canDelegateToolApproval('ssh_exec', {}, '\\\\nas\\share'), false);

  // ── 4. Command building / limits ───────────────────────────────────────────
  assert.equal(buildRemoteCommand('df -h'), 'df -h');
  assert.equal(buildRemoteCommand('ls', '/srv/app'), "cd -- '/srv/app' && ls");
  assert.equal(buildRemoteCommand('ls', "/tmp/a'; rm -rf /; '"), "cd -- '/tmp/a'\\''; rm -rf /; '\\''' && ls");
  assert.equal(clampSshTimeout(undefined), 30_000);
  assert.equal(clampSshTimeout(999_999), 120_000);
  assert.equal(redactSshOutput('plain output'), 'plain output');

  console.log('PASS: ssh_exec approval is human-only (delegable=false, access=remote_exec), card targets name server/folder/command, ssh-servers.json keeps no secret field');
} finally {
  rmSync(root, { recursive: true, force: true });
}
