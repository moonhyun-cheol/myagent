import { listActiveTerminalJobIds } from '../agent/run-terminal.js';
import { countPendingToolApprovals } from '../agent/tool-approval.js';
import type { ILicenseGate } from '../license/types.js';
import type { PersonalSchedulerRuntime } from '../scheduler/personal-scheduler-runtime.js';
import type { PersonalSchedulerService } from '../scheduler/personal-scheduler-service.js';
import { isAutomatonBackgroundBusy } from './automaton-background-registry.js';
import { isAgentWorkBusy, listActiveWork } from './active-work-registry.js';
import { isMutateReviewPending } from './ui-busy-state.js';

export interface UpdateGateResult {
  ready: boolean;
  reasons: string[];
  active_work?: ReturnType<typeof listActiveWork>;
}

export function evaluateUpdateGate(input: {
  license: ILicenseGate;
  personalScheduler: PersonalSchedulerService;
  personalSchedulerRuntime: PersonalSchedulerRuntime;
}): UpdateGateResult {
  const reasons: string[] = [];

  if (input.license.getStatus().mode !== 'full') {
    reasons.push('read_only_license');
  }
  if (isAgentWorkBusy()) {
    reasons.push('agent_busy');
  }
  if (input.personalSchedulerRuntime.isBusy() || input.personalScheduler.countActiveRuns() > 0) {
    reasons.push('scheduler_busy');
  }
  if (countPendingToolApprovals() > 0) {
    reasons.push('tool_approval_pending');
  }
  if (listActiveTerminalJobIds().length > 0) {
    reasons.push('terminal_job_running');
  }
  if (isMutateReviewPending()) {
    reasons.push('mutate_review_pending');
  }
  if (isAutomatonBackgroundBusy()) {
    reasons.push('automaton_background');
  }

  const unique = [...new Set(reasons)];
  return {
    ready: unique.length === 0,
    reasons: unique,
    active_work: isAgentWorkBusy() ? listActiveWork() : undefined,
  };
}
