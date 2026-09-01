import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  PersonalSchedulerService,
  computeNextRun,
} from '../core/dist/scheduler/personal-scheduler-service.js';
import { PersonalSchedulerRuntime } from '../core/dist/scheduler/personal-scheduler-runtime.js';
import {
  registerPersonalSchedulerRuntime,
  unregisterPersonalSchedulerRuntime,
} from '../core/dist/scheduler/runtime-registry.js';
import { executeAgentTool } from '../core/dist/agent/agent-tool-execute.js';
import { needsHumanApproval } from '../core/dist/agent/tool-approval.js';

const root = mkdtempSync(path.join(tmpdir(), 'cqr-personal-scheduler-'));
const service = PersonalSchedulerService.forRoot(root);
const executed = [];
const runtime = new PersonalSchedulerRuntime(service, async (task, run) => {
  executed.push({ taskId: task.id, runId: run.id });
  return {
    content: `result:${task.name}`,
    attachments: [{ name: 'report.md', path: path.join(root, 'report.md') }],
  };
}, 60_000);

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for scheduler state');
}

try {
  const firstIsoWeekday = computeNextRun([{
    type: 'time',
    config: {
      daily_time: '09:00',
      weekdays: [1],
    },
  }], new Date(2026, 7, 30, 10, 0, 0));
  const expectedMonday = new Date(2026, 7, 31, 9, 0, 0).toISOString();
  assert.equal(firstIsoWeekday, expectedMonday);
  assert.throws(() => service.saveTask({
    name: 'Invalid weekday',
    instruction: 'Must not be saved.',
    triggers: [{ type: 'time', config: { daily_time: '09:00', weekdays: [0] } }],
  }), /ISO values 1 \(Monday\) through 7 \(Sunday\)/);

  const weekly = service.saveTask({
    name: 'ISO weekly queue task',
    instruction: 'Run once in this ISO week.',
    triggers: [{ type: 'time', config: { daily_time: '09:00', weekdays: [1] } }],
    enabled: true,
    misfire_policy: 'run_once',
  });
  const mondayBefore = new Date(2026, 7, 31, 8, 0, 0);
  const mondayAfter = new Date(2026, 7, 31, 10, 0, 0);
  const weeklyQueue = service.ensureCurrentWeeklyQueue(mondayBefore);
  assert.equal(weeklyQueue.week_key, '2026-W36');
  assert.deepEqual(weeklyQueue.remaining.map((item) => item.task_id), [weekly.id]);
  assert.equal(service.claimReadyWeeklyItem(mondayBefore), null);
  assert.equal(service.claimReadyWeeklyItem(mondayAfter)?.task_id, weekly.id);
  assert.equal(service.ensureCurrentWeeklyQueue(mondayAfter).remaining.length, 0);
  assert.equal(service.claimReadyWeeklyItem(mondayAfter), null);
  service.deleteTask(weekly.id);

  const manual = service.saveTask({
    name: 'Weekly research',
    description: 'Personal report',
    instruction: 'Research the configured subject and write a concise report.',
    triggers: [{ type: 'manual', config: {} }],
    enabled: true,
    misfire_policy: 'skip',
  });
  assert.equal(service.listTasks().length, 1);
  assert.equal(manual.next_run_at, null);

  runtime.start();
  assert.equal(runtime.isRunning(), true);
  const manualRun = runtime.runNow(manual.id);
  await waitFor(() => service.listRuns().some((run) => run.id === manualRun.id && run.status === 'succeeded'));
  assert.equal(service.listFeed()[0].attachments[0].name, 'report.md');
  const generatedResult = service.listFeed()[0].attachments.at(-1);
  assert.equal(generatedResult?.path, `/outputs/automations/${manualRun.id}/result.md`);
  const generatedResultPath = path.join(root, 'data', 'outputs', 'automations', manualRun.id, 'result.md');
  assert.equal(existsSync(generatedResultPath), true);
  assert.equal(readFileSync(generatedResultPath, 'utf8'), 'result:Weekly research');

  const actionTask = service.saveTask({
    name: 'After export',
    instruction: 'Summarize the export.',
    triggers: [{ type: 'on_action', config: { action: 'export.completed' } }],
    enabled: true,
    misfire_policy: 'skip',
  });
  const actionRuns = runtime.emitAction('export.completed');
  assert.equal(actionRuns.length, 1);
  await waitFor(() => service.listRuns().some((run) => run.id === actionRuns[0].id && run.status === 'succeeded'));

  registerPersonalSchedulerRuntime(root, runtime);
  const listResult = await executeAgentTool(root, {
    id: 'verify-list',
    type: 'function',
    function: { name: 'scheduler_list', arguments: '{}' },
  }, {}, { cqrRoot: root, sessionId: 'verify' });
  assert.match(listResult.output, /Weekly research/);
  assert.equal(needsHumanApproval('scheduler_list', {}).needed, false);
  assert.equal(needsHumanApproval('scheduler_upsert', { name: 'Approved task' }).needed, true);
  assert.equal(needsHumanApproval('scheduler_set_state', { id: actionTask.id, action: 'delete' }).danger, true);
  unregisterPersonalSchedulerRuntime(root, runtime);
  runtime.stop();
  assert.equal(runtime.isRunning(), false);

  const skipped = service.saveTask({
    name: 'Skip missed run',
    instruction: 'Should not run on startup.',
    triggers: [{ type: 'time', config: { interval_minutes: 5 } }],
    enabled: true,
    misfire_policy: 'skip',
  });
  service.store.setNextRun(skipped.id, new Date(Date.now() - 60_000).toISOString());
  const beforeSkip = service.listRuns().length;
  runtime.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(service.listRuns().length, beforeSkip);
  runtime.stop();

  const runOnce = service.saveTask({
    name: 'Recover missed run',
    instruction: 'Run once when the app starts.',
    triggers: [{ type: 'time', config: { interval_minutes: 5 } }],
    enabled: true,
    misfire_policy: 'run_once',
  });
  service.store.setNextRun(runOnce.id, new Date(Date.now() - 60_000).toISOString());
  runtime.start();
  await waitFor(() => service.listRuns().some((run) => run.task_id === runOnce.id && run.status === 'succeeded'));
  runtime.stop();

  assert.ok(executed.length >= 3);
  console.log(JSON.stringify({
    ok: true,
    tasks: service.listTasks().length,
    runs: service.listRuns().length,
    feedItems: service.listFeed().length,
    approvalGate: 'scheduler mutations require once approval',
    lifecycle: 'runtime start/stop verified',
    misfire: 'skip and run_once verified',
    isoWeekday: 'ISO weekday 1 (Monday) verified',
    weeklyQueue: 'ISO week queue is created once and drained without recreation',
  }, null, 2));
} finally {
  runtime.stop();
  service.close();
  rmSync(root, { recursive: true, force: true });
}
