import path from 'node:path';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { PersonalSchedulerStore } from './personal-scheduler-store.js';
import type { SchedulerTraceEntry } from './run-trace.js';
import type {
  PersonalSchedulerTask,
  SchedulerContentOutcome,
  SchedulerFeedAttachment,
  SchedulerFeedItem,
  SchedulerRun,
  SchedulerRunSource,
  SchedulerTaskInput,
  SchedulerTrigger,
  SchedulerWeeklyCompletedList,
  SchedulerWeeklyQueue,
  SchedulerWeeklyQueueItem,
} from './types.js';

/** 실행·피드·산출물 보존 기간과 개수 상한. */
export const SCHEDULER_HISTORY_RETENTION_DAYS = 90;
export const SCHEDULER_MAX_RUNS = 1_000;
export const SCHEDULER_MAX_FEED_ITEMS = 500;
const RUN_ID_RE = /^[0-9a-f-]{36}$/i;

const CONTENT_OUTCOME_PATTERNS: Array<{ outcome: Exclude<SchedulerContentOutcome, 'success'>; pattern: RegExp }> = [
  { outcome: 'blocked', pattern: /(?:^|\b)(?:blocked|blocker|permission denied|access denied|approval required|login required|captcha)(?:\b|$)|(?:차단|권한(?:이|을)?\s*(?:없|필요)|승인(?:이|을)?\s*필요|로그인(?:이|을)?\s*필요)/iu },
  { outcome: 'failed', pattern: /(?:^|\b)(?:failed|failure|error|unsuccessful|could not|unable to|timed out)(?:\b|$)|(?:실패|오류|완료하지 못|수행하지 못|처리하지 못|찾지 못|시간 초과)/iu },
  { outcome: 'warning', pattern: /(?:^|\b)(?:warning|partial(?:ly)?|incomplete|skipped)(?:\b|$)|(?:주의|경고|부분 완료|일부.*(?:건너|누락|미완료)|누락.*확인)/iu },
];

export function classifySchedulerContentOutcome(content: string): SchedulerContentOutcome {
  const normalized = String(content ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return 'warning';
  for (const candidate of CONTENT_OUTCOME_PATTERNS) {
    if (candidate.pattern.test(normalized)) return candidate.outcome;
  }
  return 'success';
}

function isValidDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validateTriggers(triggers: SchedulerTrigger[]): void {
  if (!Array.isArray(triggers) || triggers.length === 0) throw new Error('At least one trigger is required');
  const allowed = new Set(['time', 'sequence', 'on_action', 'condition', 'manual']);
  for (const trigger of triggers) {
    if (!allowed.has(trigger?.type)) throw new Error(`Unsupported trigger type: ${String(trigger?.type)}`);
    if (!trigger.config || typeof trigger.config !== 'object' || Array.isArray(trigger.config)) {
      throw new Error(`Trigger config must be an object: ${trigger.type}`);
    }
    if (trigger.type === 'time') {
      const { at, interval_minutes: intervalMinutes, daily_time: dailyTime } = trigger.config;
      const validAt = isValidDate(at);
      const validInterval = Number.isFinite(Number(intervalMinutes)) && Number(intervalMinutes) >= 1;
      const validDaily = typeof dailyTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(dailyTime);
      if (!validAt && !validInterval && !validDaily) {
        throw new Error('Time trigger requires at, interval_minutes, or daily_time');
      }
      if (Array.isArray(trigger.config.weekdays) && trigger.config.weekdays.some(
        (day) => !Number.isInteger(Number(day)) || Number(day) < 1 || Number(day) > 7,
      )) throw new Error('Time trigger weekdays must use ISO values 1 (Monday) through 7 (Sunday)');
    }
    if (trigger.type === 'on_action' && typeof trigger.config.action !== 'string') {
      throw new Error('On-action trigger requires config.action');
    }
  }
}

function nextDaily(config: Record<string, unknown>, from: Date): Date | null {
  const daily = typeof config.daily_time === 'string' ? config.daily_time : '';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(daily)) return null;
  const [hours, minutes] = daily.split(':').map(Number);
  const weekdays = Array.isArray(config.weekdays)
    ? config.weekdays.map(Number).filter((day) => Number.isInteger(day) && day >= 1 && day <= 7)
    : [];
  for (let offset = 0; offset <= 8; offset += 1) {
    const candidate = new Date(from);
    candidate.setSeconds(0, 0);
    candidate.setDate(candidate.getDate() + offset);
    candidate.setHours(hours, minutes, 0, 0);
    if (candidate.getTime() <= from.getTime()) continue;
    const isoWeekday = candidate.getDay() === 0 ? 7 : candidate.getDay();
    if (weekdays.length > 0 && !weekdays.includes(isoWeekday)) continue;
    return candidate;
  }
  return null;
}

