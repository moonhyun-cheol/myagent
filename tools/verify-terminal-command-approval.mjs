#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const terminal = await import('../core/dist/agent/run-terminal.js');
const policy = await import('../core/dist/agent/terminal-path-policy.js');
const approval = await import('../core/dist/agent/tool-approval.js');
const { executeAgentTool } = await import('../core/dist/agent/agent-tool-execute.js');
const ws = 'D:\\work\\project';
const outside = 'D:\\MY_AGENT\\data\\sessions\\sessions.sqlite';
const command = `node -e "new DatabaseSync('${outside.replaceAll('\\', '/')}', {readOnly:true})"`;
assert.deepEqual(policy.externalTerminalPaths(command, ws), [outside]);
assert.deepEqual(policy.externalTerminalPaths('Get-Content "D:\\work\\project\\file name.txt"', ws), []);
assert.deepEqual(policy.externalTerminalPaths('Get-Content D:\\work\\project-other\\a.txt', ws), ['D:\\work\\project-other\\a.txt']);
assert.deepEqual(policy.externalTerminalPaths('Get-Content "E:\\some folder\\a.txt"', ws), ['E:\\some folder\\a.txt']);
assert.deepEqual(policy.externalTerminalPaths('Get-Content "\\\\nas\\share\\a.txt"', ws), ['\\\\nas\\share\\a.txt']);
assert.deepEqual(policy.externalTerminalPaths('Get-Content "d:/WORK/project/a.txt"', ws), []);
assert.match(terminal.validateShellCommand(command, ws), /requires approval/);
assert.equal(terminal.validateShellCommand(command, ws, command), null);
assert.match(terminal.validateShellCommand(command + '; Write-Output changed', ws, command), /requires approval/);
assert.match(terminal.validateShellCommand(command, ws, 'different command'), /requires approval/);
assert.equal(terminal.validateShellCommand('Get-Content "D:\\work\\project\\a.txt"', ws), null);
for (const blocked of ['git push', 'git pull', 'git reset --hard', 'Remove-Item -Recurse .', 'Get-Content ..\\a.txt', 'format C:', 'rm -rf /', 'Remove-Item -Recurse -Force D:\\work\\project']) {
  assert.ok(terminal.validateShellCommand(blocked, ws, blocked), `approval must not bypass hard safety blocks: ${blocked}`);
}
// Severe tier: recursive folder delete / DB destruction runs only with approval of this exact command.
for (const severe of ['Remove-Item -Recurse -Force src', 'rm -rf docs', 'Remove-Item src -r', 'rd /s /q data', 'sqlite3 a.db "DROP TABLE users;"', 'Remove-Item data/app.sqlite']) {
  assert.equal(terminal.classifyTerminalCommand(severe, ws).tier, 'severe', severe);
  assert.match(terminal.validateShellCommand(severe, ws), /requires user approval/, severe);
  assert.equal(terminal.validateShellCommand(severe, ws, severe), null, `approved severe command runs: ${severe}`);
  const req = approval.needsHumanApproval('run_terminal', { command: severe }, {}, { workspaceRoot: ws });
  assert.equal(req.needed, true);
  assert.equal(req.fixedSeverity, 'severe');
}
// Rebuildable output and read-only git are routine.
for (const normal of ['rm -rf node_modules', 'Remove-Item -Recurse -Force dist', 'git show HEAD', 'git blame a.ts', 'git branch -a', 'git log --pretty=format:%h']) {
  assert.equal(terminal.validateShellCommand(normal, ws), null, normal);
  assert.equal(approval.needsHumanApproval('run_terminal', { command: normal }, {}, { workspaceRoot: ws }).fixedSeverity, undefined, normal);
}
assert.equal(terminal.classifyTerminalCommand('git branch -D feat', ws).tier, 'git_tool');
assert.equal(approval.needsHumanApproval('run_terminal', { command: 'git push' }, {}, { workspaceRoot: ws }).needed, false, 'never-run commands skip the card');
const request = approval.needsHumanApproval('run_terminal', { command, confirm: true }, {}, { workspaceRoot: ws });
assert.equal(request.needed, true);
assert.equal(request.access, 'operation');
assert.equal(request.expires, 'once');
assert.deepEqual(request.targets, [outside]);
assert.equal(approval.canDelegateToolApproval('run_terminal', { command }, ws), false);
assert.equal(approval.canDelegateToolApproval('run_terminal', { command: 'python -m pytest -q' }, ws), true);
assert.equal(approval.needsHumanApproval('run_terminal', { command: 'node --check "D:/elsewhere/a.js"' }, {}, { workspaceRoot: ws }).needed, true);
assert.equal(approval.needsHumanApproval('run_terminal', { command: 'node --check a.js' }, {}, { workspaceRoot: ws }).needed, false);
assert.equal(approval.needsHumanApproval('run_terminal', { command }, {}, {
  workspaceRoot: ws, approvedExternalReadRoots: new Set(['D:\\MY_AGENT']),
}).needed, true, 'file read grants must not authorize arbitrary shell');

