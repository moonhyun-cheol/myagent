import type { UserOverrides } from '../config/user-overrides.js';
import { DEFAULT_SCHEDULER_MODEL } from '../config/user-overrides.js';
import type { ExecutionPolicy } from '../execution-policy.js';

export interface SchedulerExecutionConfig {
  model: string;
  executionPolicy: ExecutionPolicy;
}

export function resolveSchedulerExecutionConfig(overrides: UserOverrides): SchedulerExecutionConfig {
  return {
    model: overrides.scheduler_default_model?.trim() || DEFAULT_SCHEDULER_MODEL,
    executionPolicy: {
      reasoning: 'none',
      autopilot: 'off',
      approval: 'ask',
    },
  };
}
