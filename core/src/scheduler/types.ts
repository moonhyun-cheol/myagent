export type SchedulerTriggerType = 'time' | 'sequence' | 'on_action' | 'condition' | 'manual';
export type SchedulerMisfirePolicy = 'skip' | 'run_once';
export type SchedulerRunSource = 'scheduled' | 'manual' | 'action';
export type SchedulerRunStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface SchedulerTrigger {
  type: SchedulerTriggerType;
  config: Record<string, unknown>;
}

export interface PersonalSchedulerTask {
  id: string;
  name: string;
  description: string;
  instruction: string;
  triggers: SchedulerTrigger[];
  enabled: boolean;
  next_run_at: string | null;
  misfire_policy: SchedulerMisfirePolicy;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
}

export interface SchedulerTaskInput {
  name: string;
  description?: string;
  instruction: string;
  triggers: SchedulerTrigger[];
  enabled?: boolean;
  misfire_policy?: SchedulerMisfirePolicy;
}

export interface SchedulerRun {
  id: string;
  task_id: string;
  source: SchedulerRunSource;
  status: SchedulerRunStatus;
  started_at: string | null;
  finished_at: string | null;
  result_text: string | null;
  error: string | null;
  created_at: string;
}

export interface SchedulerFeedAttachment {
  name: string;
  path?: string;
  mime?: string;
  size?: number;
}

export interface SchedulerFeedItem {
  id: string;
  run_id: string | null;
  task_id: string;
  kind: 'result' | 'error' | 'status';
  title: string;
  message: string;
  attachments: SchedulerFeedAttachment[];
  created_at: string;
  read_at: string | null;
}

export interface SchedulerExecutionResult {
  content: string;
  attachments?: SchedulerFeedAttachment[];
}

export interface SchedulerWeeklyQueueItem {
  week_key: string;
  task_id: string;
  available_at: string;
  created_at: string;
  origin_week_key?: string;
}

export interface SchedulerWeeklyQueue {
  week_key: string;
  created_at: string;
  remaining: SchedulerWeeklyQueueItem[];
}

export interface SchedulerWeeklyCompletedItem extends SchedulerWeeklyQueueItem {
  consumed_at: string;
  resolution: 'executed' | 'expired' | 'carried';
  reason: 'claimed' | 'week_changed';
}

export interface SchedulerWeeklyCompletedList {
  week_key: string;
  created_at: string;
  items: SchedulerWeeklyCompletedItem[];
}
