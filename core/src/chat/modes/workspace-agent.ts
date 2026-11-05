import type { ChatRequest, ChatResponse, ChatMode, RouteDecision } from '../../router/types.js';
import type { ResolvedModelRoute } from '../../providers/types.js';
import type { ProviderStore } from '../../providers/provider-store.js';
import type { SessionStore } from '../../sessions/session-store.js';
import type { ProjectStore } from '../../projects/project-store.js';
import { loadUserOverrides } from '../../config/user-overrides.js';
import {
  ollamaAllowedForCodeAgent,
  resolveSessionReasoningEffort,
} from '../../providers/harness-policy.js';
import {
  normalizeExecutionPolicy,
  resolveWorkspaceBehavior,
  type ExecutionPolicy,
} from '../../execution-policy.js';
import {
  behaviorAllowsAutopilot,
  behaviorPersistsLockedConstraints,
  loadDebugModeSystemNote,
  loadPlanModeSystemNote,
  resolveForcedToolPack,
  shouldUseWorkspaceToolPlane,
} from '../../agent/agent-runtime-facts.js';
import {
  extractLockedConstraintsFromText,
  loadLockedConstraints,
  persistConstraintsFromAssistantText,
} from '../../agent/agent-locked-constraints.js';
import { ensureDebugLogGitignore } from '../../sessions/workspace-scratch-gitignore.js';
import { formatDebugIngestNote, registerDebugIngest } from '../../agent/agent-debug-ingest.js';
import { resolveLlmSkillMode, resolveSkillSystemPrompt } from '../../skills/chat-skill-flow.js';
import { appendBrandManualIfNeeded } from '../../providers/brand-manual-context.js';
import { runMarOrCodeAgent } from '../../agent/agent-mar-runtime.js';
import { appendAgentAuditEvent } from '../../agent/agent-audit-ledger.js';
import { resolveAutopilotEnabled } from '../../agent/agent-autopilot.js';
import { TOOL_PLANE_NO_WORKSPACE_REFUSAL } from '../../agent/agent-failure-plane.js';
import { hasNasWriteConsent } from '../../security/nas-write-consent.js';
import { appendAssistantReply } from '../assistant-reply.js';
import { composerSelectionRef } from '../model-switch.js';
import { sanitizeHistoryForModel } from '../chat-filters.js';
import { getHistoryTurns, HISTORY_FOLD_STEP } from '../history-budget.js';
import { rememberMessagePins } from '../session-history-budget.js';
import {
  resolveMemoryProjectId,
  resolveWorkspaceRootForSession,
  resolveWorkspaceRootsForSession,
  buildWorkspaceContextParts,
  buildUserMemoryContext,
  buildPinnedInstructionsContext,
} from '../session-context.js';
import { buildDevWorkspaceContext } from '../../agent/dev-workspace-fs.js';
import { buildEditorContextSnippet } from '../editor-context.js';
import {
  formatWorkspaceLockNote,
  resolveTurnWorkspaceLock,
} from '../../agent/agent-workspace-lock.js';

/**
 * Workspace association enables the tool-capable runtime; it does not select a
 * skill or rewrite the user's route. Dedicated structured modes keep their own
 * handlers, while chat/code/user-skill modes may use workspace tools.
 *
 * Top-level「새 채팅」/개인 작업 (standalone, no project_id) must NOT inherit the
 * PC-wide default workspace — only chats under that folder/project get tools.
 * Same rule as dispatch.ts file routes and session-context.ts.
 */
export function shouldUseWorkspaceAgentRuntime(
  configPath: string,
  sessionStore: SessionStore,
  projectStore: ProjectStore,
  sessionId: string,
  mode: ChatMode,
): boolean {
  void configPath;
  const sessionRoot = resolveWorkspaceRootForSession(sessionStore, projectStore, sessionId);
  if (!sessionRoot) return false;
  return mode === 'chat'
    || mode === 'web_dev'
    || mode === 'code_agent'
    || mode.startsWith('user:');
}

