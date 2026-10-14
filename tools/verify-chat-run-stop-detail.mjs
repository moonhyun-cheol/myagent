#!/usr/bin/env node
/**
 * Stop progress detail: /chat/cancel reports which tools are still running and
 * how long the cancellation has been pending; UI keeps re-checking and only
 * offers a UI-only force release after a long unconfirmed stop.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const {
  beginChatRun, cancelChatRun, chatRunStopDetail, executeChatRun, trackChatRunTool,
} = await import('../core/dist/chat/chat-runs.js');

const run = beginChatRun('s-stop', 'run-1');
let release;
const blocker = new Promise((resolve) => { release = resolve; });
const exec = executeChatRun(run, undefined, async () => {
  const untrack = trackChatRunTool('run_tests');
  try { await blocker; } finally { untrack(); }
  return 'done';
}, () => {});
await new Promise((resolve) => setTimeout(resolve, 5));
assert.deepEqual(chatRunStopDetail('s-stop', 'run-1').active_tools, [], 'running run: no stop detail');

assert.equal(cancelChatRun('s-stop', 'run-1'), 'cancelling');
const detail = chatRunStopDetail('s-stop', 'run-1', Date.now() + 1_500);
assert.equal(detail.active_tools.length, 1, 'cancelling run lists the running tool');
assert.equal(detail.active_tools[0].name, 'run_tests');
assert.ok(detail.active_tools[0].elapsed_ms >= 1_500, 'tool elapsed time reported');
assert.ok((detail.cancelling_ms ?? 0) >= 1_500, 'cancelling duration reported');

release();
await exec;
assert.equal(cancelChatRun('s-stop', 'run-1'), 'stopped');
assert.deepEqual(chatRunStopDetail('s-stop', 'run-1').active_tools, [], 'stopped run: tools cleared');

// Tracking outside a run is a no-op.
trackChatRunTool('read_file')();

const dispatch = readFileSync('core/src/routes/dispatch.ts', 'utf8');
assert.match(dispatch, /chatRunStopDetail\(session, doc\.runId\)/, '/chat/cancel returns stop detail');
const toolExec = readFileSync('core/src/agent/agent-tool-execute.ts', 'utf8');
assert.match(toolExec, /trackChatRunTool\(normalized\.function\.name\)/, 'tool execution is tracked');
assert.match(toolExec, /untrack\(\);/, 'tool tracking released in finally');

const store = readFileSync('ui/workspace/src/store/workspaceStore.ts', 'utf8');
assert.match(store, /STOP_FORCE_RELEASE_MS = 60_000/, 'force release only after 60s');
assert.match(store, /watchUntilStopped\(sid, expected\)/, 'auto re-check after first window');
assert.match(store, /Never auto-send queued work after a forced release/, 'forced release keeps queue in review');
assert.doesNotMatch(store, /정지 버튼으로 재확인/, 'old manual re-check wording removed');
const pane = readFileSync('ui/workspace/src/components/ChatPane.tsx', 'utf8');
assert.match(pane, /stopForceReleasable \?/, 'force release button gated');
assert.match(pane, /then\(\(ok\) => \{ if \(ok\) forceReleaseStoppedRun\(\); \}\)/, 'force release requires confirm');

console.log('verify-chat-run-stop-detail: ok');
