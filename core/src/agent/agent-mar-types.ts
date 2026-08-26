/**
 * Internal Multi-Agent Runtime (MAR) contracts — ADR-005.
 * External frameworks (LangGraph/CrewAI/AutoGen) are out of scope.
 */

export type AgentRole =
  | 'supervisor'
  | 'planner'
  | 'coder'
  | 'browser'
  | 'researcher'
  | 'reviewer'
  | 'automaton';

export interface HandoffMessage {
  fromRole: AgentRole;
  toRole: AgentRole;
  /** Compact task brief for the next role (not full chat history). */
  task: string;
  /** Paths mutated so far (session-relative). */
  mutatedPaths: string[];
  /** Evidence / notes the next role must honor. */
  evidence?: string;
  /** Optional locked P0 constraints text. */
  constraintsNote?: string;
}

export interface AgentRunContext {
  parentRunId: string;
  agentId: string;
  role: AgentRole;
  sessionId?: string;
  /** True when this role may emit the user-facing final reply / outcome gate. */
  ownsFinalReply: boolean;
}

export interface MarRoleResult {
  role: AgentRole;
  agentId: string;
  content: string;
  model: string;
  steps: number;
  mutatedPaths: string[];
  ok: boolean;
  detail?: string;
  /** Bubbled from coder run for Supervisor outcome gate. */
  diagnostics?: import('./agent-outcome-gate.js').DiagnosticsEvidenceStatus;
  verifyWitness?: import('./agent-claim-gates.js').VerifyWitness | null;
}

export interface MarRunResult {
  content: string;
  model: string;
  steps: number;
  parentRunId: string;
  roles: AgentRole[];
  roleResults: MarRoleResult[];
}

/**
 * Env: MAR on by default. Set MY_AGENT_MULTI_AGENT=0|false|off|no to use single runCodeAgent.
 */
export function isMultiAgentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.MY_AGENT_MULTI_AGENT ?? '1').trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no';
}

/**
 * Env: mandatory Critic after mutate — default on.
 * Set MY_AGENT_MANDATORY_CRITIC=0|false|off|no to skip auto-appending reviewer.
 */
export function isMandatoryCriticEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.MY_AGENT_MANDATORY_CRITIC ?? '1').trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no';
}

/**
 * Env: MAR light — skip mandatory Critic on simple single-coder mutates (default on).
 * Multi-file / agentic dual / browser mutate chains still get Critic when mandatory is on.
 * Set MY_AGENT_MAR_LIGHT=0|false|off|no to always attach Critic when mandatory is on.
 */
export function isMarLightEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.MY_AGENT_MAR_LIGHT ?? '1').trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no';
}
