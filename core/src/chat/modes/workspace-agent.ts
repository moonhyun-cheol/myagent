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
import { normalizeExecutionPolicy } from '../../execution-policy.js';
import { resolveAgentSkillMode, resolveSkillSystemPrompt } from '../../skills/chat-skill-flow.js';
import { runMarOrCodeAgent } from '../../agent/agent-mar-runtime.js';
import { appendAgentAuditEvent } from '../../agent/agent-audit-ledger.js';
import { resolveAutopilotEnabled } from '../../agent/agent-autopilot.js';
import { TOOL_PLANE_NO_WORKSPACE_REFUSAL } from '../../agent/agent-failure-plane.js';
import { hasNasWriteConsent } from '../../security/nas-write-consent.js';
import { appendAssistantReply, scrubAssistantContent } from '../assistant-reply.js';
import { sanitizeHistoryForModel } from '../chat-filters.js';
import { applyHistoryContentBudget, getHistoryTurns } from '../history-budget.js';
import {
  buildSessionHistoryBudgetOpts,
  rememberMessagePins,
} from '../session-history-budget.js';
import { loadAgentRunMeta } from '../../agent/agent-run-meta.js';
import {
  hasDevWorkspace,
  tryGetDevWorkspaceRoot,
  resolveSessionContextScope,
  resolveWorkspaceRootForSession,
  resolveWorkspaceRootsForSession,
  buildWorkspaceContext,
  buildUserMemoryContext,
} from '../session-context.js';
import { buildDevWorkspaceContext } from '../../agent/dev-workspace-fs.js';
import { buildEditorContextSnippet } from '../editor-context.js';
import {
  formatWorkspaceLockNote,
  resolveTurnWorkspaceLock,
} from '../../agent/agent-workspace-lock.js';

/**
 * Run Code Agent when the session is bound to a work folder, or standalone
 * with a configured global `dev_workspace_root` (R-301, RC-002).
 * Workspace association selects the tool plane only — it must not rewrite
 * `routing.mode` to `web_dev` (RC-013) or inject the web_dev skill (RC-014/015).
 */
export function shouldRunWorkspaceAgent(
  configPath: string,
  sessionStore: SessionStore,
  projectStore: ProjectStore,
  sessionId: string,
  mode: ChatMode,
  message: string,
  explicitMode: ChatMode | null,
): boolean {
  const sessionRoot = resolveWorkspaceRootForSession(sessionStore, projectStore, sessionId);
  const scope = resolveSessionContextScope(sessionStore, projectStore, sessionId);
  void mode;
  void message;
  void explicitMode;
  return Boolean(sessionRoot || (scope === 'standalone' && hasDevWorkspace(configPath)));
}

/** Workspace tools must not rewrite the user's route intent (RC-013). */
export function preserveWorkspaceAgentRouting(routing: RouteDecision): RouteDecision {
  return routing;
}

