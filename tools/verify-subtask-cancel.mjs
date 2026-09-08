import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeAgentTool } from '../core/dist/agent/agent-tool-execute.js';
import { registerToolExecution, cancelToolExecution } from '../core/dist/agent/tool-execution-cancel.js';
import { listActiveTerminalJobIds } from '../core/dist/agent/run-terminal.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(root, 'data', '_skill_tool_lab');
mkdirSync(base, { recursive: true });
const temp = mkdtempSync(path.join(base, 'subtask-cancel-'));
const parent = new AbortController();
const a = registerToolExecution('a', 's', parent.signal);
const b = registerToolExecution('b', 's', parent.signal);
assert.equal(cancelToolExecution('a', 'wrong'), false);
assert.equal(cancelToolExecution('a', 's'), true);
assert.equal(cancelToolExecution('a', 's'), true);
assert.equal(a.signal.aborted, true);
assert.equal(b.signal.aborted, false);
assert.equal(parent.signal.aborted, false);
a.dispose(); assert.equal(cancelToolExecution('a', 's'), false);
parent.abort(); assert.equal(b.signal.aborted, true); b.dispose();
console.log('PASS scoped, idempotent cancellation; parent/sibling isolation; parent abort propagation; cleanup');
const call = (tool, command) => ({ id: crypto.randomUUID(), type: 'function', function: { name: tool, arguments: JSON.stringify({ command }) } });
try {
  for (const tool of ['run_terminal', 'run_tests', 'run_diagnostics']) {
    const controller = new AbortController();
    const rows = [];
    let cancelled = false;
    const result = await executeAgentTool(temp, call(tool, "[Console]::Out.WriteLine('ready'); Start-Sleep -Seconds 60"), {}, {
      sessionId: 'acceptance', signal: controller.signal,
      onToolActivity(row) {
        rows.push(row);
        if (!cancelled && row.output.includes('ready')) {
          cancelled = true;
          assert.equal(cancelToolExecution(row.id, 'wrong'), false);
          assert.equal(cancelToolExecution(row.id, 'acceptance'), true);
        }
      },
    });
    const output = JSON.parse(result.output);
    assert.equal(output.ok, false);
    assert.equal(output.cancelled, true);
    assert.equal(output.reason, 'user_cancelled_subtask');
    assert.match(output.guidance, /Continue the chat/);
    assert.equal(controller.signal.aborted, false);
    assert.ok(rows.some(row => row.cancelRequested && row.state === 'running'));
    assert.equal(rows.at(-1).state, 'cancelled');
    assert.equal(cancelToolExecution(rows[0].id, 'acceptance'), false);
    const next = await executeAgentTool(temp, call('run_terminal', "Write-Output 'continued'; exit 0"), {}, { sessionId: 'acceptance', signal: controller.signal });
    assert.equal(JSON.parse(next.output).ok, true);
    assert.equal(listActiveTerminalJobIds().length, 0);
    console.log(`PASS ${tool}: actual shell stopped, cancellation result returned, next execution succeeds, registry clean`);
  }
  let childPid;
  const tree = await executeAgentTool(temp, call('run_terminal', "$p = Start-Process powershell.exe -ArgumentList '-NoProfile -NonInteractive -Command Start-Sleep -Seconds 60' -PassThru -WindowStyle Hidden; Write-Output ('CHILD_PID=' + $p.Id); Start-Sleep -Seconds 60"), {}, {
    sessionId: 'tree', onToolActivity(row) {
      const match = row.output.match(/CHILD_PID=(\d+)/);
      if (match && !childPid) { childPid = Number(match[1]); cancelToolExecution(row.id, 'tree'); }
    },
  });
  assert.equal(JSON.parse(tree.output).cancelled, true);
  assert.ok(childPid);
  const gone = await executeAgentTool(temp, call('run_terminal', `if (Get-Process -Id ${childPid} -ErrorAction SilentlyContinue) { exit 7 }; exit 0`));
  assert.equal(JSON.parse(gone.output).ok, true, 'descendant process must actually exit');
  console.log('PASS Windows descendant process terminated, not merely PowerShell parent');
} finally { rmSync(temp, { recursive: true, force: true }); }
