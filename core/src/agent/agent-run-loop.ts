import path from 'node:path';
import type { ChatMessage, ToolCompletionResult } from '../providers/openai-compatible.js';
import {
  clientToolProtocolCacheKey,
  peekedClientToolProtocolReason,
  clearClientToolProtocol,
  rememberClientToolProtocol,
  chatContentToText,
} from '../providers/openai-compatible.js';
import {
  loadHarnessPolicy,
  ollamaEmergencyFallbackEnabled,
  resolveCodeReasoningEffortForModel,
  resolveCodeOwuiProtocolMode,
} from '../providers/harness-policy.js';
import { applyHistoryContentBudget } from '../chat/history-budget.js';
import { buildSessionHistoryBudgetOpts } from '../chat/session-history-budget.js';
import { throwIfAborted } from '../chat/abort.js';
import { ProviderError } from '../providers/types.js';
import {
  getCodeAgentToolsByPack,
  getCodeAgentToolsByPackAsync,
  getCodeAgentToolNamesFromTools,
  executeAgentTool,
  normalizeToolCall,
  parseClientToolCalls,
  enrichClientToolCalls,
  contentLooksLikeToolMimic,
  toolStatusLabel,
  type AgentToolCall,
  type AgentToolContext,
} from './tools.js';
import { WorkspaceReadGate, parseToolArgs } from './tool-read-gate.js';
import {
  contentClaimsStaleShellTitleBar,
  defaultUiReadFallback,
  chatUiPathHints,
  resolveUiBootstrapPath,
  SHELL_WINDOW_PATH,
  toolCallReadOrList,
  UI_TARGET_MAP_PATH,
  UI_TASK_RE,
  UI_TITLEBAR_RE,
} from './agent-ui-bootstrap.js';
import {
  appendClientToolProtocol,
  isCodeAgentLlmProvider,
  prefersClientToolProtocol,
} from './agent-tool-protocol.js';
import {
  formatAgentPhaseStatus,
  awaitWithWaitStatus,
} from './agent-status-report.js';
import {
  completeAgentStepClientProtocol,
  completeAgentAnswerStep,
  completeAgentStepWithProtocol,
  type AgentToolProtocol,
} from './agent-llm-step.js';
import { packIncludesBrowser } from './agent-tool-pack.js';
import { loadUiFacts } from './agent-grounding.js';
import {
  autopilotMaxSteps,
  formatAutopilotSystemNote,
  resolveAutopilotEnabled,
  shouldOrInContinuityAutopilot,
} from './agent-autopilot.js';
import {
  formatOpenGateSystemNote,
  openGateBlocksDoneClaim,
} from './agent-open-gate.js';
import {
  diagnosticsEvidenceStatus,
  type DiagnosticsEvidenceStatus,
} from './agent-outcome-gate.js';
import {
  appendSessionMutatedPaths,
  appendSessionReadPaths,
  formatActiveTaskSystemNote,
  loadAgentRunMeta,
  recordSessionPerf,
} from './agent-run-meta.js';
import {
  flushLiveSessionProgress,
  formatSessionContinuitySystemNote,
  persistInterruptedAgentProgress,
  seedReadGateFromSession,
  shouldUseSessionContinuity,
} from './agent-session-continuity.js';
import { buildTaskLedgerTopicManifest } from './task-ledger.js';
import {
  collectPerfEnv,
  hostFromBaseUrl,
  writePerfJsonl,
  inferEarlyExitReason,
  summarizeResponsesPerfState,
  type AgentPerfSnapshot,
} from './agent-perf-metrics.js';
import { calculateLlmUsageCost } from './llm-usage-cost.js';
import { runAgentStepLoop } from './agent-run-step-loop.js';
import type { AgentRunStepState } from './agent-run-step-state.js';
import {
  formatLockedConstraintsSystemNote,
  resolveLockedConstraintsForTurn,
} from './agent-locked-constraints.js';
import { resolveScopedProductMemory } from './agent-product-memory.js';
import {
  formatPatchFormatConstraints,
} from './agent-planner.js';
import { formatMultimodalSystemNote } from './agent-multimodal.js';
import {
  formatToolSelfCorrection,
  isRecoverableToolFailure,
  MAX_SELF_CORRECTION_STREAK,
  toolOutputAlreadyHasCorrection,
} from './tool-self-correction.js';
import {
  URL_IN_MESSAGE_RE,
  BROWSER_CAPTURE_RE,
  CODE_RESPONSE_STYLE,
} from '../router/route-heuristics.js';
import { assertDevWorkspaceRootReadable } from '../security/dev-workspace-guard.js';
import { isPlaywrightAvailable } from '../browser/playwright-probe.js';
import { PlaywrightSession } from '../browser/playwright-session.js';
import { applyToolSchemaCompat } from './tool-schema-compat.js';
import {
  createToolLoopGuard,
  formatLoopGuardStop,
  formatLoopGuardUserMessage,
} from './tool-loop-guard.js';
import {
  createToolApprovalId,
  formatApprovalDenied,
  needsHumanApproval,
} from './tool-approval.js';
import {
  createDefaultAgentHooks,
  isHookStop,
  mergeAgentHooks,
} from './agent-hooks.js';
import {
  applyChatStreamFilter,
  sanitizeHistoryForModel,
  scrubAgentChannelLeak,
  looksLikeTruncatedAssistantReply,
} from '../chat/chat-filters.js';
import {
  formatSilentVerifyRepairPrompt,
  isMutatingAgentTool,
  maxSilentVerifyRetries,
  parseVerifyJson,
} from './verify-loop.js';
import {
  clearOldCheckpoints,
  createWorkspaceCheckpoint,
} from './agent-checkpoint.js';
import {
  appendAgentAuditEvent,
  createAuditLedgerHooks,
  loadAuditShipPolicy,
  shipAgentAuditQueue,
} from './agent-audit-ledger.js';
import { runWorkspaceDiagnostics } from './run-diagnostics.js';
import { runWorkspaceTests, detectTestRunner } from './run-tests.js';
import type { CodeAgentOptions, CodeAgentResult } from './agent-run-types.js';
import { MAX_AGENT_STEPS } from './agent-run-types.js';
import {
  buildAgentMessages,
  collectAutoCheckpointPaths,
  estimateChatPayloadChars,
  extractToolCodeSnippet,
  isOwuiOrGatewayError,
  lastSuccessfulReadPath,
  messagesHadToolRole,
  pushToolResultMessage,
  trimSnippet,
  truncateToolResultForLlm,
  workspaceSnapshot,
} from './agent-run-helpers.js';

