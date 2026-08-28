#!/usr/bin/env node
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const root = process.cwd();
const capabilities = await import(pathToFileURL(path.join(root, 'core/dist/security/workspace-capabilities.js')).href);
const approval = await import(pathToFileURL(path.join(root, 'core/dist/agent/tool-approval.js')).href);
const tools = await import(pathToFileURL(path.join(root, 'core/dist/agent/agent-tool-execute.js')).href);
const temp = mkdtempSync(path.join(os.tmpdir(), 'cqr-pa-windows-permissions-'));
try {
  const officeFixture = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x80]);
  writeFileSync(path.join(temp, 'budget.xlsx'), officeFixture);
  writeFileSync(path.join(temp, '~$slides.pptx'), 'fixture');
  writeFileSync(path.join(temp, 'notes.txt'), 'keep me');
  writeFileSync(path.join(temp, 'move-source.txt'), 'keep source');
  const probe = capabilities.probeWorkspaceCapabilities(temp);
  assert.equal(probe.mode, 'read_write');
  assert.equal(probe.create_delete, true);
  assert.equal(probe.office.files_present, 2);
  assert.deepEqual(probe.office.lock_files, ['~$slides.pptx']);
  assert.equal(probe.office.mutation_mode, 'versioned_copy');

  assert.equal(approval.canDelegateToolApproval('write_file', { path: 'notes.md' }, temp), true);
  assert.equal(approval.canDelegateToolApproval('write_file', { path: '../outside.md' }, temp), false);
  assert.equal(approval.canDelegateToolApproval('write_file', { path: 'budget.xlsx' }, temp), false);
  assert.equal(approval.canDelegateToolApproval('delete_file', { path: 'notes.md' }, temp), false);
  assert.equal(approval.canDelegateToolApproval('run_terminal', { command: 'dir' }, temp), false);
  assert.equal(capabilities.normalizeWindowsPermissionError(new Error('EPERM: Access is denied')).code, 'PERMISSION_DENIED');
  assert.equal(capabilities.normalizeWindowsPermissionError(new Error('sharing violation: used by another process')).code, 'OFFICE_FILE_LOCKED');

  const blockedBatch = await tools.executeAgentTool(temp, {
    id: 'office-binary-batch',
    type: 'function',
    function: {
      name: 'apply_patch',
      arguments: JSON.stringify({
        files: [
          { path: 'notes.txt', action: 'update', content: 'must not be written' },
          { path: 'budget.xlsx', action: 'update', content: 'corrupted' },
        ],
      }),
    },
  });
  assert.match(blockedBatch.output, /^ERROR: OFFICE_BINARY_REQUIRES_DOCUMENT_TOOL/);
  assert.equal(readFileSync(path.join(temp, 'notes.txt'), 'utf8'), 'keep me');
  assert.deepEqual(readFileSync(path.join(temp, 'budget.xlsx')), officeFixture);

  const blockedMove = await tools.executeAgentTool(temp, {
    id: 'office-binary-move',
    type: 'function',
    function: {
      name: 'apply_patch',
      arguments: JSON.stringify({
        files: [{ path: 'move-source.txt', action: 'move', new_path: 'renamed.pptx' }],
      }),
    },
  });
  assert.match(blockedMove.output, /^ERROR: OFFICE_BINARY_REQUIRES_DOCUMENT_TOOL/);
  assert.equal(readFileSync(path.join(temp, 'move-source.txt'), 'utf8'), 'keep source');
  assert.equal(existsSync(path.join(temp, 'renamed.pptx')), false);

  const ui = [
    'ui/workspace/src/components/SettingsModal.tsx',
    'ui/workspace/src/components/SettingsAgentPage.tsx',
  ].map((file) => readFileSync(path.join(root, file), 'utf8')).join('\n');
  const client = readFileSync(path.join(root, 'ui/workspace/src/api/myAgentClient.ts'), 'utf8');
  const routes = readFileSync(path.join(root, 'core/src/routes/dispatch.ts'), 'utf8');
  const orchestrator = readFileSync(path.join(root, 'core/src/chat/chat-orchestrator.ts'), 'utf8');
  const installer = readFileSync(path.join(root, 'tools/install/install.ps1'), 'utf8');
  const shellHost = readFileSync(path.join(root, 'shell/CqrPa.Shell/ApiProcessHost.cs'), 'utf8');
  assert.match(ui, /data-testid="settings-approval-delegation-mode"/);
  assert.match(ui, /setApprovalDelegation\(mode\)/);
  assert.match(client, /fetch\('\/config\/workspace-capabilities'\)/);
  assert.match(routes, /capabilities\.mode !== 'read_write'/);
  assert.match(orchestrator, /approvalReq\.delegable === true/);
  assert.match(installer, /GetFolderPath\('LocalApplicationData'\)/);
  assert.match(installer, /cqr-pa-install-probe/);
  assert.match(installer, /Test-IsDriveRoot/);
  assert.match(installer, /Test-IsNewFolderOnDriveRoot/);
  assert.match(installer, /Test-IsElevated/);
  assert.match(installer, /Test-IsProtectedSystemFolder/);
  assert.match(installer, /Grant-CurrentUserModify/);
  assert.match(installer, /Repair-CopiedTree/);
  assert.match(installer, /npm_config_cache/);
  assert.match(shellHost, /UseShellExecute = false/);
  assert.doesNotMatch(shellHost, /Verb\s*=\s*["']runas/);
  console.log('windows/Office permission contract: PASS');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
