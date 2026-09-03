import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type {
  PersonalSchedulerTask,
  SchedulerFeedItem,
  SchedulerRun,
  SchedulerRunSource,
  SchedulerTaskInput,
  SchedulerWeeklyCompletedList,
  SchedulerWeeklyQueue,
  SchedulerWeeklyQueueItem,
} from './types.js';
import { migrateSchedulerSqliteToJson } from './migrate-sqlite-to-json.js';

interface RunsDocument { schema_version: 1; updated_at: string; runs: SchedulerRun[] }
interface FeedDocument { schema_version: 1; updated_at: string; items: SchedulerFeedItem[] }
interface QueueDocument { schema_version: 1; updated_at: string; weeks: Record<string, SchedulerWeeklyQueue> }
interface CompletedDocument { schema_version: 1; updated_at: string; weeks: Record<string, SchedulerWeeklyCompletedList> }

function clone<T>(value: T): T {
  return structuredClone(value);
}

function timestamp(): string {
  return new Date().toISOString();
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(tempPath, filePath);
  } catch (error) {
    if (existsSync(tempPath)) unlinkSync(tempPath);
    throw error;
  }
}

function readJson<T>(filePath: string, fallback: T, validate: (value: unknown) => value is T): T {
  if (!existsSync(filePath)) {
    writeJsonAtomic(filePath, fallback);
    return fallback;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Personal scheduler JSON is unreadable: ${filePath}`, { cause: error });
  }
  if (!validate(parsed)) throw new Error(`Personal scheduler JSON has an unsupported shape: ${filePath}`);
  return parsed;
}

function hasBase(value: unknown): value is { schema_version: 1; updated_at: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const base = value as { schema_version?: unknown; updated_at?: unknown };
  return base.schema_version === 1 && typeof base.updated_at === 'string';
}

function isTask(value: unknown): value is PersonalSchedulerTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const task = value as Partial<PersonalSchedulerTask>;
  return typeof task.id === 'string'
    && typeof task.name === 'string'
    && typeof task.instruction === 'string'
    && Array.isArray(task.triggers)
    && typeof task.enabled === 'boolean';
}

function isRuns(value: unknown): value is RunsDocument {
  return hasBase(value) && Array.isArray((value as RunsDocument).runs);
}

function isFeed(value: unknown): value is FeedDocument {
  return hasBase(value) && Array.isArray((value as FeedDocument).items);
}

function isQueues(value: unknown): value is QueueDocument {
  return hasBase(value) && Boolean((value as QueueDocument).weeks)
    && typeof (value as QueueDocument).weeks === 'object'
    && !Array.isArray((value as QueueDocument).weeks);
}

function isCompleted(value: unknown): value is CompletedDocument {
  return hasBase(value) && Boolean((value as CompletedDocument).weeks)
    && typeof (value as CompletedDocument).weeks === 'object'
    && !Array.isArray((value as CompletedDocument).weeks);
}

export class PersonalSchedulerStore {
  private readonly tasksDirectory: string;
  private readonly runsPath: string;
  private readonly feedPath: string;
  private readonly queuePath: string;
  private readonly completedPath: string;
  private readonly tasks = new Map<string, PersonalSchedulerTask>();
  private runs: RunsDocument;
  private feed: FeedDocument;
  private queues: QueueDocument;
  private completed: CompletedDocument;

  constructor(private readonly schedulerRoot: string) {
    migrateSchedulerSqliteToJson(schedulerRoot);
    this.tasksDirectory = path.join(schedulerRoot, 'tasks');
    this.runsPath = path.join(schedulerRoot, 'runs.json');
    this.feedPath = path.join(schedulerRoot, 'feed.json');
    this.queuePath = path.join(schedulerRoot, 'weekly-queue.json');
    this.completedPath = path.join(schedulerRoot, 'weekly-completed.json');
    mkdirSync(this.tasksDirectory, { recursive: true });
    this.loadTasks();
    const now = timestamp();
    this.runs = readJson(this.runsPath, { schema_version: 1, updated_at: now, runs: [] }, isRuns);
    this.feed = readJson(this.feedPath, { schema_version: 1, updated_at: now, items: [] }, isFeed);
    this.queues = readJson(this.queuePath, { schema_version: 1, updated_at: now, weeks: {} }, isQueues);
    this.completed = readJson(this.completedPath, { schema_version: 1, updated_at: now, weeks: {} }, isCompleted);
    this.reconcileConsumedWeeklyItems();
  }

  close(): void {}

  private loadTasks(): void {
    for (const name of readdirSync(this.tasksDirectory).filter((entry) => entry.endsWith('.json'))) {
      const filePath = path.join(this.tasksDirectory, name);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      } catch (error) {
        throw new Error(`Personal scheduler task JSON is unreadable: ${filePath}`, { cause: error });
      }
      if (!isTask(parsed) || name !== `${parsed.id}.json`) {
        throw new Error(`Personal scheduler task JSON has an unsupported shape: ${filePath}`);
      }
      this.tasks.set(parsed.id, parsed);
    }
  }

  private taskPath(id: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error(`Invalid scheduler task id: ${id}`);
    return path.join(this.tasksDirectory, `${id}.json`);
  }

  private saveTaskFile(task: PersonalSchedulerTask): void {
    writeJsonAtomic(this.taskPath(task.id), task);
  }

  private saveRuns(): void {
    this.runs.updated_at = timestamp();
    writeJsonAtomic(this.runsPath, this.runs);
  }

  private saveFeed(): void {
    this.feed.updated_at = timestamp();
    writeJsonAtomic(this.feedPath, this.feed);
  }

  private saveQueues(): void {
    this.queues.updated_at = timestamp();
    writeJsonAtomic(this.queuePath, this.queues);
  }

  private saveCompleted(): void {
    this.completed.updated_at = timestamp();
    writeJsonAtomic(this.completedPath, this.completed);
  }

  private reconcileConsumedWeeklyItems(): void {
    let changed = false;
    for (const [weekKey, completedList] of Object.entries(this.completed.weeks)) {
      const queue = this.queues.weeks[weekKey];
      if (!queue || completedList.items.length === 0) continue;
      const consumedTaskIds = new Set(completedList.items.map((item) => item.task_id));
      const remaining = queue.remaining.filter((item) => !consumedTaskIds.has(item.task_id));
      if (remaining.length !== queue.remaining.length) {
        queue.remaining = remaining;
        changed = true;
      }
    }
    if (changed) this.saveQueues();
  }

  listTasks(): PersonalSchedulerTask[] {
    return clone([...this.tasks.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at)));
  }

  getTask(id: string): PersonalSchedulerTask | null {
    const task = this.tasks.get(id);
    return task ? clone(task) : null;
  }

  saveTask(input: SchedulerTaskInput, nextRunAt: string | null, id?: string): PersonalSchedulerTask {
    const now = timestamp();
    const taskId = id || randomUUID();
    const existing = this.tasks.get(taskId);
    const task: PersonalSchedulerTask = {
      id: taskId,
      name: input.name,
      description: input.description ?? '',
      instruction: input.instruction,
      triggers: clone(input.triggers),
      enabled: input.enabled !== false,
      next_run_at: nextRunAt,
      misfire_policy: input.misfire_policy ?? 'skip',
      created_at: existing?.created_at ?? now,
      updated_at: now,
      last_run_at: existing?.last_run_at ?? null,
    };
    this.saveTaskFile(task);
    this.tasks.set(task.id, task);
    return clone(task);
  }

  setTaskEnabled(id: string, enabled: boolean, nextRunAt: string | null): PersonalSchedulerTask | null {
    const task = this.tasks.get(id);
    if (!task) return null;
    task.enabled = enabled;
    task.next_run_at = enabled ? nextRunAt : null;
    task.updated_at = timestamp();
    this.saveTaskFile(task);
    return clone(task);
  }

  setNextRun(id: string, nextRunAt: string | null, lastRunAt?: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.next_run_at = nextRunAt;
    if (lastRunAt !== undefined) task.last_run_at = lastRunAt;
    task.updated_at = timestamp();
    this.saveTaskFile(task);
  }

  deleteTask(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    const filePath = this.taskPath(id);
    if (existsSync(filePath)) unlinkSync(filePath);
    this.tasks.delete(id);
    let queuesChanged = false;
    for (const queue of Object.values(this.queues.weeks)) {
      const remaining = queue.remaining.filter((item) => item.task_id !== id);
      if (remaining.length !== queue.remaining.length) {
        queue.remaining = remaining;
        queuesChanged = true;
      }
    }
    if (queuesChanged) this.saveQueues();
    return true;
  }

  dueTasks(nowIso: string): PersonalSchedulerTask[] {
    return clone([...this.tasks.values()]
      .filter((task) => task.enabled && task.next_run_at !== null && task.next_run_at <= nowIso)
      .sort((a, b) => String(a.next_run_at).localeCompare(String(b.next_run_at))));
  }

  createRun(taskId: string, source: SchedulerRunSource): SchedulerRun {
    const run: SchedulerRun = {
      id: randomUUID(), task_id: taskId, source, status: 'queued',
      started_at: null, finished_at: null, result_text: null, error: null, created_at: timestamp(),
    };
    this.runs.runs.push(run);
    this.saveRuns();
    return clone(run);
  }

  getRun(id: string): SchedulerRun | null {
    const run = this.runs.runs.find((candidate) => candidate.id === id);
    return run ? clone(run) : null;
  }

  listRuns(limit = 50): SchedulerRun[] {
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    return clone([...this.runs.runs].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, safeLimit));
  }

  countActiveRuns(): number {
    return this.runs.runs.filter((run) => run.status === 'queued' || run.status === 'running').length;
  }

  markRunRunning(id: string): void {
    const run = this.runs.runs.find((candidate) => candidate.id === id);
    if (!run) return;
    run.status = 'running';
    run.started_at = timestamp();
    this.saveRuns();
  }

  completeRun(id: string, resultText: string): void {
    const run = this.runs.runs.find((candidate) => candidate.id === id);
    if (!run) return;
    run.status = 'succeeded';
    run.result_text = resultText;
    run.error = null;
    run.finished_at = timestamp();
    this.saveRuns();
  }

  failRun(id: string, error: string): void {
    const run = this.runs.runs.find((candidate) => candidate.id === id);
    if (!run) return;
    run.status = 'failed';
    run.error = error;
    run.finished_at = timestamp();
    this.saveRuns();
  }

  addFeedItem(input: Omit<SchedulerFeedItem, 'id' | 'created_at' | 'read_at'>): SchedulerFeedItem {
    const item: SchedulerFeedItem = { ...clone(input), id: randomUUID(), created_at: timestamp(), read_at: null };
    this.feed.items.push(item);
    this.saveFeed();
    return clone(item);
  }

  listFeed(limit = 50): SchedulerFeedItem[] {
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    return clone([...this.feed.items].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, safeLimit));
  }

  ensureWeeklyQueue(weekKey: string, items: Array<{ taskId: string; availableAt: string }>): boolean {
    if (this.queues.weeks[weekKey] || this.completed.weeks[weekKey]) return false;
    const createdAt = timestamp();
    this.queues.weeks[weekKey] = {
      week_key: weekKey,
      created_at: createdAt,
      remaining: items.map((item): SchedulerWeeklyQueueItem => ({
        week_key: weekKey, task_id: item.taskId, available_at: item.availableAt, created_at: createdAt,
      })),
    };
    this.saveQueues();
    return true;
  }

  rolloverWeeklyQueues(currentWeekKey: string, tasks: PersonalSchedulerTask[], nowIso: string): void {
    const currentQueue = this.queues.weeks[currentWeekKey];
    if (!currentQueue) return;
    const tasksById = new Map(tasks.map((task) => [task.id, task]));
    const completedCurrent = new Set(
      (this.completed.weeks[currentWeekKey]?.items ?? []).map((item) => item.task_id),
    );
    let queuesChanged = false;
    let completedChanged = false;

    for (const [weekKey, queue] of Object.entries(this.queues.weeks)) {
      if (weekKey >= currentWeekKey || queue.remaining.length === 0) continue;
      const completedList = this.completed.weeks[weekKey] ?? {
        week_key: weekKey,
        created_at: nowIso,
        items: [],
      };
      const alreadyResolved = new Set(completedList.items.map((item) => item.task_id));

      for (const item of queue.remaining) {
        if (alreadyResolved.has(item.task_id)) continue;
        const task = tasksById.get(item.task_id);
        const carry = task?.enabled === true && task.misfire_policy === 'run_once';
        if (carry && !completedCurrent.has(item.task_id)) {
          const currentItem = currentQueue.remaining.find((candidate) => candidate.task_id === item.task_id);
          if (currentItem) {
            currentItem.available_at = nowIso;
            currentItem.origin_week_key = item.origin_week_key ?? item.week_key;
          } else {
            currentQueue.remaining.push({
              ...item,
              week_key: currentWeekKey,
              available_at: nowIso,
              created_at: nowIso,
              origin_week_key: item.origin_week_key ?? item.week_key,
            });
          }
        }
        completedList.items.push({
          ...item,
          consumed_at: nowIso,
          resolution: carry ? 'carried' : 'expired',
          reason: 'week_changed',
        });
        alreadyResolved.add(item.task_id);
        completedChanged = true;
      }
      queue.remaining = [];
      this.completed.weeks[weekKey] = completedList;
      queuesChanged = true;
    }

    if (queuesChanged) this.saveQueues();
    if (completedChanged) this.saveCompleted();
  }

  getWeeklyQueue(weekKey: string): SchedulerWeeklyQueue | null {
    const queue = this.queues.weeks[weekKey];
    if (!queue) return null;
    const result = clone(queue);
    result.remaining.sort((a, b) => a.available_at.localeCompare(b.available_at) || a.task_id.localeCompare(b.task_id));
    return result;
  }

  getCompletedWeeklyQueue(weekKey: string): SchedulerWeeklyCompletedList | null {
    const completed = this.completed.weeks[weekKey];
    return completed ? clone(completed) : null;
  }

  claimReadyWeeklyItem(weekKey: string, nowIso: string): SchedulerWeeklyQueueItem | null {
    const queue = this.queues.weeks[weekKey];
    if (!queue) return null;
    const match = queue.remaining
      .map((item, originalIndex) => ({ item, originalIndex }))
      .filter(({ item }) => item.available_at <= nowIso)
      .sort((a, b) => a.item.available_at.localeCompare(b.item.available_at) || a.item.task_id.localeCompare(b.item.task_id))[0];
    if (!match) return null;

    const completedList = this.completed.weeks[weekKey] ?? {
      week_key: weekKey,
      created_at: timestamp(),
      items: [],
    };
    completedList.items.push({
      ...match.item,
      consumed_at: timestamp(),
      resolution: 'executed',
      reason: 'claimed',
    });
    this.completed.weeks[weekKey] = completedList;
    this.saveCompleted();

    queue.remaining.splice(match.originalIndex, 1);
    this.saveQueues();
    return clone(match.item);
  }
}
