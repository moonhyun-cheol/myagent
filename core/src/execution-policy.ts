import { codingPlanLockEnabled } from './providers/harness-policy.js';
import { isReasoningLevel, type ReasoningLevelWire } from './providers/reasoning-levels.js';

export type ReasoningLevel = ReasoningLevelWire;
export type AutopilotLevel = 'off' | 'auto' | 'on';
export type ApprovalLevel = 'ask' | 'delegate' | 'autopilot';
export type WorkspaceBehavior = 'agent' | 'plan' | 'ask' | 'debug';

export function isWorkspaceBehavior(value: unknown): value is WorkspaceBehavior {
  return value === 'agent' || value === 'plan' || value === 'ask' || value === 'debug';
}

export interface ExecutionPolicy {
  reasoning: ReasoningLevel;
  autopilot: AutopilotLevel;
  approval: ApprovalLevel;
  /**
   * Explicit UI mode: plan = read-only tools, ask = no tool plane, agent = mutate (default),
   * debug = agent tools + hypothesis → temporary instrumentation → reproduce → fix → cleanup loop.
   */
  workspace_behavior?: WorkspaceBehavior;
}

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
  reasoning: 'auto',
  autopilot: 'auto',
  approval: 'ask',
  workspace_behavior: 'agent',
};

export function resolveWorkspaceBehavior(
  policy: Partial<ExecutionPolicy> | null | undefined,
  fallback: WorkspaceBehavior = 'agent',
): WorkspaceBehavior {
  const b = policy?.workspace_behavior;
  return isWorkspaceBehavior(b) ? b : fallback;
}

export function normalizeExecutionPolicy(
  value: Partial<ExecutionPolicy> | null | undefined,
  fallback: ExecutionPolicy = DEFAULT_EXECUTION_POLICY,
): ExecutionPolicy {
  const reasoning = value?.reasoning;
  const autopilot = value?.autopilot;
  const approval = value?.approval;
  const workspaceBehavior = value?.workspace_behavior;
  return {
    reasoning: isReasoningLevel(reasoning) ? reasoning : fallback.reasoning,
    autopilot: autopilot === 'off' || autopilot === 'on' || autopilot === 'auto'
      ? autopilot
      : fallback.autopilot,
    approval: approval === 'delegate' || approval === 'autopilot' || approval === 'ask'
      ? approval
      : fallback.approval,
    workspace_behavior: isWorkspaceBehavior(workspaceBehavior)
      ? workspaceBehavior
      : fallback.workspace_behavior ?? 'agent',
  };
}

export function defaultExecutionPolicyFromConfig(
  config: {
    agent_reasoning?: ReasoningLevel;
    agent_autopilot?: boolean | null;
    approval_delegation?: 'off' | 'safe_local' | 'auto_review';
    agent_default_workspace_behavior?: WorkspaceBehavior;
  },
  env: NodeJS.ProcessEnv = process.env,
): ExecutionPolicy {
  // Product default is always Agent. Plan/Ask are opt-in (UI or MY_AGENT_CODE_PLAN_LOCK / config override).
  const defaultBehavior: WorkspaceBehavior = codingPlanLockEnabled(env)
    ? 'plan'
    : (isWorkspaceBehavior(config.agent_default_workspace_behavior)
      ? config.agent_default_workspace_behavior
      : 'agent');
  return normalizeExecutionPolicy({
    reasoning: config.agent_reasoning ?? 'auto',
    autopilot: config.agent_autopilot === true ? 'on' : config.agent_autopilot === false ? 'off' : 'auto',
    approval: config.approval_delegation === 'safe_local'
      ? 'autopilot'
      : config.approval_delegation === 'auto_review' ? 'delegate' : 'ask',
    workspace_behavior: defaultBehavior,
  });
}
