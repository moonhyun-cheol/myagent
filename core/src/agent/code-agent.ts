/** Code agent public entry — re-exports types, helpers, and run loop. */
export type {
  CodeAgentCallbacks,
  CodeAgentOptions,
  CodeAgentResult,
} from './agent-run-types.js';
export { MAX_AGENT_STEPS, AGENT_STEP_TIMEOUT_MS } from './agent-run-types.js';

export {
  isCodeAgentLlmProvider,
  prefersClientToolProtocol,
} from './agent-tool-protocol.js';

export { formatAgentPhaseStatus } from './agent-status-report.js';

export {
  isOwuiOrGatewayError,
  collectAutoCheckpointPaths,
} from './agent-run-helpers.js';

export { runCodeAgent } from './agent-run-loop.js';
export {
  runMarOrCodeAgent,
  runMultiAgent,
  isMultiAgentEnabled,
  planMarRoles,
} from './agent-mar-runtime.js';
export type {
  AgentRole,
  HandoffMessage,
  AgentRunContext,
  MarRoleResult,
  MarRunResult,
} from './agent-mar-types.js';