/**
 * Tool plane entry — explicit execution_policy only (not message regex).
 * Ask answers from the workspace snippet without entering the tool loop.
 */
export function shouldEnterWorkspaceToolPlane(
  workspaceAgentAvailable: boolean,
  policy: ExecutionPolicy | undefined,
): boolean {
  if (!workspaceAgentAvailable) return false;
  return shouldUseWorkspaceToolPlane(resolveWorkspaceBehavior(policy));
}

/** Tool availability must not mutate the model-facing intent or response style. */
export function preserveWorkspaceAgentRouting(routing: RouteDecision): RouteDecision {
  return routing;
}

export function resolveCodeAgentProvider(
  configPath: string,
  providerStore: ProviderStore,
  resolved: ResolvedModelRoute,
): { providerId: string; modelId?: string; display: string } {
  const overrides = loadUserOverrides(configPath);
  const allowOllama = ollamaAllowedForCodeAgent(process.env, {
    localOnly: overrides.local_only === true,
  });

  const pick = (providerId: string, modelId?: string, display?: string) => {
    const r = providerStore.resolveProvider(providerId, modelId);
    if (!r) return null;
    return {
      providerId,
      modelId: modelId ?? r.modelId,
      display: display ?? `${r.def.name}/${modelId ?? r.modelId}`,
    };
  };

  if (overrides.local_only) {
    const ollama = pick('ollama');
    if (ollama) return ollama;
    throw new Error(
      'local_only mode requires Ollama. Configure Ollama in Models, or turn off local_only.',
    );
  }

  if (resolved.route.type === 'provider') {
    const { providerId, modelId } = resolved.route;
    if (providerId === 'ollama' && !allowOllama) {
      // Skip — fall through to MY cloud / personal API.
    } else {
      const def = providerStore.getDefinition(providerId);
      // MY cloud, personal APIs, or any selected OpenAI-compatible endpoint.
      if (def?.kind === 'openai_compatible') {
        const chosen = pick(providerId, modelId, resolved.display);
        if (chosen) return chosen;
      }
    }
  }

  const custom = pick('custom');
  if (custom) return custom;
  // Prefer a configured personal provider over failing hard.
  for (const id of providerStore.getConfiguredIds()) {
    if (id === 'ollama' && !allowOllama) continue;
    const def = providerStore.getDefinition(id);
    if (def?.user_defined) {
      const chosen = pick(id);
      if (chosen) return chosen;
    }
  }

  if (allowOllama) {
    if (resolved.route.type === 'provider' && resolved.route.providerId === 'ollama') {
      const chosen = pick('ollama', resolved.route.modelId, resolved.display);
      if (chosen) return chosen;
    }
    const ollama = pick('ollama');
    if (ollama) return ollama;
  }

  throw new Error(
    'Code agent requires company OpenRouter or a personal API (Models). Ollama is disabled for coding — set MY_AGENT_ALLOW_OLLAMA_CODE=1 only if you must.',
  );
}

