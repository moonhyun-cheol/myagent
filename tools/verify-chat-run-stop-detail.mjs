#!/usr/bin/env node
/**
 * Stop progress detail: /chat/cancel reports which tools are still running and
 * how long the cancellation has been pending; UI keeps re-checking until the
 * server confirms the stop (no UI-only force release).
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
assert.match(store, /watchUntilStopped\(sid, expected\)/, 'auto re-check after first window');
assert.doesNotMatch(store, /forceReleaseStoppedRun|stopForceReleasable|STOP_FORCE_RELEASE_MS/, 'UI-only force release removed');
assert.doesNotMatch(store, /정지 버튼으로 재확인/, 'old manual re-check wording removed');
const pane = readFileSync('ui/workspace/src/components/ChatPane.tsx', 'utf8');
assert.doesNotMatch(pane, /forceReleaseStoppedRun|stopForceReleasable|강제 해제/, 'force release button removed');

console.log('verify-chat-run-stop-detail: ok');
