import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PersonalSchedulerStore } from './personal-scheduler-store.js';
import type {
  PersonalSchedulerTask,
  SchedulerFeedAttachment,
  SchedulerFeedItem,
  SchedulerRun,
  SchedulerRunSource,
  SchedulerTaskInput,
  SchedulerTrigger,
  SchedulerWeeklyQueue,
  SchedulerWeeklyQueueItem,
} from './types.js';

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
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
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

  constructor(dbPath: string, artifactRoot = path.join(path.dirname(path.dirname(dbPath)), 'outputs', 'automations')) {
    this.store = new PersonalSchedulerStore(dbPath);
    this.artifactRoot = artifactRoot;
  }

  static forRoot(cqrRoot: string): PersonalSchedulerService {
    return new PersonalSchedulerService(
      path.join(cqrRoot, 'data', 'scheduler', 'personal-scheduler.sqlite'),
      path.join(cqrRoot, 'data', 'outputs', 'automations'),
    );
  }

  close(): void { this.store.close(); }
  listTasks(): PersonalSchedulerTask[] { return this.store.listTasks(); }
  getTask(id: string): PersonalSchedulerTask | null { return this.store.getTask(id); }
  listRuns(limit?: number): SchedulerRun[] { return this.store.listRuns(limit); }
  listFeed(limit?: number): SchedulerFeedItem[] { return this.store.listFeed(limit); }

  isWeeklyTask(task: PersonalSchedulerTask): boolean {
    return weeklyOccurrence(task, new Date()) !== null;
  }

  ensureCurrentWeeklyQueue(now = new Date()): SchedulerWeeklyQueue {
    const weekKey = isoWeekKey(now);
    const items = this.listTasks()
      .filter((task) => task.enabled)
      .map((task) => ({ task, availableAt: weeklyOccurrence(task, now) }))
      .filter((row): row is { task: PersonalSchedulerTask; availableAt: string } => Boolean(row.availableAt))
      .map((row) => ({ taskId: row.task.id, availableAt: row.availableAt }));
    this.store.ensureWeeklyQueue(weekKey, items);
    return this.store.getWeeklyQueue(weekKey)!;
  }

  getWeeklyQueue(weekKey = isoWeekKey(new Date())): SchedulerWeeklyQueue | null {
    return this.store.getWeeklyQueue(weekKey);
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

  markRunning(runId: string): void { this.store.markRunRunning(runId); }

  completeRun(runId: string, task: PersonalSchedulerTask, content: string, attachments: SchedulerFeedAttachment[] = []): void {
    const runArtifactDirectory = path.join(this.artifactRoot, runId);
    mkdirSync(runArtifactDirectory, { recursive: true });
    const resultFile = path.join(runArtifactDirectory, 'result.md');
    writeFileSync(resultFile, content, 'utf8');
    const resultAttachment: SchedulerFeedAttachment = {
      name: 'automation-result.md',
      path: `/outputs/automations/${encodeURIComponent(runId)}/result.md`,
      mime: 'text/markdown',
      size: Buffer.byteLength(content, 'utf8'),
    };
    this.store.completeRun(runId, content);
    this.store.addFeedItem({
      run_id: runId,
      task_id: task.id,
      kind: 'result',
      title: task.name,
      message: content,
      attachments: [...attachments, resultAttachment],
    });
  }

  failRun(runId: string, task: PersonalSchedulerTask, error: string): void {
    this.store.failRun(runId, error);
    this.store.addFeedItem({
      run_id: runId,
      task_id: task.id,
      kind: 'error',
      title: `${task.name} 실행 오류`,
      message: error,
      attachments: [],
    });
  }
}
