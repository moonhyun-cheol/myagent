import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createToolActivity, redactActivity } from '../core/dist/agent/tool-activity.js';
import { runTerminalCommandAsync, listActiveTerminalJobIds } from '../core/dist/agent/run-terminal.js';
import { executeAgentTool } from '../core/dist/agent/agent-tool-execute.js';
import { SessionStore } from '../core/dist/sessions/session-store.js';
import { appendAssistantReply } from '../core/dist/chat/assistant-reply.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(root, 'data', '_skill_tool_lab');
mkdirSync(base, { recursive: true });
const temp = mkdtempSync(path.join(base, 'tool-activity-'));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let count = 0;
const pass = (name) => { count++; console.log(`PASS ${name}`); };
try {
  const snapshots = [];
  process.env.ACTIVITY_TEST_TOKEN = 'known-secret-value';
  const activity = createToolActivity(
    'mask', 'run_terminal', { command: 'curl --token="private-value"' },
    (row) => snapshots.push(row), undefined, 'model-tool-batch:test-one',
  );
  activity.output('stdout', 'api_key=split');
  await pause(150);
  assert.equal(snapshots.at(-1).output, '');
  activity.output('stdout', '-secret\nknown-secret-value\nAuthorization: Bearer abcdef\n');
  activity.output('stderr', 'warning\n');
  // Synthetic PEM envelope, deliberately no real key material.
  const pem = (edge) => ['-----', edge, ' RSA ', 'PRIVATE', ' KEY-----'].join('');
  activity.output('stdout', `${pem('BEGIN')}\ndummy-key-material\n${pem('END')}\n`);
  activity.finish('{"ok":true,"exit_code":0}');
  const serialized = JSON.stringify(snapshots);
  for (const secret of ['split-secret', 'known-secret-value', 'abcdef', 'private-value', 'dummy-key-material']) assert.ok(!serialized.includes(secret), secret);
  assert.match(snapshots.at(-1).output, /\[stderr\] warning/);
  assert.equal(snapshots.at(-1).state, 'success');
  assert.ok(snapshots.every((row) => row.activityGroupId === 'model-tool-batch:test-one'));
  assert.match(redactActivity('https://name:password@host/path'), /REDACTED/);
  delete process.env.ACTIVITY_TEST_TOKEN;
  pass('split-chunk secrets, known secrets, bearer, synthetic PEM, stderr');

  const complete = [];
  const flood = createToolActivity('flood', 'run_terminal', {}, (row) => complete.push(row));
  const longLine = 'x'.repeat(50_000);
  flood.output('stdout', `${longLine}\n`);
  for (let i = 0; i < 1000; i++) flood.output('stdout', `line ${i} ${'x'.repeat(60)}\n`);
  flood.finish('{"ok":false,"exit_code":3}');
  assert.ok(complete.length <= 3);
  assert.match(complete.at(-1).output, new RegExp(`^${longLine.slice(0, 80)}`));
  assert.match(complete.at(-1).output, /line 0 /);
  assert.match(complete.at(-1).output, /line 999 /);
  assert.ok(complete.at(-1).output.length > 100_000);
  assert.equal(complete.at(-1).truncated, false);
  assert.equal(complete.at(-1).state, 'failed');
  assert.equal(complete.at(-1).exitCode, 3);
  pass('complete long-line and 100k+ output, throttling, exit failure');

  for (const tool of ['run_terminal', 'run_tests', 'run_diagnostics']) {
    const rows = [];
    let resolved = false;
    let seenBeforeExit = false;
    const task = executeAgentTool(temp, { id: tool, type: 'function', function: { name: tool,
      arguments: JSON.stringify({ command: "[Console]::Out.WriteLine('first-live'); Start-Sleep -Milliseconds 1300; [Console]::Error.WriteLine('stderr-live'); [Console]::Out.WriteLine('last-live'); exit 0" }) } }, {}, {
      onToolActivity: (row) => {
        rows.push(row);
        if (row.state === 'running' && row.output.includes('first-live') && !resolved) seenBeforeExit = true;
      },
    }).then((result) => { resolved = true; return result; });
    const result = await task;
    assert.equal(JSON.parse(result.output).ok, true, result.output);
    assert.ok(seenBeforeExit, `${tool}: output must arrive BEFORE completion`);
    assert.match(rows.at(-1).output, /stderr-live/);
    assert.match(rows.at(-1).output, /last-live/);
    assert.equal(rows.at(-1).state, 'success');
    pass(`${tool} real shell streams before exit`);
  }

  const controller = new AbortController();
  const cancelRows = [];
  await executeAgentTool(temp, { id: 'cancel', type: 'function', function: { name: 'run_terminal',
    arguments: JSON.stringify({ command: "[Console]::Out.WriteLine('ready'); Start-Sleep -Seconds 20" }) } }, {}, {
    signal: controller.signal,
    onToolActivity: (row) => { cancelRows.push(row); if (row.output.includes('ready')) controller.abort(); },
  });
  assert.equal(cancelRows.at(-1).state, 'cancelled');
  assert.equal(listActiveTerminalJobIds().length, 0);
  const timeout = await runTerminalCommandAsync(temp, 'Start-Sleep -Seconds 20', { timeoutMs: 250 });
  assert.equal(timeout.ok, false); assert.equal(timeout.exit_code, null); assert.match(timeout.stderr, /timed out/);
  const blocked = await runTerminalCommandAsync(temp, 'git push');
  assert.equal(blocked.ok, false); assert.match(blocked.stderr, /safety policy/);
  pass('cancel, timeout, cleanup, unchanged command policy');

  const failures = [];
  await executeAgentTool(temp, { id: 'fail', type: 'function', function: { name: 'run_terminal', arguments: '{"command":"exit 7"}' } }, {}, { onToolActivity: (row) => failures.push(row) });
  assert.equal(failures.at(-1).state, 'failed'); assert.equal(failures.at(-1).exitCode, 7);
  pass('real nonzero exit');

  writeFileSync(path.join(temp, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "console.log(123)"' } }));
  const detected = await executeAgentTool(temp, { id: 'detected', type: 'function', function: { name: 'run_tests', arguments: '{}' } });
  assert.equal(JSON.parse(detected.output).ok, true, detected.output);
  assert.equal(JSON.parse(detected.output).detected.kind, 'npm');
  pass('auto-detected npm tests');

  const sessions = path.join(temp, 'sessions'); mkdirSync(sessions);
  const store = new SessionStore(sessions, temp);
  store.beginAssistantThought('one'); store.beginAssistantThought('two');
  for (let i = 0; i < 90; i++) store.appendToolActivity('one', { ...snapshots.at(-1), id: String(i) });
  store.appendToolActivity('two', { ...snapshots.at(-1), id: 'only-two' });
  appendAssistantReply(store, 'one', { content: 'done', model: 'fixture', mode: 'chat' });
  appendAssistantReply(store, 'two', { content: 'failed', model: 'fixture', mode: 'chat', application_notice: { kind: 'failure', title: 'test', message: 'test' } });
  const reloaded = new SessionStore(sessions, temp);
  assert.equal(reloaded.load('one').messages[0].tool_activity.length, 90);
  assert.equal(reloaded.load('one').messages[0].work_timeline.length, 90);
  assert.ok(reloaded.load('one').messages[0].tool_activity.every((row) => row.activityGroupId === 'model-tool-batch:test-one'));
  assert.equal(reloaded.load('two').messages[0].tool_activity[0].id, 'only-two');
  assert.equal(reloaded.load('one').messages[0].reasoning, undefined);
  store.beginAssistantThought('one');
  appendAssistantReply(store, 'one', { content: 'new', model: 'fixture', mode: 'chat' });
  assert.equal(store.load('one').messages.at(-1).tool_activity, undefined);
  pass('disk restore, session isolation, complete grouped activities, failure persistence, no next-turn leak');
  console.log(`\n${count} tool-activity checks passed`);
} finally {
  delete process.env.ACTIVITY_TEST_TOKEN;
  rmSync(temp, { recursive: true, force: true });
}
