import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  PersonalSchedulerService,
  classifySchedulerContentOutcome,
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
  assert.equal(classifySchedulerContentOutcome('Everything completed successfully.'), 'success');
  assert.equal(classifySchedulerContentOutcome('실행은 끝났지만 파일 생성에 실패했습니다.'), 'failed');
  assert.equal(classifySchedulerContentOutcome('로그인이 필요해 작업이 차단되었습니다.'), 'blocked');
  assert.equal(classifySchedulerContentOutcome('일부 항목은 누락되어 확인이 필요합니다.'), 'warning');

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
  assert.equal(service.listRuns().find((run) => run.id === manualRun.id)?.outcome, 'success');
  assert.equal(service.listFeed()[0].outcome, 'success');
  const contentFailureRun = service.createRun(manual.id, 'manual');
  service.completeRun(contentFailureRun.id, manual, '자료 접근 권한이 없어 작업이 차단되었습니다.');
  assert.equal(service.listRuns().find((run) => run.id === contentFailureRun.id)?.status, 'failed');
  assert.equal(service.listRuns().find((run) => run.id === contentFailureRun.id)?.outcome, 'blocked');
  assert.equal(service.listFeed()[0].outcome, 'blocked');

  // 대기 중(queued) 실행은 취소되고, 큐 차례가 와도 executor를 시작하지 않는다.
  const cancelTarget = service.createRun(manual.id, 'manual');
  const cancelResult = service.cancelRun(cancelTarget.id);
  assert.equal(cancelResult.ok, true);
  assert.equal(service.listRuns().find((run) => run.id === cancelTarget.id)?.status, 'cancelled');
  assert.equal(service.markRunning(cancelTarget.id), false);
  const reCancel = service.cancelRun(cancelTarget.id);
  assert.equal(reCancel.ok, false);
  assert.equal(reCancel.ok === false && reCancel.reason, 'not_queued');
  assert.equal(service.cancelRun('00000000-0000-0000-0000-000000000000').ok, false);

  // 읽지 않은 결과·오류 피드 수 집계와 읽음 처리 배지 해제.
  const unreadBefore = service.countUnreadFeed();
  assert.ok(unreadBefore >= 1);
  assert.equal(service.markFeedRead(), unreadBefore);
  assert.equal(service.countUnreadFeed(), 0);

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
  const skipNotice = service.listFeed(200).find((item) => item.task_id === skipped.id);
  assert.equal(skipNotice?.kind, 'status');
  assert.equal(skipNotice?.status_reason, 'skipped_offline');
  assert.equal(skipNotice?.outcome, 'warning');
  assert.ok(skipNotice?.scheduled_at);
  service.deleteTask(skipped.id);

  // 한 번 실행(at) 작업이 앱 꺼진 동안 지나가면 만료로 기록된다.
  const missedAt = new Date(Date.now() - 60_000).toISOString();
  const oneShot = service.store.saveTask({
    name: 'Missed one-shot',
    instruction: 'Should expire.',
    triggers: [{ type: 'time', config: { at: missedAt } }],
    enabled: true,
    misfire_policy: 'skip',
  }, missedAt);
  runtime.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  runtime.stop();
  const expiredNotice = service.listFeed(200).find((item) => item.task_id === oneShot.id);
  assert.equal(expiredNotice?.status_reason, 'expired_offline');
  assert.equal(service.getTask(oneShot.id)?.next_run_at, null);
  service.deleteTask(oneShot.id);

  // 실패한 실행도 result.md와 trace.jsonl 첨부를 남긴다.
  const failedRun = service.createRun(manual.id, 'manual');
  assert.equal(service.writeRunTrace(failedRun.id, [{ type: 'run', event: 'start', at: new Date().toISOString() }]), true);
  service.failRun(failedRun.id, manual, 'provider timeout');
  const failedFeed = service.listFeed(200).find((item) => item.run_id === failedRun.id);
  assert.deepEqual(failedFeed?.attachments.map((a) => a.name), ['automation-result.md', 'automation-trace.jsonl']);
  const failedResult = readFileSync(path.join(root, 'data', 'outputs', 'automations', failedRun.id, 'result.md'), 'utf8');
  assert.match(failedResult, /provider timeout/);

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

  // 읽은 피드 정리: 읽은 레코드만 제거하고 읽지 않은 항목과 생성 결과 파일은 유지한다.
  const feedBeforeCleanup = service.listFeed(200);
  const readBeforeCleanup = feedBeforeCleanup.filter((item) => item.read_at !== null).length;
  const unreadBeforeCleanup = feedBeforeCleanup.filter((item) => item.read_at === null).length;
  assert.ok(readBeforeCleanup > 0);
  assert.equal(service.clearFeed('read'), readBeforeCleanup);
  assert.equal(service.listFeed(200).length, unreadBeforeCleanup);
  assert.equal(service.listFeed(200).every((item) => item.read_at === null), true);
  assert.equal(existsSync(generatedResultPath), true);

  // 앱 재시작 시 미완료 실행 정리 + 오래된 기록·산출물 정리.
  const recoveryRoot = mkdtempSync(path.join(tmpdir(), 'cqr-personal-scheduler-recovery-'));
  try {
    const crashed = PersonalSchedulerService.forRoot(recoveryRoot);
    const crashTask = crashed.saveTask({
      name: 'Crash task', instruction: 'x', triggers: [{ type: 'manual', config: {} }],
    });
    const runningRun = crashed.createRun(crashTask.id, 'manual');
    crashed.markRunning(runningRun.id);
    const queuedRun = crashed.createRun(crashTask.id, 'manual');
    const reborn = PersonalSchedulerService.forRoot(recoveryRoot);
    const rebornRuntime = new PersonalSchedulerRuntime(reborn, async () => ({ content: 'ok' }), 60_000);
    rebornRuntime.start();
    rebornRuntime.stop();
    assert.equal(reborn.listRuns().find((run) => run.id === runningRun.id)?.status, 'failed');
    assert.equal(reborn.listRuns().find((run) => run.id === queuedRun.id)?.status, 'cancelled');
    const interruptedFeed = reborn.listFeed(200).find((item) => item.run_id === runningRun.id);
    assert.equal(interruptedFeed?.kind, 'error');
    assert.equal(interruptedFeed?.status_reason, 'interrupted');

    // 보존 기간이 지난 실행·읽은 피드·미참조 산출물 폴더 정리.
    const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
    const oldRun = reborn.createRun(crashTask.id, 'manual');
    reborn.completeRun(oldRun.id, crashTask, 'done');
    for (const run of reborn.store.runs.runs) { run.created_at = old; run.finished_at = old; }
    for (const item of reborn.store.feed.items) { item.created_at = old; }
    reborn.markFeedRead();
    const orphanId = '11111111-1111-1111-1111-111111111111';
    const orphanDir = path.join(recoveryRoot, 'data', 'outputs', 'automations', orphanId);
    mkdirSync(orphanDir, { recursive: true });
    const oldDate = new Date(Date.now() - 200 * 86_400_000);
    utimesSync(orphanDir, oldDate, oldDate);
    const oldRunDir = path.join(recoveryRoot, 'data', 'outputs', 'automations', oldRun.id);
    utimesSync(oldRunDir, oldDate, oldDate);
    const pruned = reborn.pruneHistory();
    assert.ok(pruned.runs >= 3);
    assert.ok(pruned.feed >= 1);
    assert.equal(existsSync(orphanDir), false);
    assert.equal(existsSync(oldRunDir), false);
    assert.equal(reborn.listRuns().length, 0);
    crashed.close();
    reborn.close();
  } finally {
    rmSync(recoveryRoot, { recursive: true, force: true });
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
    cancellation: 'queued runs cancel atomically and never start; finished runs stay not_queued',
    feedBadge: 'unread result/error feed counted and cleared by markFeedRead',
    feedCleanup: 'read feed records are removed without deleting generated artifacts',
    storage: 'task files and separate runs/feed/weekly JSON files persist across service reopen',
  }, null, 2));
} finally {
  runtime.stop();
  service.close();
  rmSync(root, { recursive: true, force: true });
}
