/**
 * Gate / claim surface barrel — prefer importing from here for new code.
 * See tools/lab/AGENT_MODULE_FREEZE.md (ADR note: no new top-level agent-*.ts without reason).
 */
export {
  parseCriticNext,
  openGateBlocksDoneClaim,
  openGateLikelyAddressed,
  buildOpenGateFromCriticNext,
  formatOpenGateSystemNote,
  formatOpenGateNudge,
  formatOpenGateRewrite,
  normalizeSessionOpenGate,
  isWorkspaceUiBuildOpenGate,
  shouldSuppressWorkspaceUiBuildGate,
  isNoneGateText,
} from './agent-open-gate.js';
export type {
  SessionOpenGate,
  OpenGateStatus,
  OpenGateSource,
  OpenGateEvidenceKind,
} from './agent-open-gate.js';

export {
  hasStrongVerifyEvidence,
  hasUsableVerifyWitness,
} from './agent-claim-gates.js';
export type { VerifyWitness } from './agent-claim-gates.js';

export {
  extractPathsFromUserMessage,
} from './agent-outcome-gate.js';
