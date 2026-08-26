/**
 * Mutable bag passed from prepare (agent-run-loop) into the step loop.
 */
import type { ChatMessage } from '../providers/openai-compatible.js';
import type { AgentToolContext, AgentToolDefinition } from './tools.js';
import type { AgentToolProtocol } from './agent-llm-step.js';
import type { UiFacts } from './agent-grounding.js';
import type { DiagnosticsEvidenceStatus } from './agent-outcome-gate.js';
import type { CodeAgentOptions, CodeAgentResult } from './agent-run-types.js';
import type { WorkspaceReadGate } from './tool-read-gate.js';
import type { PlaywrightSession } from '../browser/playwright-session.js';
import type { AgentRuntimeHooks } from './agent-hooks.js';
import type { LockedConstraints } from './agent-locked-constraints.js';

export interface AgentRunStepState {
  opts: CodeAgentOptions;
  guard: { allowNas?: boolean };
  steps: number;
  thoughtBuf: string;
  answerBuf: string;
  thoughtLog: string[];
  messages: ChatMessage[];
  toolProtocol: AgentToolProtocol;
  /** Native tools were confirmed/configured before execution; never demote in-run. */
  nativeToolsLocked: boolean;
  stickyClientReason: string | null | undefined;
  preferApiForIdeEdit: boolean;
  def: { name: string; custom?: boolean };
  baseUrl: string;
  secret: { api_key: string };
  modelId: string;
  protocolCacheKey: string;
  toolNames: string[];
  agentTools: AgentToolDefinition[];
  /** Pack used to build agentTools — refresh plugins mid-run after install. */
  toolPack: import('./agent-tool-pack.js').AgentToolPack;
  /** Effective continuous-run flag (CODE/UI/GATE autopilot). */
  autopilot: boolean;
  /** Cap for this run (from opts.maxSteps ?? MAX_AGENT_STEPS). */
  maxSteps: number;
  /** When false, skip prose outcome-gate (MAR intermediate roles). */
  applyOutcomeGate: boolean;
  selfWorkspace: boolean;
  uiFacts: UiFacts | null;
  reportStatus: (text: string) => void;
  pushThought: (line: string) => void;
  publishThoughtPanel: () => void;
  finish: (result: CodeAgentResult) => Promise<CodeAgentResult>;
  /**
   * Flush mutated/read paths into session meta mid-run so infra interrupt
   * still leaves accurate continuity seeds (does not set openGate).
   */
  persistLiveSessionMeta: () => void;
  hooks: AgentRuntimeHooks;
  lastModel: string;
  lockedConstraints: LockedConstraints | null;
  mutatedPathsThisRun: Set<string>;
  /** Epoch ms when this agent run started (for first_tool_ms). */
  runStartedAt: number;
  /**
   * Wall ms until first tool call booked; set once by noteFirstTool.
   * undefined until first tool.
   */
  firstToolMs?: number;
  llmRoundTrips: number;
  toolCallCount: number;
  llmCompletionMs: number;
  llmTrace: NonNullable<import('./agent-perf-metrics.js').AgentPerfSnapshot['llm_trace']>;
  toolTrace: NonNullable<import('./agent-perf-metrics.js').AgentPerfSnapshot['tool_trace']>;
  approvalWaitMs: number;
  approvalTrace: NonNullable<import('./agent-perf-metrics.js').AgentPerfSnapshot['approval_trace']>;
  /** External read roots approved by the user for this run only. Never persisted. */
  approvedExternalReadRoots: Set<string>;
  llmUsage: NonNullable<import('./agent-perf-metrics.js').AgentPerfSnapshot['usage']>;
  browserSession: PlaywrightSession | null;
  toolCtx: AgentToolContext;
  readGate: WorkspaceReadGate;
  autoCheckpointTaken: boolean;
  silentVerifyAttempts: number;
  verifyExhaustedNotified: boolean;
  maxVerify: number;
  selfCorrectionStreak: number;
  writeFailStreak: number;
  mutatedOkRun: boolean;
  planDeferRetries: number;
  /**
   * Autopilot force-TOOL_CALL rounds after at least one successful mutate.
   * Cap prevents post-mutate empty-spin when checklist incomplete or freeform.
   */
  autopilotEmptyAfterMutate: number;
  /** After inspect tools + empty Korean answer: force one mutate/TOOL_CALL continue. */
  inspectAnswerSynthRetries: number;
  ideEditNudgeCount: number;
  targetMissNudgeCount: number;
  evidenceDiagOk: DiagnosticsEvidenceStatus;
  ranVerifyCommand: boolean;
  /** High-level retrieval returned 0 hits — block finish until min-depth tool. */
  emptyRetrievalPending: boolean;
  /** Accumulated approximate line delta from successful mutates this run. */
  approxMutationLines: number;
  /** Last system-recorded diagnostics/tests witness (machine flag). */
  verifyWitness: import('./agent-claim-gates.js').VerifyWitness | null;
  /** Successful model-requested Acceptance tool after a workspace mutation. */
  explicitAcceptanceOk: boolean;
  sessionMutatedPaths: string[];
  /** Session Exit Gate (from Critic next); null when none open. */
  openGate: import('./agent-open-gate.js').SessionOpenGate | null;
  toolsUsedThisRun: Set<string>;
  successfulReadsThisRun: Set<string>;
  /**
   * Paths whose file body was actually fetched via read_file this run.
   * Unlike successfulReadsThisRun, NOT seeded from session continuity (seed only
   * satisfies read_before_write — content may still need one fetch).
   */
  readBodiesFetchedThisRun: Set<string>;
  /** Cursor-like auto-read heals for read_before_write (cap per run). */
  readBeforeWriteAutoHeals: number;
  /**
   * After plugin_install success: tool names that must still be invoked this run
   * (install-without-use is a common live model failure).
   */
  pendingPluginInvoke: string[];
  /** Force-TOOL_CALL rounds for pendingPluginInvoke (cap 2). */
  pluginInvokeForceCount: number;
  /** Last auto workspace_checkpoint id this run (for UI Reject). */
  lastAutoCheckpointId: string | null;
  ideEditRequest: boolean;
  /**
   * Legacy configuration probe timeout. Confirmed native runs do not use it.
   */
  apiToolsTimeoutMs?: number;
}
