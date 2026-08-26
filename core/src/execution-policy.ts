export type ReasoningLevel = 'auto' | 'low' | 'medium' | 'high';
export type AutopilotLevel = 'off' | 'auto' | 'on';
export type ApprovalLevel = 'ask' | 'delegate' | 'autopilot';

export interface ExecutionPolicy {
  reasoning: ReasoningLevel;
  autopilot: AutopilotLevel;
  approval: ApprovalLevel;
}

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
  reasoning: 'auto',
  autopilot: 'auto',
  approval: 'ask',
};

export function normalizeExecutionPolicy(
  value: Partial<ExecutionPolicy> | null | undefined,
  fallback: ExecutionPolicy = DEFAULT_EXECUTION_POLICY,
): ExecutionPolicy {
  const reasoning = value?.reasoning;
  const autopilot = value?.autopilot;
  const approval = value?.approval;
  return {
    reasoning: reasoning === 'low' || reasoning === 'medium' || reasoning === 'high' || reasoning === 'auto'
      ? reasoning
      : fallback.reasoning,
    autopilot: autopilot === 'off' || autopilot === 'on' || autopilot === 'auto'
      ? autopilot
      : fallback.autopilot,
    approval: approval === 'delegate' || approval === 'autopilot' || approval === 'ask'
      ? approval
      : fallback.approval,
  };
}

export function defaultExecutionPolicyFromConfig(config: {
  agent_reasoning?: ReasoningLevel;
  agent_autopilot?: boolean | null;
  approval_delegation?: 'off' | 'safe_local' | 'auto_review';
}): ExecutionPolicy {
  return normalizeExecutionPolicy({
    reasoning: config.agent_reasoning ?? 'auto',
    autopilot: config.agent_autopilot === true ? 'on' : config.agent_autopilot === false ? 'off' : 'auto',
    approval: config.approval_delegation === 'safe_local'
      ? 'autopilot'
      : config.approval_delegation === 'auto_review' ? 'delegate' : 'ask',
  });
}