export async function runCodeAgent(opts: CodeAgentOptions): Promise<CodeAgentResult> {
  try {
    return await runCodeAgentInner(opts);
  } catch (e: unknown) {
    // Ollama emergency fallback is opt-in only (MY_AGENT_OLLAMA_FALLBACK=1).
    if (
      ollamaEmergencyFallbackEnabled()
      && opts.providerId !== 'ollama'
      && isOwuiOrGatewayError(e)
    ) {
      const ollama = opts.providerStore.resolveProvider('ollama');
      if (ollama) {
        opts.onStatus?.('MY OpenRouter unavailable — retrying with Ollama (TOOL_CALL)…');
        return runCodeAgentInner({
          ...opts,
          providerId: 'ollama',
          modelId: ollama.modelId,
        });
      }
    }
    throw e;
  }
}

async function runCodeAgentInner(opts: CodeAgentOptions): Promise<CodeAgentResult> {
  const allowNas = opts.nasWriteConsent === true;
  assertDevWorkspaceRootReadable(opts.workspaceRoot);
  const guard = { allowNas };

  const playwrightAvailable = isPlaywrightAvailable(opts.cqrRoot);
  let autopilot = resolveAutopilotEnabled(
    process.env,
    typeof opts.autopilot === 'boolean' ? opts.autopilot : null,
    opts.userMessage,
    { codeSession: true },
  );
  const toolPack =
    opts.forceToolPack
    ?? (playwrightAvailable ? 'files+browser' : 'files');
  let agentTools = await getCodeAgentToolsByPackAsync(opts.cqrRoot, toolPack);
  let toolNames = getCodeAgentToolNamesFromTools(agentTools);
  const scopedMemory = resolveScopedProductMemory(opts.cqrRoot, opts.workspaceRoot);
  const selfWorkspace = scopedMemory.selfWorkspace;
  // The model receives the complete safe tool schema and decides whether tools are needed.
  const uiFacts = selfWorkspace ? loadUiFacts(opts.cqrRoot) : null;

  const resolved = opts.providerStore.resolveProvider(opts.providerId, opts.modelId);
  if (!resolved) {
    throw new ProviderError('PROVIDER_NOT_CONFIGURED', `${opts.providerId} is not configured.`);
  }
  if (!isCodeAgentLlmProvider(opts.providerId, resolved.def)) {
    throw new ProviderError(
      'PROVIDER_NOT_SUPPORTED',
      'Code agent requires company OpenRouter or a personal API (Models). Ollama is disabled for coding unless MY_AGENT_ALLOW_OLLAMA_CODE=1.',
    );
  }

  const { secret, modelId, baseUrl, def, wireApi, toolProtocol: configuredToolProtocol } = resolved;
  // Transport is fixed before the loop; no request-time protocol negotiation or fallback.
  opts.wireApi = wireApi;

  if (wireApi === 'responses') {
    const mode = opts.providerId === 'openai' ? 'provider_state' as const : 'client_replay' as const;
    const lane = opts.marRole ? `agent:${opts.marRole}` : 'agent:primary';
    const binding = opts.responsesStateFactory?.(lane, opts.providerId, modelId, mode);
    // Each MAR role owns a distinct durable lane. Sharing previous_response_id across
    // concurrent roles would cross-contaminate reasoning and tool outputs.
    opts.responsesState = binding?.state ?? {
      version: 1,
      mode,
      provider_id: opts.providerId,
      model_id: modelId,
      next_message_index: 0,
      updated_at: new Date().toISOString(),
    };
    opts.onResponsesState = binding?.onUpdate;
  } else {
    opts.responsesState = undefined;
    opts.onResponsesState = undefined;
  }
  const protocolCacheKey = clientToolProtocolCacheKey(opts.providerId, baseUrl, modelId);
  const nativeToolsLocked = wireApi !== 'chat_completions' || configuredToolProtocol === 'native';
  opts.nativeToolsLocked = nativeToolsLocked;
  const stickyClientReason = nativeToolsLocked
    ? null
    : peekedClientToolProtocolReason(protocolCacheKey);
  // Do not infer a required edit from wording. Actual tool calls and disk evidence own completion.
  const ideEditRequest = false;
  // Provider/model configuration owns native vs TEXT. Confirmed native never
  // demotes in-run; Ollama/legacy providers remain TEXT.
  let toolProtocol: AgentToolProtocol = nativeToolsLocked
    ? 'api'
    : configuredToolProtocol === 'text' || prefersClientToolProtocol(opts.providerId, def) || stickyClientReason
      ? 'client'
      : 'api';
  const harness = loadHarnessPolicy();
  const codeOwuiProtocolMode = resolveCodeOwuiProtocolMode();
  const preferApiForIdeEdit = false; // absorbed into MY_AGENT_CODE_OWUI_PROTOCOL=probe|api
  const isOwui = opts.providerId === 'custom' || def.custom === true;
  const apiToolsTimeoutMs =
    !nativeToolsLocked && isOwui && codeOwuiProtocolMode === 'probe'
      ? harness.owuiProbeTimeoutMs
      : undefined;
  const runStartedAt = Date.now();
  let llmRoundTrips = 0;
  let toolCallCount = 0;
  let llmCompletionMs = 0;
  const llmTrace: NonNullable<AgentPerfSnapshot['llm_trace']> = [];
  const toolTrace: NonNullable<AgentPerfSnapshot['tool_trace']> = [];
  const approvalTrace: NonNullable<AgentPerfSnapshot['approval_trace']> = [];
  const approvedExternalReadRoots = new Set<string>();
  let approvalWaitMs = 0;
  const llmUsage: NonNullable<AgentPerfSnapshot['usage']> = {
    prompt_tokens: 0,
    completion_tokens: 0,
    reasoning_tokens: 0,
    cached_tokens: 0,
    cache_write_tokens: 0,
  };

  /** Cumulative agent log → SSE `thought` so UI always shows why steps ran/blocked. */
  const thoughtLog: string[] = [];
  const pushThought = (line: string) => {
    const text = applyChatStreamFilter(line.trim());
    if (!text) return;
    thoughtLog.push(text);
  };
  const reportStatus = (text: string) => {
    opts.onStatus?.(text);
    pushThought(text);
  };

  const auditLedger = createAuditLedgerHooks(opts.cqrRoot, opts.sessionId);
  const hooks = mergeAgentHooks(
    createDefaultAgentHooks((event) => {
      if (event.type === 'hook_stop') reportStatus(`hook:stop ${event.phase}: ${event.reason}`);
    }),
    {
      beforeRun: () => {
        auditLedger.beforeRun();
      },
      afterRun: async (result) => {
        auditLedger.afterRun(result);
        const policy = loadAuditShipPolicy(opts.cqrRoot);
        void shipAgentAuditQueue(opts.cqrRoot, policy);
      },
      beforeTool: (ctx) => {
        auditLedger.beforeTool(ctx);
      },
      afterTool: (ctx) => {
        auditLedger.afterTool(ctx);
      },
    },
    opts.hooks,
  );

  let lastModel = `${def.name}/${modelId}`;
  let lockedConstraints = resolveLockedConstraintsForTurn({
    cqrRoot: opts.cqrRoot,
    sessionId: opts.sessionId,
    userMessage: opts.userMessage,
    history: opts.history,
    agentMutateTurn: true,
  });
  const mutatedPathsThisRun = new Set<string>();
  /** Filled before step loop so `finish` reads live counters (not prepare-time copies). */
  let stepState: AgentRunStepState | null = null;
  let finished = false;
  const persistLiveSessionMeta = (): void => {
    // Always flush — MAR specialists set skipSessionMetaAppend for finish() only;
    // mid-run / interrupt must still leave continuity breadcrumbs for 「이어서」.
    const live = stepState;
    flushLiveSessionProgress({
      cqrRoot: opts.cqrRoot,
      sessionId: opts.sessionId,
      mutatedPaths: [...(live?.mutatedPathsThisRun ?? mutatedPathsThisRun)],
      readPaths: [...(live?.successfulReadsThisRun ?? [])],
    });
  };
  const finish = async (result: CodeAgentResult): Promise<CodeAgentResult> => {
    finished = true;
    const live = stepState;
    const paths = live?.mutatedPathsThisRun ?? mutatedPathsThisRun;
    const pathList = [...paths];
    if (paths.size && !opts.skipSessionMetaAppend) {
      appendSessionMutatedPaths(opts.cqrRoot, opts.sessionId, pathList);
    }
    const readList = [...(live?.successfulReadsThisRun ?? [])];
    if (readList.length && !opts.skipSessionMetaAppend) {
      appendSessionReadPaths(opts.cqrRoot, opts.sessionId, readList);
    }
    // Remove exact channel envelope markers only. The model owns the meaning,
    // wording, paragraph structure, and diagnostic details of its final answer.
    const finalContent = scrubAgentChannelLeak(String(result.content ?? ''));
    result = {
      ...result,
      content: finalContent,
      mutatedPaths: pathList,
      checkpointId: live?.lastAutoCheckpointId ?? result.checkpointId ?? null,
      diagnostics: live?.evidenceDiagOk ?? null,
      verifyWitness: live?.verifyWitness ?? null,
    };
    const wallMs = Date.now() - runStartedAt;
    const liveToolTrace = live?.toolTrace ?? toolTrace;
    const liveApprovalWaitMs = live?.approvalWaitMs ?? approvalWaitMs;
    const accountedMs = (live?.llmCompletionMs ?? llmCompletionMs)
      + liveToolTrace.reduce((sum, row) => sum + row.duration_ms, 0)
      + liveApprovalWaitMs;
    const finalUsage = live?.llmUsage ?? llmUsage;
    const finalModelId = live?.modelId ?? modelId;
    const perf: AgentPerfSnapshot = {
      at: new Date().toISOString(),
      wall_ms: wallMs,
      llm_round_trips: live?.llmRoundTrips ?? llmRoundTrips,
      tool_calls: live?.toolCallCount ?? toolCallCount,
      llm_completion_ms: (live?.llmCompletionMs ?? llmCompletionMs) || undefined,
      approval_wait_ms: liveApprovalWaitMs || undefined,
      orchestration_ms: Math.max(0, wallMs - accountedMs),
      first_tool_ms: live?.firstToolMs,
      autopilot_force_count: live?.autopilotEmptyAfterMutate ?? 0,
      mutated_count: pathList.length,
      steps: result.steps,
      early_exit_reason: inferEarlyExitReason({
        content: result.content,
        mutatedCount: pathList.length,
        aborted: Boolean(opts.signal?.aborted),
        diagnostics: live?.evidenceDiagOk ?? null,
        claimsIncomplete: /(?:부분|미완료|미검증|not\s+complete|incomplete)/i.test(result.content),
      }),
      llm_trace: live?.llmTrace?.length ? live.llmTrace : undefined,
      tool_trace: live?.toolTrace?.length ? live.toolTrace : undefined,
      approval_trace: live?.approvalTrace?.length ? live.approvalTrace : undefined,
      responses_state: summarizeResponsesPerfState(live?.opts.responsesState ?? opts.responsesState),
      usage: finalUsage,
      cost: calculateLlmUsageCost(finalUsage, finalModelId),
      env: collectPerfEnv({
        modelId: finalModelId,
        providerId: opts.providerId,
        baseUrlHost: hostFromBaseUrl(live?.baseUrl ?? baseUrl),
        protocol: live?.toolProtocol ?? toolProtocol,
        tool_protocol: live?.toolProtocol ?? toolProtocol,
        wire_api: wireApi,
        reasoning_effort: resolveCodeReasoningEffortForModel(process.env, { modelId }),
        mar_light: harness.marLight,
        autopilot,
        owui_protocol: codeOwuiProtocolMode,
      }),
    };
    try {
      recordSessionPerf(opts.cqrRoot, opts.sessionId, perf);
      writePerfJsonl(opts.cqrRoot, perf);
    } catch {
      /* perf logging must not fail the run */
    }
    hooks.onEvent?.({ type: 'run_end', content: result.content, steps: result.steps });
    await hooks.afterRun?.(result);
    return result;
  };
  const beforeRun = await hooks.beforeRun?.();
  if (isHookStop(beforeRun)) {
    return finish({ content: `Agent stopped: ${beforeRun.reason}`, model: lastModel, steps: 0 });
  }
  hooks.onEvent?.({ type: 'run_start' });

  if (stickyClientReason && toolProtocol === 'client') {
    // Sticky after a real failure — reason visible for ops/debug (not "API 도구 없음" spam).
    reportStatus(
      `툴 프로토콜: TEXT TOOL_CALL (sticky: ${String(stickyClientReason).slice(0, 80)})`,
    );
  } else if ((def.custom || opts.providerId === 'custom') && toolProtocol === 'api') {
    reportStatus(
      nativeToolsLocked
        ? '툴 프로토콜: Responses native tools (구성 고정)'
        : apiToolsTimeoutMs
        ? `툴 프로토콜: API tools probe (${Math.round(apiToolsTimeoutMs / 1000)}s)`
        : `툴 프로토콜: API tools`,
    );
  } else if (
    (def.custom || opts.providerId === 'custom')
    && toolProtocol === 'client'
  ) {
    // First-step UX: status only before LLM stream (multi-file often 30–70s silent).
    reportStatus('툴 프로토콜: TEXT TOOL_CALL · 첫 TOOL_CALL 대기…');
  }
  reportStatus(`에이전트 실행${autopilot ? ' · Autopilot' : ''}`);
  if (!selfWorkspace) {
    reportStatus('외부 워크스페이스 — CQR product memory / ui-target-map 미주입');
  }
  appendAgentAuditEvent(opts.cqrRoot, {
    type: 'turn_decision',
    sessionId: opts.sessionId,
    detail: 'model_directed_single_agent',
  });

  let thoughtBuf = '';
  let answerBuf = '';
  const publishThoughtPanel = () => {
    const providerThought = thoughtBuf.trim();
    if (!providerThought) return;
    opts.onThought?.(providerThought.length > 12_000 ? providerThought.slice(-12_000) : providerThought);
  };

  let messages = buildAgentMessages(
    opts,
    guard,
    toolNames,
    toolProtocol === 'client',
    uiFacts,
    scopedMemory.promptBlock,
    selfWorkspace,
    false,
  );
  let sysInsertAt = 1;
  const sessionMetaForGate = loadAgentRunMeta(opts.cqrRoot, opts.sessionId);
  const activeTask = sessionMetaForGate.activeTask
    && (sessionMetaForGate.activeTask.status === 'active' || sessionMetaForGate.activeTask.status === 'blocked')
    ? sessionMetaForGate.activeTask
    : null;
  const openGate = openGateBlocksDoneClaim(sessionMetaForGate.openGate)
    ? sessionMetaForGate.openGate ?? null
    : null;
  const sessionReadPaths = sessionMetaForGate.readPaths ?? [];
  const sessionContinuity = shouldUseSessionContinuity({
    userMessage: opts.userMessage,
    openGate,
    readPaths: sessionReadPaths,
    mutatedPaths: sessionMetaForGate.mutatedPaths,
  });
  // Exit Gate / bare 「이어서」: keep continuous run (CODE_AUTOPILOT default on).
  if (
    shouldOrInContinuityAutopilot({
      currentlyEnabled: autopilot,
      openGate: Boolean(openGate),
      sessionContinuity,
      optsAutopilot: opts.autopilot,
    })
  ) {
    autopilot = true;
  }
  if (autopilot) {
    messages.splice(sysInsertAt, 0, {
      role: 'system',
      content: formatAutopilotSystemNote(),
    });
    sysInsertAt += 1;
    pushThought('Autopilot ON — 다음 조치로 끊지 않고 이 실행에서 닫기');
  }
  if (openGate) {
    messages.splice(sysInsertAt, 0, {
      role: 'system',
      content: formatOpenGateSystemNote(openGate),
    });
    sysInsertAt += 1;
    pushThought(`Exit Gate OPEN · ${openGate.gate.slice(0, 72)}`);
    reportStatus(`Exit Gate · ${openGate.gate.slice(0, 60)}`);
  }
  if (activeTask) {
    messages.splice(sysInsertAt, 0, {
      role: 'system',
      content: formatActiveTaskSystemNote(activeTask),
    });
    sysInsertAt += 1;
    pushThought(`Active task · ${activeTask.status} · ${activeTask.objective.slice(0, 72)}`);
    reportStatus(`Active task · ${activeTask.objective.slice(0, 60)}`);
  }
  const taskTopicManifest = buildTaskLedgerTopicManifest(opts.cqrRoot, {
    sessionId: opts.sessionId,
    workspaceRoot: opts.workspaceRoot,
  });
  if (taskTopicManifest) {
    messages.splice(sysInsertAt, 0, {
      role: 'system',
      content: taskTopicManifest,
    });
    sysInsertAt += 1;
  }
  if (sessionContinuity) {
    messages.splice(sysInsertAt, 0, {
      role: 'system',
      content: formatSessionContinuitySystemNote({
        readPaths: sessionReadPaths,
        mutatedPaths: sessionMetaForGate.mutatedPaths,
        openGate,
      }),
    });
    sysInsertAt += 1;
    pushThought('Session continuity — readGate 시드 · 재진단 스킵');
    reportStatus('Session continuity · 이전 읽기/수정 경로 재사용');
  }
  const lockedNote = formatLockedConstraintsSystemNote(lockedConstraints);
  if (lockedNote) {
    messages.splice(sysInsertAt, 0, {
      role: 'system',
      content: lockedNote,
    });
    sysInsertAt += 1;
    pushThought(
      lockedConstraints?.invalidated
        ? 'P0 제약 · 무효화(방향 정정) — PLAN 재작성 · legacy 격리'
        : `P0 제약 · mode=${lockedConstraints?.mode ?? 'unknown'} · kind=${lockedConstraints?.artifactKind ?? lockedConstraints?.artifact?.artifactKind ?? 'unknown'}`,
    );
  }
  if (opts.extraSystemNotes?.length) {
    for (const note of opts.extraSystemNotes) {
      if (!note.trim()) continue;
      messages.splice(sysInsertAt, 0, {
        role: 'system',
        content: note,
      });
      sysInsertAt += 1;
    }
  }
  const toolsUsedThisRun = new Set<string>();
  const successfulReadsThisRun = new Set<string>();
  const readBodiesFetchedThisRun = new Set<string>();
  let readBeforeWriteAutoHeals = 0;
  let steps = 0;
  let browserSession: PlaywrightSession | null = null;
  if (playwrightAvailable && packIncludesBrowser(toolPack)) {
    try {
      browserSession = await PlaywrightSession.open({
        cqrRoot: opts.cqrRoot,
        headless: opts.playwrightHeadless !== false,
        urlGuard: { allowLocalhost: opts.playwrightAllowLocalhost === true },
      });
    } catch {
      browserSession = null;
    }
  }
  const toolCtx: AgentToolContext = {
    browserSession,
    cqrRoot: opts.cqrRoot,
    sessionId: opts.sessionId,
    allowLocalhost: opts.playwrightAllowLocalhost,
    signal: opts.signal,
    getRunEvidence: () => ({
      mutatedPaths: [...(stepState?.mutatedPathsThisRun ?? mutatedPathsThisRun)],
      acceptanceOk: stepState?.explicitAcceptanceOk === true,
    }),
  };
  const readGate = new WorkspaceReadGate();
  const continuitySeedPaths = [
    ...sessionReadPaths,
    ...sessionMetaForGate.mutatedPaths,
    ...(openGate?.evidence?.path ? [openGate.evidence.path] : []),
  ];
  if (sessionContinuity && continuitySeedPaths.length) {
    const seeded = seedReadGateFromSession(readGate, continuitySeedPaths);
    for (const p of seeded) successfulReadsThisRun.add(p);
  }
  let autoCheckpointTaken = false;
  let lastAutoCheckpointId: string | null = null;
  let silentVerifyAttempts = 0;
  let verifyExhaustedNotified = false;
  const maxVerify = maxSilentVerifyRetries();
  let selfCorrectionStreak = 0;
  let writeFailStreak = 0;
  let mutatedOkRun = false;
  let planDeferRetries = 0;
  let autopilotEmptyAfterMutate = 0;
  let inspectAnswerSynthRetries = 0;
  let pendingPluginInvoke: string[] = [];
  let pluginInvokeForceCount = 0;
  let ideEditNudgeCount = 0;
  let targetMissNudgeCount = 0;
  let evidenceDiagOk: DiagnosticsEvidenceStatus = null;
  let ranVerifyCommand = false;
  let emptyRetrievalPending = false;
  let approxMutationLines = 0;
  let verifyWitness: import('./agent-claim-gates.js').VerifyWitness | null = null;
  let explicitAcceptanceOk = false;
  const sessionMutatedPaths = sessionMetaForGate.mutatedPaths;
  const state: AgentRunStepState = {
    opts,
    guard,
    steps,
    thoughtBuf,
    answerBuf,
    thoughtLog,
    messages,
    toolProtocol,
    nativeToolsLocked,
    stickyClientReason,
    preferApiForIdeEdit,
    def,
    baseUrl,
    secret,
    modelId,
    protocolCacheKey,
    toolNames,
    agentTools,
    toolPack,
    autopilot,
    maxSteps: Math.max(
      1,
      Math.min(60, autopilotMaxSteps(opts.maxSteps ?? MAX_AGENT_STEPS, autopilot)),
    ),
    applyOutcomeGate: opts.applyOutcomeGate !== false,
    selfWorkspace,
    uiFacts,
    reportStatus,
    pushThought,
    publishThoughtPanel,
    finish,
    persistLiveSessionMeta,
    hooks,
    lastModel,
    lockedConstraints,
    mutatedPathsThisRun,
    runStartedAt,
    firstToolMs: undefined,
    llmRoundTrips,
    toolCallCount,
    llmCompletionMs,
    llmTrace,
    toolTrace,
    approvalWaitMs,
    approvalTrace,
    approvedExternalReadRoots,
    llmUsage,
    browserSession,
    toolCtx,
    readGate,
    autoCheckpointTaken,
    lastAutoCheckpointId,
    silentVerifyAttempts,
    verifyExhaustedNotified,
    maxVerify,
    selfCorrectionStreak,
    writeFailStreak,
    mutatedOkRun,
    planDeferRetries,
    autopilotEmptyAfterMutate,
    inspectAnswerSynthRetries,
    pendingPluginInvoke,
    pluginInvokeForceCount,
    ideEditNudgeCount,
    targetMissNudgeCount,
    evidenceDiagOk,
    ranVerifyCommand,
    emptyRetrievalPending,
    approxMutationLines,
    verifyWitness,
    explicitAcceptanceOk,
    sessionMutatedPaths,
    openGate,
    toolsUsedThisRun,
    successfulReadsThisRun,
    readBodiesFetchedThisRun,
    readBeforeWriteAutoHeals,
    ideEditRequest,
    apiToolsTimeoutMs,
  };
  stepState = state;

  try {
    return await runAgentStepLoop(state);
  } catch (e: unknown) {
    // 504 / abort / throw often skip finish() — flush live paths + resume Exit Gate
    // so 「이어서」 has accurate continuity for any task, not just the last feature.
    // Also flush when skipSessionMetaAppend (MAR specialist) — interrupt ≠ normal finish.
    if (!finished) {
      try {
        persistInterruptedAgentProgress({
          cqrRoot: opts.cqrRoot,
          sessionId: opts.sessionId,
          mutatedPaths: [...(stepState?.mutatedPathsThisRun ?? mutatedPathsThisRun)],
          readPaths: [...(stepState?.successfulReadsThisRun ?? [])],
          userMessage: opts.userMessage,
        });
      } catch {
        /* meta best-effort */
      }
    }
    throw e;
  } finally {
    // Belt-and-suspenders: AbortSignal may race close; kill long run_terminal jobs.
    try {
      const { cancelTerminalJob } = await import('./run-terminal.js');
      if (opts.sessionId) cancelTerminalJob(`agent_${opts.sessionId}`);
    } catch {
      /* ignore */
    }
    await browserSession?.close();
  }
}
