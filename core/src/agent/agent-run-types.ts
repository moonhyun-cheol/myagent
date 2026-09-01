import type { ProviderStore } from '../providers/provider-store.js';
import type { SessionMessage } from '../sessions/types.js';
import type { ToolApprovalRequest } from './tool-approval.js';
import type { AgentRuntimeHooks } from './agent-hooks.js';
import type { AgentToolPack } from './agent-tool-pack.js';
import type { AgentRole } from './agent-mar-types.js';
import type { WorkspaceBehavior } from '../execution-policy.js';
import type { ProviderWireApi } from '../providers/types.js';
import type { ResponsesContinuationState } from '../sessions/types.js';

export const MAX_AGENT_STEPS = 30;
export const AGENT_STEP_TIMEOUT_MS = 600_000;

export interface CodeAgentCallbacks {
  onThought?: (text: string) => void;
  onAnswer?: (delta: string) => void;
  onCode?: (snippet: { label: string; text: string }) => void;
  /**
   * Workspace disk mutate paths (edit_file / write_file / apply_patch / delete_file).
   * Fired after a successful mutate so UI can open Preview「코드」tabs (Cursor-like).
   */
  onWorkspaceMutate?: (paths: string[]) => void;
  onStatus?: (text: string) => void;
  /** Host/UI lifecycle signal based on an executed tool, not message keywords. */
  onToolComplete?: (event: { tool: string; ok: boolean; durationMs: number }) => void;
  /** Stream UI Accept/Reject. If omitted, confirm=true is required for destructive tools. */
  onToolApproval?: (req: ToolApprovalRequest) => Promise<boolean>;
}

export interface CodeAgentOptions extends CodeAgentCallbacks {
  workspaceRoot: string;
  userMessage: string;
  systemPrompt?: string;
  history?: SessionMessage[];
  providerId: string;
  /** Resolved once from provider/model configuration before the first LLM step. */
  wireApi?: ProviderWireApi;
  /** Configuration-time native tools decision. When true, runtime fallback to TEXT is forbidden. */
  nativeToolsLocked?: boolean;
  /** One native Responses chain per agent run; MAR roles must not share this object. */
  responsesState?: ResponsesContinuationState;
  onResponsesState?: (state: ResponsesContinuationState) => void;
  responsesStateFactory?: (
    lane: string,
    providerId: string,
    modelId: string,
    mode: import('../sessions/types.js').ResponsesStateMode,
  ) => {
    state: ResponsesContinuationState;
    onUpdate: (state: ResponsesContinuationState) => void;
  };
  modelId?: string;
  /** Effective session-scoped reasoning effort. null means provider/model managed. */
  reasoningEffort?: string | null;
  providerStore: ProviderStore;
  signal?: AbortSignal;
  nasWriteConsent?: boolean;
  workspaceContext?: string;
  /** Text extracted from attachments (logs, code, docs). */
  attachmentContext?: string;
  cqrRoot: string;
  sessionId?: string;
  playwrightHeadless?: boolean;
  playwrightAllowLocalhost?: boolean;
  /** Optional extra lifecycle hooks (merged with defaults). */
  hooks?: AgentRuntimeHooks;
  /** Image attachments as data URLs — multimodal LLM + UI-target vision. */
  imageDataUrls?: string[];
  /** MAR role (ADR-005). */
  marRole?: AgentRole;
  agentId?: string;
  parentRunId?: string;
  /** When false, skip prose outcome-gate (Supervisor owns final gate). Default true. */
  applyOutcomeGate?: boolean;
  /** Force tool pack instead of message heuristic. */
  forceToolPack?: AgentToolPack;
  /** Cap steps for this role (default MAX_AGENT_STEPS). */
  maxSteps?: number;
  /** Extra system notes prepended after skill prompt. */
  extraSystemNotes?: string[];
  /** Autopilot: continuous tool loop (no mid-task 「다음 조치」 stops). */
  autopilot?: boolean;
  /** Session/UI workspace behavior (plan = read-only tools, ask = N/A on tool plane). */
  workspaceBehavior?: WorkspaceBehavior;
  /**
   * When true, skip appending mutated paths to session meta inside finish
   * (Supervisor / MAR records via appendRoleContribution).
   */
  skipSessionMetaAppend?: boolean;
}

export interface CodeAgentResult {
  content: string;
  model: string;
  steps: number;
  /** Paths mutated during this run (for MAR handoff). */
  mutatedPaths?: string[];
  /** Auto checkpoint before first mutate — UI Reject restores this. */
  checkpointId?: string | null;
  /** Diagnostics evidence for Supervisor outcome gate (MAR). */
  diagnostics?: import('./agent-outcome-gate.js').DiagnosticsEvidenceStatus;
  /** Verify witness from this run. */
  verifyWitness?: import('./agent-claim-gates.js').VerifyWitness | null;
}
