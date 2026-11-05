import {
  STEP_BUDGET_EXTENSION,
  decideStepBudgetGrant,
  formatElapsedMinutes,
  formatStepBudgetExtensionNote,
  formatStepBudgetTimeNote,
  reviewStepBudget,
  type StepBudgetExhaustedHandler,
} from '../agent/step-budget-review.js';
import type { ToolApprovalOutcome, ToolApprovalRequest } from '../agent/tool-approval.js';
import type { ProviderStore } from '../providers/provider-store.js';

/** Decision trail for trace.jsonl: who decided what during an unattended run. */
export interface SchedulerDecisionRecord {
  at: string;
  kind: 'tool_approval' | 'step_budget';
  tool?: string;
  summary: string;
  decision: 'allow' | 'deny' | 'extend' | 'stop';
  reviewer: string;
  reason: string;
}

export interface SchedulerDecisionHooks {
  onToolApproval: (req: ToolApprovalRequest) => Promise<ToolApprovalOutcome>;
  onStepBudgetExhausted: StepBudgetExhaustedHandler;
  decisions: SchedulerDecisionRecord[];
}

/**
 * Scheduled runs have nobody watching an approval card, and the user only schedules
 * simple, self-authored tasks. Approval-gated tool calls therefore run as a free pass:
 * no decision-model review, no card (user decision). Hard safety blocks enforced by the
 * tools themselves (terminal `blocked` tier, force push, secret guard) still apply.
 * Step-budget checkpoints are still decided by the decision model.
 */
export function createSchedulerDecisionHooks(input: {
  providerStore: ProviderStore;
  cqrRoot: string;
  sessionId: string;
  /** User-authored scheduled instruction (kept for trace / future use). */
  instruction: string;
  /** Settings 「판단 모델」 preference (`provider:{id}@{model}`). Empty = product default. */
  reviewerPreference?: string;
  signal?: AbortSignal;
  reviewBudget?: typeof reviewStepBudget;
}): SchedulerDecisionHooks {
  const reviewBudget = input.reviewBudget ?? reviewStepBudget;
  const decisions: SchedulerDecisionRecord[] = [];
  const note = (row: Omit<SchedulerDecisionRecord, 'at'>) => {
    if (decisions.length < 200) decisions.push({ at: new Date().toISOString(), ...row });
  };

  const onToolApproval = async (req: ToolApprovalRequest): Promise<ToolApprovalOutcome> => {
    note({
      kind: 'tool_approval',
      tool: req.tool,
      summary: req.summary,
      decision: 'allow',
      reviewer: 'scheduler-free-pass',
      reason: '예약 실행은 승인 검토 없이 바로 실행합니다',
    });
    return { approved: true, by: 'policy', reviewer: 'scheduler-free-pass' };
  };

  const onStepBudgetExhausted: StepBudgetExhaustedHandler = async ({ facts, workingModelId, autoGrantsUsed }) => {
    const elapsedMs = facts.elapsedMs ?? 0;
    const byTime = facts.trigger === 'time';
    const budgetReview = await reviewBudget({
      providerStore: input.providerStore,
      cqrRoot: input.cqrRoot,
      sessionId: input.sessionId,
      workingModelId,
      facts,
      signal: input.signal,
    });
    const grant = decideStepBudgetGrant({
      review: budgetReview,
      approvalPolicy: 'delegate',
      autoGrantsUsed,
      elapsedMs,
      trigger: facts.trigger,
    });
    const summary = byTime
      ? `작업 ${formatElapsedMinutes(elapsedMs)} 경과 · ${facts.stepsUsed} 스텝`
      : `실행 예산 ${facts.stepLimit} 스텝 도달 · ${formatElapsedMinutes(elapsedMs)} 경과`;
    if (grant === 'auto') {
      note({ kind: 'step_budget', summary, decision: 'extend', reviewer: budgetReview.reviewer, reason: budgetReview.reason });
      return {
        extend: STEP_BUDGET_EXTENSION,
        auto: true,
        note: byTime
          ? formatStepBudgetTimeNote(budgetReview, elapsedMs, 'auto')
          : formatStepBudgetExtensionNote(budgetReview, STEP_BUDGET_EXTENSION, 'auto'),
      };
    }
    // 'ask' has no human in a scheduled run: stop with the reviewer's reason.
    const why = grant === 'stop'
      ? `검토 모델(${budgetReview.reviewer}) 판단: 멈춤 — ${budgetReview.reason}`
      : `예약 실행 자동 연장 한도 도달 또는 검토 모델 판단 불가 — ${budgetReview.reason}`;
    note({ kind: 'step_budget', summary, decision: 'stop', reviewer: budgetReview.reviewer, reason: why });
    return { extend: 0, stopReason: `${why} (${formatElapsedMinutes(elapsedMs)} 경과)` };
  };

  return { onToolApproval, onStepBudgetExhausted, decisions };
}