export function computeNextRun(triggers: SchedulerTrigger[], from = new Date()): string | null {
  const candidates: number[] = [];
  for (const trigger of triggers) {
    if (trigger.type !== 'time') continue;
    const { at, interval_minutes: intervalMinutes } = trigger.config;
    if (isValidDate(at) && Date.parse(at) > from.getTime()) candidates.push(Date.parse(at));
    const interval = Number(intervalMinutes);
    if (Number.isFinite(interval) && interval >= 1) candidates.push(from.getTime() + interval * 60_000);
    const daily = nextDaily(trigger.config, from);
    if (daily) candidates.push(daily.getTime());
  }
  return candidates.length > 0 ? new Date(Math.min(...candidates)).toISOString() : null;
}

export function isoWeekKey(date: Date): string {
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const weekday = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - weekday);
  const isoYear = utc.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil((((utc.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${isoYear}-W${String(Math.min(week, 52)).padStart(2, '0')}`;
}

function weeklyOccurrence(task: PersonalSchedulerTask, weekDate: Date): string | null {
  const candidates: number[] = [];
  for (const trigger of task.triggers) {
    if (trigger.type !== 'time') continue;
    const daily = typeof trigger.config.daily_time === 'string' ? trigger.config.daily_time : '';
    const weekdays = Array.isArray(trigger.config.weekdays)
      ? trigger.config.weekdays.map(Number).filter((day) => Number.isInteger(day) && day >= 1 && day <= 7)
      : [];
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(daily) || weekdays.length !== 1) continue;
    const [hours, minutes] = daily.split(':').map(Number);
    const currentIsoWeekday = weekDate.getDay() === 0 ? 7 : weekDate.getDay();
    const monday = new Date(weekDate);
    monday.setHours(hours, minutes, 0, 0);
    monday.setDate(monday.getDate() - (currentIsoWeekday - 1));
    const candidate = new Date(monday);
    candidate.setDate(monday.getDate() + weekdays[0] - 1);
    candidates.push(candidate.getTime());
  }
  return candidates.length > 0 ? new Date(Math.min(...candidates)).toISOString() : null;
}

export class PersonalSchedulerService {
  readonly store: PersonalSchedulerStore;
  readonly artifactRoot: string;

  constructor(schedulerRoot: string, artifactRoot = path.join(path.dirname(schedulerRoot), 'outputs', 'automations')) {
    this.store = new PersonalSchedulerStore(schedulerRoot);
    this.artifactRoot = artifactRoot;
  }

  static forRoot(cqrRoot: string): PersonalSchedulerService {
    return new PersonalSchedulerService(
      path.join(cqrRoot, 'data', 'scheduler'),
      path.join(cqrRoot, 'data', 'outputs', 'automations'),
    );
  }

  close(): void { this.store.close(); }
  listTasks(): PersonalSchedulerTask[] { return this.store.listTasks(); }
  getTask(id: string): PersonalSchedulerTask | null { return this.store.getTask(id); }
  listRuns(limit?: number): SchedulerRun[] { return this.store.listRuns(limit); }
  countActiveRuns(): number { return this.store.countActiveRuns(); }
  listFeed(limit?: number): SchedulerFeedItem[] { return this.store.listFeed(limit); }
  clearFeed(scope: 'read' | 'all' = 'read'): number { return this.store.clearFeed(scope); }

  isWeeklyTask(task: PersonalSchedulerTask): boolean {
    return weeklyOccurrence(task, new Date()) !== null;
  }

  ensureCurrentWeeklyQueue(now = new Date()): SchedulerWeeklyQueue {
    const weekKey = isoWeekKey(now);
    const tasks = this.listTasks();
    const items = tasks
      .filter((task) => task.enabled)
      .map((task) => ({ task, availableAt: weeklyOccurrence(task, now) }))
      .filter((row): row is { task: PersonalSchedulerTask; availableAt: string } => Boolean(row.availableAt))
      .map((row) => ({ taskId: row.task.id, availableAt: row.availableAt }));
    this.store.ensureWeeklyQueue(weekKey, items);
    this.store.rolloverWeeklyQueues(weekKey, tasks, now.toISOString());
    return this.store.getWeeklyQueue(weekKey)!;
  }

  getWeeklyQueue(weekKey = isoWeekKey(new Date())): SchedulerWeeklyQueue | null {
    return this.store.getWeeklyQueue(weekKey);
  }

  getCompletedWeeklyQueue(weekKey = isoWeekKey(new Date())): SchedulerWeeklyCompletedList | null {
    return this.store.getCompletedWeeklyQueue(weekKey);
  }

  claimReadyWeeklyItem(now = new Date()): SchedulerWeeklyQueueItem | null {
    return this.store.claimReadyWeeklyItem(isoWeekKey(now), now.toISOString());
  }

  saveTask(input: SchedulerTaskInput, id?: string): PersonalSchedulerTask {
    const normalized: SchedulerTaskInput = {
      name: String(input.name ?? '').trim(),
      description: String(input.description ?? '').trim(),
      instruction: String(input.instruction ?? '').trim(),
      triggers: input.triggers,
      enabled: input.enabled !== false,
      misfire_policy: input.misfire_policy === 'run_once' ? 'run_once' : 'skip',
    };
    if (!normalized.name) throw new Error('Task name is required');
    if (!normalized.instruction) throw new Error('Task instruction is required');
    validateTriggers(normalized.triggers);
    if (id && !this.store.getTask(id)) throw new Error(`Scheduler task not found: ${id}`);
    return this.store.saveTask(
      normalized,
      normalized.enabled ? computeNextRun(normalized.triggers) : null,
      id,
    );
  }

  setEnabled(id: string, enabled: boolean): PersonalSchedulerTask {
    const task = this.requireTask(id);
    return this.store.setTaskEnabled(id, enabled, enabled ? computeNextRun(task.triggers) : null)!;
  }

  deleteTask(id: string): boolean {
    this.requireTask(id);
    return this.store.deleteTask(id);
  }

  requireTask(id: string): PersonalSchedulerTask {
    const task = this.store.getTask(id);
    if (!task) throw new Error(`Scheduler task not found: ${id}`);
    return task;
  }

  dueTasks(now = new Date()): PersonalSchedulerTask[] {
    return this.store.dueTasks(now.toISOString());
  }

  advanceTask(task: PersonalSchedulerTask, executedAt: Date): void {
    this.store.setNextRun(task.id, computeNextRun(task.triggers, executedAt), executedAt.toISOString());
  }

  createRun(taskId: string, source: SchedulerRunSource): SchedulerRun {
    this.requireTask(taskId);
    return this.store.createRun(taskId, source);
  }

  markRunning(runId: string): boolean { return this.store.markRunRunning(runId); }

  cancelRun(runId: string): ReturnType<PersonalSchedulerStore['cancelRun']> { return this.store.cancelRun(runId); }

  markFeedRead(): number { return this.store.markFeedRead(); }

  countUnreadFeed(): number { return this.store.countUnreadFeed(); }

  private runArtifactDirectory(runId: string): string {
    if (!RUN_ID_RE.test(runId)) throw new Error(`Invalid scheduler run id: ${runId}`);
    return path.join(this.artifactRoot, runId);
  }

  /** 임시 대화가 삭제되기 전에 중간 과정을 trace.jsonl로 남긴다. 실패해도 실행 결과에는 영향이 없다. */
  writeRunTrace(runId: string, entries: SchedulerTraceEntry[]): boolean {
    try {
      const directory = this.runArtifactDirectory(runId);
      mkdirSync(directory, { recursive: true });
      const body = entries.map((entry) => JSON.stringify(entry)).join('\n');
      writeFileSync(path.join(directory, 'trace.jsonl'), body ? `${body}\n` : '', 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  private traceAttachment(runId: string): SchedulerFeedAttachment[] {
    const tracePath = path.join(this.runArtifactDirectory(runId), 'trace.jsonl');
    if (!existsSync(tracePath)) return [];
    return [{
      name: 'automation-trace.jsonl',
      path: `/outputs/automations/${encodeURIComponent(runId)}/trace.jsonl`,
      mime: 'application/x-ndjson',
      size: statSync(tracePath).size,
    }];
  }

  private writeResultFile(runId: string, content: string): SchedulerFeedAttachment {
    const directory = this.runArtifactDirectory(runId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'result.md'), content, 'utf8');
    return {
      name: 'automation-result.md',
      path: `/outputs/automations/${encodeURIComponent(runId)}/result.md`,
      mime: 'text/markdown',
      size: Buffer.byteLength(content, 'utf8'),
    };
  }

  completeRun(runId: string, task: PersonalSchedulerTask, content: string, attachments: SchedulerFeedAttachment[] = []): void {
    const outcome = classifySchedulerContentOutcome(content);
    const resultAttachment = this.writeResultFile(runId, content);
    this.store.completeRun(runId, content, outcome);
    this.store.addFeedItem({
      run_id: runId,
      task_id: task.id,
      kind: 'result',
      outcome,
      title: task.name,
      message: content,
      attachments: [...attachments, resultAttachment, ...this.traceAttachment(runId)],
    });
  }

  failRun(runId: string, task: PersonalSchedulerTask, error: string): void {
    this.store.failRun(runId, error);
    let attachments: SchedulerFeedAttachment[] = [];
    try {
      const report = [
        `# ${task.name} 실행 오류`,
        '',
        `- run_id: ${runId}`,
        `- task_id: ${task.id}`,
        `- 기록 시각: ${new Date().toISOString()}`,
        '',
        '## 오류',
        '',
        '```text',
        error,
        '```',
        '',
      ].join('\n');
      attachments = [this.writeResultFile(runId, report), ...this.traceAttachment(runId)];
    } catch {
      /* 산출물 기록 실패가 오류 피드 기록을 막지 않는다 */
    }
    this.store.addFeedItem({
      run_id: runId,
      task_id: task.id,
      kind: 'error',
      title: `${task.name} 실행 오류`,
      message: error,
      attachments,
    });
  }

  /**
   * 앱 시작 직후 misfire_policy=skip으로 건너뛴 실행을 상태 알림으로 남긴다. 실행 기록(runs)은
   * 실제 실행만 담도록 만들지 않는다. 남은 예정 실행이 없으면(한 번 실행 작업) 만료로 표시한다.
   */
  recordMissedRun(task: PersonalSchedulerTask, scheduledAt: string | null, expired: boolean): SchedulerFeedItem {
    const when = scheduledAt ? ` (예정 시각 ${scheduledAt})` : '';
    return this.store.addFeedItem({
      run_id: null,
      task_id: task.id,
      kind: 'status',
      outcome: 'warning',
      status_reason: expired ? 'expired_offline' : 'skipped_offline',
      ...(scheduledAt ? { scheduled_at: scheduledAt } : {}),
      title: expired ? `${task.name} 실행 만료` : `${task.name} 실행 건너뜀`,
      message: expired
        ? `앱이 꺼져 있는 동안 예정 시각이 지나 실행하지 못했고, 이후 예정된 실행이 없습니다${when}. 필요하면 지금 실행하거나 시각을 다시 지정하세요.`
        : `앱이 꺼져 있는 동안 예정 시각이 지나 이번 실행을 건너뛰었습니다${when}. 밀린 실행을 앱 시작 시 한 번 실행하려면 놓친 실행 정책을 run_once로 바꾸세요.`,
      attachments: [],
    });
  }

  /** 이전 프로세스에서 끝나지 못한 실행을 닫고, running이던 실행은 오류 피드로 알린다. */
  recoverInterruptedRuns(): { interrupted: number; cancelled: number } {
    const reason = '앱이 종료되어 실행이 완료되지 못했습니다.';
    const { interrupted, cancelled } = this.store.closeInterruptedRuns(reason);
    for (const run of interrupted) {
      const task = this.store.getTask(run.task_id);
      const name = task?.name ?? '삭제된 자동화';
      this.store.addFeedItem({
        run_id: run.id,
        task_id: run.task_id,
        kind: 'error',
        status_reason: 'interrupted',
        title: `${name} 실행 중단`,
        message: `${reason} 시작 시각: ${run.started_at ?? '알 수 없음'}`,
        attachments: this.traceAttachment(run.id),
      });
    }
    return { interrupted: interrupted.length, cancelled };
  }

  /** 보존 기간이 지난 실행·피드 기록과, 더 이상 참조되지 않는 오래된 산출물 폴더를 정리한다. */
  pruneHistory(now = new Date()): { runs: number; feed: number; artifacts: number } {
    const cutoffMs = now.getTime() - SCHEDULER_HISTORY_RETENTION_DAYS * 86_400_000;
    const removed = this.store.pruneHistory({
      cutoffIso: new Date(cutoffMs).toISOString(),
      maxRuns: SCHEDULER_MAX_RUNS,
      maxFeedItems: SCHEDULER_MAX_FEED_ITEMS,
    });
    let artifacts = 0;
    if (existsSync(this.artifactRoot)) {
      const referenced = this.store.referencedRunIds();
      for (const name of readdirSync(this.artifactRoot)) {
        if (!RUN_ID_RE.test(name) || referenced.has(name)) continue;
        const directory = path.join(this.artifactRoot, name);
        try {
          const stat = statSync(directory);
          if (!stat.isDirectory() || stat.mtimeMs >= cutoffMs) continue;
          rmSync(directory, { recursive: true, force: true });
          artifacts += 1;
        } catch {
          /* 정리 실패는 다음 시작 때 다시 시도한다 */
        }
      }
    }
    return { ...removed, artifacts };
  }
}