/** @deprecated Identity alias — chat must stay chat (RC-013). */
export function promoteWorkspaceAgentRouting(routing: RouteDecision): RouteDecision {
  return preserveWorkspaceAgentRouting(routing);
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
    onThought?: (text: string) => void;
    onCode?: (snippet: { label: string; text: string }) => void;
    onWorkspaceMutate?: (paths: string[]) => void;
    onStatus?: (text: string) => void;
    onToolComplete?: (event: { tool: string; ok: boolean; durationMs: number }) => void;
    onAnswer?: (text: string) => void;
    onToolApproval?: (req: import('../../agent/tool-approval.js').ToolApprovalRequest) => Promise<boolean>;
    onExecutionPolicy?: (policy: {
      requested: ReturnType<typeof normalizeExecutionPolicy>;
      effective: { reasoning: string | null; autopilot: boolean; approval: 'ask' | 'delegate' | 'autopilot' };
    }) => void;
  };
  signal?: AbortSignal;
  /** Injected on infra retry — disk may already include partial edits. */
  extraSystemNotes?: string[];
  /** Force checkpoint continuity for progressive auto-chain segments. */
  forceSessionContinuity?: boolean;
  /**
   * When false, skip session append so the orchestrator can persist once after
   * progressive auto-chain segments finish. Default true.
   */
  persistAssistantReply?: boolean;
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
    forceSessionContinuity,
    persistAssistantReply = true,
  } = opts;

  const routing = preserveWorkspaceAgentRouting(rawRouting);
  const sessionRoots = resolveWorkspaceRootsForSession(sessionStore, projectStore, sessionId);
  const sessionRoot = sessionRoots[0] ?? null;
  const scope = resolveSessionContextScope(sessionStore, projectStore, sessionId);
  let workspaceRoot =
    sessionRoot
    ?? (scope === 'standalone' ? tryGetDevWorkspaceRoot(configPath) : null);
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
  const lockNote = formatWorkspaceLockNote(workspaceLock);
  const lockSystemNotes = [lockNote, ...(extraSystemNotes ?? [])];

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
  const skillMode = resolveAgentSkillMode(rawRouting);
  const systemPrompt = skillMode
    ? resolveSkillSystemPrompt(skillMode, cqrRoot, message, { workspaceRoot }) ?? undefined
    : undefined;
  // Always-on agent-tier index (tree + repo-map); query hits added inside code-agent.
  const editorSnippet = buildEditorContextSnippet(req?.editor_context);
  const workspaceContext = workspaceLock.narrowed
    ? [
        editorSnippet,
        buildUserMemoryContext(configPath, sessionStore, projectStore, sessionId),
        buildDevWorkspaceContext(workspaceRoot, {}, {
          tier: 'agent',
          includeRepoMap: true,
          repoMapMaxChars: 6_000,
          focusMessage: message,
        }),
      ].filter((p) => p.trim()).join('\n\n')
    : buildWorkspaceContext(
        configPath,
        sessionStore,
        projectStore,
        req,
        sessionId,
        routing.mode,
      );
  const mergedWorkspaceContext = workspaceContext;
  rememberMessagePins(cqrRoot, sessionId, message);
  const runMeta = loadAgentRunMeta(cqrRoot, sessionId);
  const history = applyHistoryContentBudget(
    sanitizeHistoryForModel(
      sessionStore.recentMessages(sessionId, getHistoryTurns(process.env, { modelId: provider.modelId })).slice(0, -1),
    ),
    process.env,
    buildSessionHistoryBudgetOpts({
      cqrRoot,
      sessionId,
      modelId: provider.modelId,
      extraPins: runMeta.mutatedPaths?.slice(0, 8).map((p) => `mutated:${p}`),
    }),
  );
  const overrides = loadUserOverrides(configPath);
  const requestedPolicy = normalizeExecutionPolicy(
    req.execution_policy,
    sessionStore.load(sessionId)?.execution_policy,
  );
  sessionStore.setExecutionPolicy(sessionId, requestedPolicy);
  const autopilotOverride =
    requestedPolicy.autopilot === 'on' ? true : requestedPolicy.autopilot === 'off' ? false : null;
  const autopilotHeuristic = resolveAutopilotEnabled(
    process.env,
    autopilotOverride,
    message,
    { codeSession: true },
  );
  const autopilot =
    autopilotOverride !== null ? autopilotOverride : autopilotHeuristic ? true : undefined;
  const reasoningEffort = resolveSessionReasoningEffort(requestedPolicy.reasoning, process.env, {
    providerId: provider.providerId,
    modelId: provider.modelId,
  });
  callbacks?.onExecutionPolicy?.({
    requested: requestedPolicy,
    effective: { reasoning: reasoningEffort, autopilot: autopilot === true, approval: requestedPolicy.approval },
  });
  appendAgentAuditEvent(cqrRoot, {
    type: 'run_start',
    sessionId,
    detail: 'workspace_agent:model_directed_tools',
  });
  callbacks?.onStatus?.('Agent runtime · 모델이 도구 사용과 작업 완결성을 판단합니다');

  const agent = await runMarOrCodeAgent({
    workspaceRoot,
    userMessage: message,
    systemPrompt,
    workspaceContext: mergedWorkspaceContext,
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
    playwrightHeadless: overrides.playwright_headless,
    // Code agent default ON for 127.0.0.1 dev E2E; set user-overrides false to lock.
    playwrightAllowLocalhost: overrides.playwright_allow_localhost !== false,
    autopilot,
    imageDataUrls: opts.imageDataUrls,
    extraSystemNotes: lockSystemNotes,
    agentPromptProfile: rawRouting.mode === 'web_dev' ? 'coding' : 'general',
    forceSessionContinuity: forceSessionContinuity === true,
    onThought: callbacks?.onThought,
    onCode: callbacks?.onCode,
    onWorkspaceMutate: callbacks?.onWorkspaceMutate,
    onStatus: callbacks?.onStatus,
    onToolComplete: callbacks?.onToolComplete,
    onAnswer: callbacks?.onAnswer,
    onToolApproval: callbacks?.onToolApproval,
    signal,
  });

  const scrubbed = persistAssistantReply
    ? appendAssistantReply(sessionStore, sessionId, {
        content: agent.content,
        model: agent.model,
        mode: routing.mode,
        application_notice: agent.applicationNotice,
        userMessage: message,
        emptyFallback:
          '에이전트 응답이 비어 있습니다. 같은 요청을 다시 보내 주세요. (텍스트 모드로도 가능합니다.)',
      })
    : scrubAssistantContent(agent.content, sessionId, message)
      || '에이전트 응답이 비어 있습니다. 같은 요청을 다시 보내 주세요. (텍스트 모드로도 가능합니다.)';

  return {
    role: 'assistant',
    content: scrubbed,
    mode: routing.mode,
    routing,
    model: agent.model,
    mutatedPaths: agent.mutatedPaths ?? [],
    ...(agent.checkpointId ? { checkpointId: agent.checkpointId } : {}),
    ...(agent.applicationNotice ? { applicationNotice: agent.applicationNotice } : {}),
  };
}