export async function runWorkspaceCodeAgent(opts: {
  cqrRoot: string;
  configPath: string;
  sessionStore: SessionStore;
  projectStore: ProjectStore;
  providerStore: ProviderStore;
  req: ChatRequest;
  sessionId: string;
  routing: RouteDecision;
  resolved: ResolvedModelRoute;
  message: string;
  /** Screenshot / paste images — multimodal LLM + UI-target vision. */
  imageDataUrls?: string[];
  /** Text extracted from attachments (logs, code, docs). */
  attachmentContext?: string;
  callbacks?: {
    onToolActivity?: (row: import('../../agent/tool-activity.js').ToolActivity) => void;
    onThought?: (text: string) => void;
    onCode?: (snippet: { label: string; text: string }) => void;
    onWorkspaceMutate?: (paths: string[]) => void;
    onStatus?: (text: string) => void;
    onToolComplete?: (event: { tool: string; ok: boolean; durationMs: number }) => void;
    onAnswer?: (text: string) => void;
    onToolApproval?: (req: import('../../agent/tool-approval.js').ToolApprovalRequest) => Promise<import('../../agent/tool-approval.js').ToolApprovalOutcome>;
    onStepBudgetExhausted?: import('../../agent/step-budget-review.js').StepBudgetExhaustedHandler;
    onExecutionPolicy?: (policy: {
      requested: ReturnType<typeof normalizeExecutionPolicy>;
      effective: { reasoning: string | null; autopilot: boolean; approval: 'ask' | 'delegate' | 'autopilot' };
    }) => void;
  };
  signal?: AbortSignal;
  /** Injected on infra retry — disk may already include partial edits. */
  extraSystemNotes?: string[];
  /** Host retry / auto-resume of this same turn — resume stored progress regardless of wording. */
  continuationRetry?: boolean;
}): Promise<ChatResponse> {
  const {
    cqrRoot,
    configPath,
    sessionStore,
    projectStore,
    providerStore,
    req,
    sessionId,
    routing: rawRouting,
    resolved,
    message,
    callbacks,
    signal,
    extraSystemNotes,
    continuationRetry,
  } = opts;

  const routing = preserveWorkspaceAgentRouting(rawRouting);
  const sessionRoots = resolveWorkspaceRootsForSession(sessionStore, projectStore, sessionId);
  const sessionRoot = sessionRoots[0] ?? null;
  // Standalone chats never borrow the PC default folder (see shouldUseWorkspaceAgentRuntime).
  let workspaceRoot = sessionRoot;
  if (!workspaceRoot) {
    // ADR-008: policy reply on tool plane — never throw → INTERNAL_ERROR 500.
    const content = appendAssistantReply(sessionStore, sessionId, {
      content: TOOL_PLANE_NO_WORKSPACE_REFUSAL,
      model: 'policy/no-workspace',
      mode: routing.mode,
      userMessage: message,
    });
    return {
      role: 'assistant',
      content,
      mode: routing.mode,
      routing,
      model: 'policy/no-workspace',
      mutatedPaths: [],
    };
  }

  const workspaceLock = resolveTurnWorkspaceLock({
    sessionRoot: sessionRoot ?? workspaceRoot,
    pathHint: null,
  });
  if (workspaceLock.narrowed) {
    workspaceRoot = workspaceLock.targetRoot;
    callbacks?.onStatus?.(`Workspace lock · ${workspaceLock.matchedName || workspaceRoot}`);
  }
  const browserRouting = req.execution_context === 'background' ? 'background' : 'interactive';
  const lockNote = formatWorkspaceLockNote(workspaceLock);
  const backgroundBrowserNote = browserRouting === 'background'
    ? [
        '## Background browser routing',
        'This run is scheduled/background work. Browser actions must use target="isolated".',
        'Visible shell tabs are forbidden and cannot be focused. A final HTTP(S) page may be offered to the user as “탭으로 보기” after completion.',
      ].join('\n')
    : '';
  const lockSystemNotes = [lockNote, backgroundBrowserNote, ...(extraSystemNotes ?? [])].filter(Boolean);

  const provider = resolveCodeAgentProvider(configPath, providerStore, resolved);
  if (
    resolved.route.type === 'provider'
    && resolved.route.providerId === 'ollama'
    && provider.providerId !== 'ollama'
  ) {
    callbacks?.onStatus?.(
      `Ollama skipped for coding — using ${provider.display} (set MY_AGENT_ALLOW_OLLAMA_CODE=1 to force Ollama)`,
    );
  }
  const skillMode = resolveLlmSkillMode(routing.mode);
  const systemPrompt = await appendBrandManualIfNeeded(
    cqrRoot,
    message,
    skillMode
      ? resolveSkillSystemPrompt(skillMode, cqrRoot, message, { workspaceRoot }) ?? undefined
      : undefined,
  );
  // Always-on agent-tier index (tree + repo-map); query hits added inside code-agent.
  const editorSnippet = buildEditorContextSnippet(req?.editor_context);
  // Split for prompt caching: the stable part (memory, tree, unfocused repo map, location)
  // is sent once before history; only the request-scoped part rides in the turn context.
  const workspaceParts = workspaceLock.narrowed
    ? {
        turn: [buildPinnedInstructionsContext(req), editorSnippet].filter((p) => p.trim()).join('\n\n'),
        stable: [
          buildUserMemoryContext(configPath, sessionStore, projectStore, sessionId),
          buildDevWorkspaceContext(workspaceRoot, {}, {
            tier: 'agent',
            includeRepoMap: true,
            repoMapMaxChars: 6_000,
          }),
        ].filter((p) => p.trim()).join('\n\n'),
      }
    : buildWorkspaceContextParts(
        configPath,
        sessionStore,
        projectStore,
        req,
        sessionId,
        routing.mode,
      );
  rememberMessagePins(cqrRoot, sessionId, message);
  // Raw aligned window only; buildAgentMessages applies the single history budget/compress
  // pass (with replayed turn contexts counted), so on/off cannot flip between two passes.
  const history = sanitizeHistoryForModel(
    // Aligned window: a start that slid every turn changed the cached prompt prefix.
    sessionStore.recentMessagesAligned(
      sessionId,
      getHistoryTurns(process.env, { modelId: provider.modelId }),
      HISTORY_FOLD_STEP,
    ).slice(0, -1),
  );
  const overrides = loadUserOverrides(configPath);
  const requestedPolicy = normalizeExecutionPolicy(
    req.execution_policy,
    sessionStore.load(sessionId)?.execution_policy,
  );
  sessionStore.setExecutionPolicy(sessionId, requestedPolicy);
  const workspaceBehavior = resolveWorkspaceBehavior(requestedPolicy);
  // Plan/Debug are chosen explicitly in the UI picker — never inferred from message wording.
  if (workspaceBehavior === 'plan') {
    const planNote = loadPlanModeSystemNote(cqrRoot);
    if (planNote) lockSystemNotes.push(planNote);
  }
  if (workspaceBehavior === 'debug') {
    const debugNote = loadDebugModeSystemNote(cqrRoot);
    if (debugNote) lockSystemNotes.push(debugNote);
    ensureDebugLogGitignore(workspaceRoot);
    // Per-conversation probe target; token is stable for the app lifetime (prompt cache safe).
    lockSystemNotes.push(formatDebugIngestNote(registerDebugIngest(sessionId, workspaceRoot)));
  }
  const autopilotOverride =
    requestedPolicy.autopilot === 'on' ? true : requestedPolicy.autopilot === 'off' ? false : null;
  const autopilotHeuristic = resolveAutopilotEnabled(
    process.env,
    autopilotOverride,
    message,
    { codeSession: true },
  );
  const autopilot = !behaviorAllowsAutopilot(workspaceBehavior, cqrRoot)
    ? false
    : autopilotOverride !== null ? autopilotOverride : autopilotHeuristic ? true : undefined;
  const reasoningEffort = resolveSessionReasoningEffort(requestedPolicy.reasoning, process.env, {
    providerId: provider.providerId,
    modelId: provider.modelId,
    userMessage: message,
  });
  const activities = new Map<string, import('../../agent/tool-activity.js').ToolActivity>();
  callbacks?.onExecutionPolicy?.({
    requested: requestedPolicy,
    effective: { reasoning: reasoningEffort, autopilot: autopilot === true, approval: requestedPolicy.approval },
  });
  appendAgentAuditEvent(cqrRoot, {
    type: 'run_start',
    sessionId,
    detail: workspaceBehavior === 'agent'
      ? 'workspace_agent:model_directed_tools'
      : `workspace_agent:${workspaceBehavior}`,
  });
  callbacks?.onStatus?.(workspaceBehavior === 'debug'
    ? 'Debug 모드 · 가설 → 임시 로그 → 재현 → 수정 → 로그 정리 순서로 진행합니다'
    : workspaceBehavior === 'plan'
      ? 'Plan 모드 · 읽기 전용으로 코드를 살펴보고 설계만 합니다'
      : 'Agent runtime · 모델이 도구 사용과 작업 완결성을 판단합니다');

  const agent = await runMarOrCodeAgent({
    workspaceRoot,
    userMessage: message,
    systemPrompt,
    workspaceContext: workspaceParts.turn,
    stableWorkspaceContext: workspaceParts.stable,
    attachmentContext: opts.attachmentContext,
    history,
    providerId: provider.providerId,
    modelId: provider.modelId,
    reasoningEffort,
    providerStore,
    responsesStateFactory: (lane, providerId, modelId, mode) => ({
      state: sessionStore.responsesState(sessionId, providerId, modelId, mode, lane),
      onUpdate: (state) => sessionStore.saveResponsesState(sessionId, state, lane),
    }),
    nasWriteConsent: hasNasWriteConsent(overrides),
    allowedWriteRoots: sessionRoots,
    cqrRoot,
    configPath,
    sessionId,
    memoryProjectId: resolveMemoryProjectId(sessionStore, sessionId),
    playwrightHeadless: browserRouting === 'background' ? true : overrides.playwright_headless,
    browserRouting,
    // Code agent default ON for 127.0.0.1 dev E2E; set user-overrides false to lock.
    playwrightAllowLocalhost: overrides.playwright_allow_localhost !== false,
    autopilot,
    workspaceBehavior,
    forceToolPack: resolveForcedToolPack(workspaceBehavior, cqrRoot),
    continuationRetry: continuationRetry === true,
    imageDataUrls: opts.imageDataUrls,
    extraSystemNotes: lockSystemNotes,
    onThought: callbacks?.onThought,
    onToolActivity: (row) => {
      activities.set(row.id, row);
      callbacks?.onToolActivity?.(row);
    },
    onCode: callbacks?.onCode,
    onWorkspaceMutate: callbacks?.onWorkspaceMutate,
    onStatus: callbacks?.onStatus,
    onToolComplete: callbacks?.onToolComplete,
    onAnswer: callbacks?.onAnswer,
    onToolApproval: callbacks?.onToolApproval,
    onStepBudgetExhausted: callbacks?.onStepBudgetExhausted,
    signal,
  });

  const persistsConstraints = behaviorPersistsLockedConstraints(workspaceBehavior, cqrRoot);
  const planConstraintsLocked = persistsConstraints
    ? Boolean(extractLockedConstraintsFromText(agent.content ?? ''))
    : undefined;

  const scrubbed = appendAssistantReply(sessionStore, sessionId, {
    content: agent.content,
    tool_activity: [...activities.values()],
    model: agent.model,
    selected_model: composerSelectionRef(req.model),
    mode: routing.mode,
    application_notice: agent.applicationNotice,
    userMessage: message,
    workspace_behavior: workspaceBehavior === 'plan' ? 'plan' : undefined,
    plan_constraints_locked: planConstraintsLocked,
    emptyFallback:
      '코드 에이전트 응답이 비어 있습니다. 같은 요청을 다시 보내 주세요. (텍스트 모드로도 가능합니다.)',
  });

  if (persistsConstraints) {
    persistConstraintsFromAssistantText({
      cqrRoot,
      sessionId,
      assistantText: scrubbed,
      previous: loadLockedConstraints(cqrRoot, sessionId),
    });
  }

  return {
    role: 'assistant',
    content: scrubbed,
    mode: routing.mode,
    routing,
    model: agent.model,
    mutatedPaths: agent.mutatedPaths ?? [],
    ...(agent.browserHandoff ? { browserHandoff: agent.browserHandoff } : {}),
    ...(agent.applicationNotice ? { applicationNotice: agent.applicationNotice } : {}),
    ...(planConstraintsLocked !== undefined ? { planConstraintsLocked } : {}),
  };
}
