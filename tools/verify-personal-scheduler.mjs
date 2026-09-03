import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  PersonalSchedulerService,
  computeNextRun,
  isoWeekKey,
} from '../core/dist/scheduler/personal-scheduler-service.js';
import { PersonalSchedulerRuntime } from '../core/dist/scheduler/personal-scheduler-runtime.js';
import {
  registerPersonalSchedulerRuntime,
  unregisterPersonalSchedulerRuntime,
} from '../core/dist/scheduler/runtime-registry.js';
import { executeAgentTool } from '../core/dist/agent/agent-tool-execute.js';
import { needsHumanApproval } from '../core/dist/agent/tool-approval.js';
import { loadUserOverrides, saveUserOverrides } from '../core/dist/config/user-overrides.js';
import { resolveSchedulerExecutionConfig } from '../core/dist/scheduler/execution-config.js';

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
  const schedulerConfigPath = path.join(root, 'data', 'config', 'user-overrides.json');
  mkdirSync(path.dirname(schedulerConfigPath), { recursive: true });
  const schedulerDefaults = resolveSchedulerExecutionConfig(loadUserOverrides(schedulerConfigPath));
  assert.equal(schedulerDefaults.model, 'provider:custom@openai%2Fgpt-5.6-luna');
  assert.equal(schedulerDefaults.executionPolicy.reasoning, 'auto');
  saveUserOverrides(schedulerConfigPath, { scheduler_default_model: 'provider:openai@gpt-test' }, root);
  assert.equal(resolveSchedulerExecutionConfig(loadUserOverrides(schedulerConfigPath)).model, 'provider:openai@gpt-test');

  const firstIsoWeekday = computeNextRun([{
    type: 'time',
    config: {
      daily_time: '09:00',
      weekdays: [1],
    },
  }], new Date(2026, 7, 30, 10, 0, 0));
  const expectedMonday = new Date(2026, 7, 31, 9, 0, 0).toISOString();
  assert.equal(firstIsoWeekday, expectedMonday);
  assert.equal(isoWeekKey(new Date(2020, 11, 31, 12, 0, 0)), '2020-W52');
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
  assert.deepEqual(service.getCompletedWeeklyQueue('2026-W36')?.items.map((item) => item.task_id), [weekly.id]);
  assert.equal(service.getCompletedWeeklyQueue('2026-W36')?.items[0].resolution, 'executed');
  service.deleteTask(weekly.id);

  const carryWeekly = service.saveTask({
    name: 'Carry missed weekly task',
    instruction: 'Run once in the next ISO week when missed.',
    triggers: [{ type: 'time', config: { daily_time: '09:00', weekdays: [1] } }],
    enabled: true,
    misfire_policy: 'run_once',
  });
  const expireWeekly = service.saveTask({
    name: 'Expire missed weekly task',
    instruction: 'Use only the current ISO week occurrence.',
    triggers: [{ type: 'time', config: { daily_time: '09:00', weekdays: [1] } }],
    enabled: true,
    misfire_policy: 'skip',
  });
  service.ensureCurrentWeeklyQueue(new Date(2026, 8, 7, 8, 0, 0));
  const rolledQueue = service.ensureCurrentWeeklyQueue(new Date(2026, 8, 14, 8, 0, 0));
  const carriedItem = rolledQueue.remaining.find((item) => item.task_id === carryWeekly.id);
  assert.equal(carriedItem?.origin_week_key, '2026-W37');
  assert.equal(rolledQueue.remaining.filter((item) => item.task_id === carryWeekly.id).length, 1);
  assert.equal(rolledQueue.remaining.filter((item) => item.task_id === expireWeekly.id).length, 1);
  const priorWeekCompleted = service.getCompletedWeeklyQueue('2026-W37')?.items ?? [];
  assert.equal(priorWeekCompleted.find((item) => item.task_id === carryWeekly.id)?.resolution, 'carried');
  assert.equal(priorWeekCompleted.find((item) => item.task_id === expireWeekly.id)?.resolution, 'expired');
  service.deleteTask(carryWeekly.id);
  service.deleteTask(expireWeekly.id);

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
  const schedulerRoot = path.join(root, 'data', 'scheduler');
  const taskPath = path.join(schedulerRoot, 'tasks', `${manual.id}.json`);
  assert.equal(existsSync(taskPath), true);
  assert.equal(JSON.parse(readFileSync(taskPath, 'utf8')).id, manual.id);
  assert.equal(Array.isArray(JSON.parse(readFileSync(path.join(schedulerRoot, 'runs.json'), 'utf8')).runs), true);
  assert.equal(Array.isArray(JSON.parse(readFileSync(path.join(schedulerRoot, 'feed.json'), 'utf8')).items), true);
  assert.equal(Boolean(JSON.parse(readFileSync(path.join(schedulerRoot, 'weekly-queue.json'), 'utf8')).weeks['2026-W36']), true);
  assert.equal(JSON.parse(readFileSync(path.join(schedulerRoot, 'weekly-completed.json'), 'utf8')).weeks['2026-W36'].items[0].task_id, weekly.id);

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

  const reopened = PersonalSchedulerService.forRoot(root);
  try {
    assert.equal(reopened.listTasks().some((task) => task.id === manual.id), true);
    assert.equal(reopened.listRuns().some((run) => run.id === manualRun.id && run.status === 'succeeded'), true);
    assert.equal(reopened.listFeed().some((item) => item.run_id === manualRun.id), true);
  } finally {
    reopened.close();
  }

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
    isoWeek53: 'ISO week 53 is folded into week 52',
    weeklyQueue: 'ISO week queue is created once and drained without recreation',
    weeklyRollover: 'skip expires and run_once carries one occurrence without duplication',
    storage: 'task files and separate runs/feed/weekly JSON files persist across service reopen',
  }, null, 2));
} finally {
  runtime.stop();
  service.close();
  rmSync(root, { recursive: true, force: true });
}
