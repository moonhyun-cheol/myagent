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
  private executing = 0;
  private recovered = false;

  constructor(
    readonly service: PersonalSchedulerService,
    private readonly executor: SchedulerExecutor,
    private readonly tickMs = 15_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.running = true;
    if (!this.recovered) {
      // 이 프로세스의 첫 시작에서만: 이전 프로세스가 남긴 미완료 실행을 닫고 오래된 기록을 정리한다.
      this.recovered = true;
      try { this.service.recoverInterruptedRuns(); } catch { /* 시작을 막지 않는다 */ }
      try { this.service.pruneHistory(); } catch { /* 시작을 막지 않는다 */ }
    }
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

  isBusy(): boolean {
    return this.executing > 0;
  }

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
      const scheduledAt = task.next_run_at;
      this.service.advanceTask(task, now);
      if (startup && task.misfire_policy === 'skip') {
        // 앱이 꺼져 있던 동안 지난 실행은 건너뛰되, 흔적을 상태 알림으로 남긴다.
        const expired = this.service.getTask(task.id)?.next_run_at == null;
        try { this.service.recordMissedRun(task, scheduledAt, expired); } catch { /* 기록 실패가 스케줄을 막지 않는다 */ }
        continue;
      }
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
    // 큐에서 차례를 기다리는 동안 취소된 실행은 여기서 걸러 executor를 시작하지 않는다.
    if (!this.service.markRunning(run.id)) return;
    this.executing += 1;
    try {
      const result = await this.executor(task, run);
      this.service.completeRun(run.id, task, result.content, result.attachments);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.service.failRun(run.id, task, message);
    } finally {
      this.executing = Math.max(0, this.executing - 1);
    }
  }
}