// Actual PowerShell execution uses harmless temporary files, never the real app DB.
if (process.platform === 'win32') {
  const tmp = mkdtempSync(path.join(root, 'data', 'verify-terminal-approval-'));
  const cwd = path.join(tmp, 'workspace');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(cwd);
  const fixture = path.join(tmp, 'outside file.txt');
  writeFileSync(fixture, 'approval-boundary-fixture', 'utf8');
  const cmd = `Get-Content -LiteralPath '${fixture.replaceAll("'", "''")}'`;
  const call = (c = cmd, extra = {}) => ({ id: 'approval-fixture', type: 'function', function: {
    name: 'run_terminal', arguments: JSON.stringify({ command: c, ...extra }),
  }});
  try {
    const denied = terminal.runTerminalCommand(cwd, cmd);
    assert.equal(denied.ok, false);
    assert.equal(denied.exit_code, null);
    const sync = terminal.runTerminalCommand(cwd, cmd, { approvedCommand: cmd });
    assert.equal(sync.ok, true, sync.stderr);
    assert.match(sync.stdout, /approval-boundary-fixture/);
    const asyncRun = await terminal.runTerminalCommandAsync(cwd, cmd, { approvedCommand: cmd });
    assert.equal(asyncRun.ok, true, asyncRun.stderr);
    const fakeArgs = JSON.parse((await executeAgentTool(cwd, call(cmd, { confirm: true, approvedTerminalCommand: cmd }))).output);
    assert.equal(fakeArgs.ok, false, 'model args must not create driver approval');
    const ctx = { approvedTerminalCommand: cmd };
    const accepted = JSON.parse((await executeAgentTool(cwd, call(), {}, ctx)).output);
    assert.equal(accepted.ok, true, accepted.output);
    const changed = JSON.parse((await executeAgentTool(cwd, call(cmd + '; Write-Output changed'), {}, ctx)).output);
    assert.equal(changed.ok, false, 'different command must not inherit approval');
    const nextCall = JSON.parse((await executeAgentTool(cwd, call())).output);
    assert.equal(nextCall.ok, false, 'approval must not persist into another call');
    assert.equal(readFileSync(fixture, 'utf8'), 'approval-boundary-fixture');

    // Exercise the real approval driver with a mocked provider, including reject
    // despite confirm=true and the non-stream confirm fallback. No network/cost.
    const { runCodeAgent } = await import('../core/dist/agent/agent-run-loop.js');
    const originalFetch = globalThis.fetch;
    try {
      for (const mode of ['allow', 'reject', 'confirm', 'unconfirmed']) {
        const approvals = [];
        const completed = [];
        const statuses = [];
        let modelSteps = 0;
        globalThis.fetch = async () => new Response(
          'event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: {
            id: 'resp_approval_fixture', model: 'fixture-model', status: 'completed',
            output: [{ type: 'function_call', call_id: 'call_fixture', name: 'run_terminal',
              arguments: JSON.stringify({ command: cmd, confirm: mode !== 'unconfirmed' }) }],
          } }) + '\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
        await runCodeAgent({
          workspaceRoot: cwd, cqrRoot: tmp, userMessage: 'Execute this fixture terminal command.',
          providerId: 'fixture', modelId: 'fixture-model', autopilot: false,
          providerStore: { resolveProvider: () => ({
            def: { kind: 'openai_compatible', name: 'Fixture' }, secret: { api_key: 'fixture-key' },
            baseUrl: 'https://fixture.invalid/v1', modelId: 'fixture-model',
            wireApi: 'responses', toolProtocol: 'native',
          }) },
          onToolApproval: ['allow', 'reject'].includes(mode) ? async (req) => {
            approvals.push(req);
            return mode === 'allow';
          } : undefined,
          onStatus: (s) => statuses.push(s),
          hooks: {
            beforeModel: () => ++modelSteps > 1 ? { stop: true, reason: 'fixture complete' } : undefined,
            afterTool: (row) => { if (row.tool === 'run_terminal') completed.push(JSON.parse(row.output)); },
          },
        });
        if (mode === 'allow' || mode === 'confirm') {
          assert.equal(completed.length, 1, `${mode}: driver must execute once`);
          assert.equal(completed[0].ok, true, completed[0].output);
          assert.match(completed[0].output, /approval-boundary-fixture/);
        } else {
          assert.equal(completed.length, 0, `${mode}: driver must not execute`);
        }
        if (mode === 'allow' || mode === 'reject') {
          assert.equal(approvals.length, 1);
          assert.equal(approvals[0].delegable, false);
          assert.equal(approvals[0].expires, 'once');
          assert.match(approvals[0].summary, /Get-Content/);
        }
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
} else {
  console.log('SKIP PowerShell execution: Windows required');
}
console.log('verify-terminal-command-approval: ok');
