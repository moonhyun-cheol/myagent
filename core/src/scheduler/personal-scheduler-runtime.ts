import type { PersonalSchedulerService } from './personal-scheduler-service.js';
import type {
  PersonalSchedulerTask,
  SchedulerExecutionResult,
  SchedulerRun,
  SchedulerRunSource,
} from './types.js';

export type SchedulerExecutor = (
  task: PersonalSchedulerTask,
  run: SchedulerRun,
) => Promise<SchedulerExecutionResult>;

export class PersonalSchedulerRuntime {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly service: PersonalSchedulerService,
    private readonly executor: SchedulerExecutor,
    private readonly tickMs = 15_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.running = true;
    void this.tick(new Date(), true);
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async shutdown(): Promise<void> {
    this.stop();
    await this.queue;
  }

  isRunning(): boolean { return this.running; }

  async tick(now = new Date(), startup = false): Promise<void> {
    if (!this.running) return;
    this.service.ensureCurrentWeeklyQueue(now);
    let weeklyItem = this.service.claimReadyWeeklyItem(now);
    while (weeklyItem) {
      const task = this.service.getTask(weeklyItem.task_id);
      if (task?.enabled) {
        this.service.advanceTask(task, now);
        this.enqueue(task, 'scheduled');
      }
      weeklyItem = this.service.claimReadyWeeklyItem(now);
    }
    for (const task of this.service.dueTasks(now).filter((candidate) => !this.service.isWeeklyTask(candidate))) {
      this.service.advanceTask(task, now);
      if (startup && task.misfire_policy === 'skip') continue;
      this.enqueue(task, 'scheduled');
    }
    await this.queue;
  }

  runNow(taskId: string, source: SchedulerRunSource = 'manual'): SchedulerRun {
    if (!this.running) throw new Error('Personal scheduler runtime is not running');
    const task = this.service.requireTask(taskId);
    return this.enqueue(task, source);
  }

  emitAction(action: string): SchedulerRun[] {
    if (!this.running) throw new Error('Personal scheduler runtime is not running');
    const matches = this.service.listTasks().filter((task) => task.enabled && task.triggers.some(
      (trigger) => trigger.type === 'on_action' && trigger.config.action === action,
    ));
    return matches.map((task) => this.enqueue(task, 'action'));
  }

  private enqueue(task: PersonalSchedulerTask, source: SchedulerRunSource): SchedulerRun {
    const run = this.service.createRun(task.id, source);
    this.queue = this.queue.then(() => this.execute(task, run));
    return run;
  }

  private async execute(task: PersonalSchedulerTask, run: SchedulerRun): Promise<void> {
    if (!this.running) return;
    this.service.markRunning(run.id);
    try {
      const result = await this.executor(task, run);
      this.service.completeRun(run.id, task, result.content, result.attachments);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.service.failRun(run.id, task, message);
    }
  }
}
