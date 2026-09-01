import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import type { AttachmentService } from '../attachments/attachment-service.js';
import { buildAttachmentContext, collectAttachmentImageDataUrls } from '../attachments/text-extract.js';
import type { ModelRegistry } from '../models/model-registry.js';
import type { ProviderStore } from '../providers/provider-store.js';
import type { SessionStore } from '../sessions/session-store.js';
import { CloudChatService } from '../providers/cloud-chat.js';
import { ProviderError } from '../providers/types.js';
import type { ChatRequest, ChatResponse, ChatMode, RouteDecision } from '../router/types.js';
import { DeepResearchPipeline } from '../research/deep-research.js';
import { AutoImageBackend } from '../image/image-backend.js';
import { ingestOwuiChatImages } from '../image/owui-media.js';
import { resolveChatModelAsync, effectiveAutoModelMode } from '../models/model-picker.js';
import { initSse, sseEvent, sseDone } from './sse.js';
import { isAbortError, throwIfAborted } from './abort.js';
import { LocalChatService } from '../inference/local-chat.js';
import { loadUserOverrides } from '../config/user-overrides.js';
import {
  isSkillChatMode,
  resolveLlmSkillMode,
  resolveSkillSystemPrompt,
  isStreamableLlmSkillMode,
} from '../skills/chat-skill-flow.js';
import { isUserSkillMode } from '../skills/user-skill-store.js';
import {
  augmentWithWebSearch,
  mergeSearchContext,
  shouldAutoWebSearch,
} from '../skills/web-search-augment.js';
import { formatChatErrorMessage, isUpstreamConnectionDrop } from '../debug-session-log.js';
import { waitForToolApproval } from '../agent/tool-approval.js';
import { reviewToolApproval } from '../agent/approval-auto-review.js';
import { queueAutoErrorReport } from '../support/error-report-service.js';
import { getUserMemoryStore } from '../memory/user-memory-store.js';
import { resolveMemoryProjectId } from './session-context.js';
import {
  applyChatInletFilter,
  applyChatOutletFilter,
  applyChatStreamFilter,
  sanitizeHistoryForModel,
} from './chat-filters.js';
import { applyHistoryContentBudget, getHistoryTurns } from './history-budget.js';
import {
  buildSessionHistoryBudgetOpts,
  rememberMessagePins,
} from './session-history-budget.js';
import type { ResolvedModelRoute } from '../providers/types.js';
import { normalizeExecutionPolicy } from '../execution-policy.js';
import { resolveSessionReasoningEffort } from '../providers/harness-policy.js';
import { dispatchAutomatonTool } from '../automaton/adapter.js';
import { buildAutomatonAckContent } from '../automaton/automaton-ack.js';
import { resolveOpenClawAdapterConfig } from '../automaton/openclaw-adapter-client.js';
import { ensureOpenClawAdapterVault } from '../automaton/openclaw-adapter-provision.js';
import { isAutomatonTool } from '../automaton/tool-map.js';
import { buildAutomatonProgressPath } from '../automaton/progress.js';
import { resolveAutomatonRoot } from '../automaton/paths.js';
import { loadDeployDefaults } from '../config/deploy-defaults.js';
import { peekAutomatonIntent, automatonIntentToRoute } from '../router/automaton-intent.js';
import type { ProjectStore } from '../projects/project-store.js';
import { normalizeMode, statusLabelForMode } from './chat-request.js';
import { buildWorkspaceContext } from './session-context.js';
import { handleBrowserAutomationMode } from './modes/browser-automation.js';
import { handleBrowserAgentMode } from './modes/browser-agent.js';
import { handleWebCrawlMode } from './modes/web-crawl.js';
import { handleDeepResearchMode } from './modes/deep-research.js';
import { handleImageGenMode } from './modes/image-gen.js';
import {
  shouldRunWorkspaceAgent,
  runWorkspaceCodeAgent,
  promoteWorkspaceAgentRouting,
  shouldEnterWorkspaceToolPlane,
} from './modes/workspace-agent.js';
import { appendAssistantReply } from './assistant-reply.js';
import {
  TOOL_PLANE_NO_WORKSPACE_REFUSAL,
  classifyLlmFailure,
  formatToolPlaneFailureAssistant,
  isInfraLlmFailure,
  isNoWorkspaceBoundError,
  shouldAutoResumeAfterInfra,
  toolPlaneAutoResumeLimit,
  toolPlaneInfraRetryLimit,
} from '../agent/agent-failure-plane.js';
import { loadAgentRunMeta } from '../agent/agent-run-meta.js';
import { persistInterruptedAgentProgress } from '../agent/agent-session-continuity.js';

export class ChatOrchestrator {
  private research: DeepResearchPipeline;
  private imageBackend: AutoImageBackend;
  private cloudChat: CloudChatService;
  private localChat: LocalChatService;
  private readonly imageOut: string;

  constructor(
    private readonly cqrRoot: string,
    private readonly attachments: AttachmentService,
    private readonly modelRegistry: ModelRegistry,
    private readonly providerStore: ProviderStore,
    private readonly sessionStore: SessionStore,
    private readonly projectStore: ProjectStore,
    private readonly configPath: string,
    private readonly dataDir: string,
    private readonly vaultDir: string,
    researchOut: string,
    imageOut: string,
  ) {
    this.cloudChat = new CloudChatService(providerStore, sessionStore, cqrRoot);
    this.localChat = new LocalChatService(cqrRoot);
    this.research = new DeepResearchPipeline(researchOut, cqrRoot, providerStore, this.cloudChat);
    this.imageBackend = new AutoImageBackend(cqrRoot, providerStore);
    this.imageOut = imageOut;
  }

  private resolveRouting(
    message: string,
    explicitMode: ChatMode | null,
    _hasAttachments: boolean,
  ): { routing: RouteDecision; automatonText: string } {
    const defaultRoute: RouteDecision = {
      mode: 'chat',
      matched_tool: 'chat',
      confidence: 1,
      layer: 'default',
    };

    // Structured API modes remain available, but the removed UI code mode has
    // no special branch. Workspace association selects the agent plane.
    if (explicitMode) {
      return {
        routing: { mode: explicitMode, matched_tool: explicitMode, confidence: 1, layer: 'explicit' },
        automatonText: message,
      };
    }

    // Slash commands are structural input, not natural-language keyword routing.
    const peek = /^\/\S/.test(message.trim()) ? peekAutomatonIntent(message) : null;
    const quickAutomaton = peek ? automatonIntentToRoute(peek) : null;
    if (quickAutomaton && peek) {
      return {
        routing: quickAutomaton,
        automatonText: peek.commandText ?? message,
      };
    }

    return { routing: defaultRoute, automatonText: message };
  }

  private async handleAutomatonDirect(
    sessionId: string,
    routing: RouteDecision,
    message: string,
    options?: { onStatus?: (text: string) => void; onThought?: (text: string) => void },
  ): Promise<ChatResponse> {
    const tool = routing.matched_tool;
    if (!tool || !isAutomatonTool(tool)) {
      const content = '**automaton 라우팅 오류** — direct command tool을 찾지 못했습니다.';
      this.sessionStore.append(sessionId, {
        role: 'assistant',
        content,
        at: new Date().toISOString(),
        model: 'automaton/error',
        mode: 'automaton_direct',
      });
      return {
        role: 'assistant',
        content,
        mode: 'automaton_direct',
        routing,
        model: 'automaton/error',
      };
    }

    const defaults = loadDeployDefaults(this.cqrRoot);
    const automatonRoot = defaults.live_automaton_root ?? resolveAutomatonRoot() ?? undefined;
    const vaultDir = this.vaultDir ?? path.join(this.cqrRoot, 'data', 'vault');
    const resolveOpenclaw = () =>
      resolveOpenClawAdapterConfig({
        baseUrl: defaults.openclaw_adapter_base_url,
        token: defaults.openclaw_adapter_token,
        signingPrivateKeyHex: defaults.openclaw_gate_signing_private_key,
        actorId: defaults.openclaw_actor_id,
        cqrRoot: this.cqrRoot,
        vaultDir,
      });
    let openclaw = resolveOpenclaw();
    if (defaults.openclaw_adapter_base_url?.trim() && !openclaw) {
      options?.onStatus?.('OpenClaw 토큰을 활성화 서버에서 받는 중…');
      const pulled = await ensureOpenClawAdapterVault(this.cqrRoot, vaultDir);
      openclaw = resolveOpenclaw();
      if (!openclaw) {
        const hint = pulled.error ? ` (${pulled.error})` : '';
        throw new Error(
          `OpenClaw URL은 있으나 토큰이 없습니다${hint}. 활성화 서버(${defaults.activation_server_url ?? '미설정'})가 켜져 있는지 확인하거나, data/vault/openclaw-adapter.json 에 {"token":"..."} 또는 env OPENCLAW_ADAPTER_TOKEN 을 넣으세요.`,
        );
      }
    }
    if (!openclaw && !automatonRoot) {
      throw new Error(
        'Automaton not configured — set openclaw_adapter_base_url + OPENCLAW_ADAPTER_TOKEN (or data/vault/openclaw-adapter.json), or LIVE_AUTOMATON_ROOT',
      );
    }
    const progressFile = automatonRoot
      ? buildAutomatonProgressPath(automatonRoot, sessionId, tool)
      : undefined;
    const ack = buildAutomatonAckContent(message, tool);
    options?.onStatus?.('접수됨 — 회신은 놉스 프로 쪽지');
    this.sessionStore.append(sessionId, {
      role: 'assistant',
      content: ack,
      at: new Date().toISOString(),
      model: `automaton/${tool}`,
      mode: 'automaton_direct',
    });
    void this.runAutomatonBackground(sessionId, {
      message,
      tool,
      automatonRoot,
      progressFile,
      openclaw,
      fallbackLocal: defaults.openclaw_fallback_local !== false && Boolean(automatonRoot),
    });
    return {
      role: 'assistant',
      content: ack,
      mode: 'automaton_direct',
      routing,
      model: `automaton/${tool}`,
    };
  }

  private async runAutomatonBackground(
    sessionId: string,
    job: {
      message: string;
      tool: string;
      automatonRoot?: string;
      progressFile?: string;
      openclaw: ReturnType<typeof resolveOpenClawAdapterConfig>;
      fallbackLocal: boolean;
    },
  ): Promise<void> {
    try {
      await dispatchAutomatonTool(job.message, job.tool, job.automatonRoot, {
        progressFile: job.progressFile,
        openclaw: job.openclaw,
        preferRemote: Boolean(job.openclaw),
        fallbackLocal: job.fallbackLocal,
      });
    } catch (err: unknown) {
      const content = [
        '**업무 명령 실행 실패**',
        '',
        `접수: \`${job.message.trim()}\``,
        err instanceof Error ? err.message : String(err),
      ].join('\n');
      this.sessionStore.append(sessionId, {
        role: 'assistant',
        content,
        at: new Date().toISOString(),
        model: `automaton/${job.tool}`,
        mode: 'automaton_direct',
      });
      this.autoReportError({
        subject: 'MY Agent 오류 [automaton_direct]',
        summary: content,
        mode: 'automaton_direct',
        rawError: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private autoReportError(payload: {
    subject: string;
    summary: string;
    mode?: string;
    rawError?: string;
  }): void {
    queueAutoErrorReport(this.cqrRoot, this.dataDir, this.vaultDir, payload);
  }

  async handle(req: ChatRequest, sessionId: string): Promise<ChatResponse> {
    const inlet = applyChatInletFilter((req.message ?? '').trim(), {
      sessionId,
      mode: req.mode,
    });
    if (inlet.blocked) {
      return {
        role: 'assistant',
        content: inlet.blockReason || 'Message blocked by inlet filter.',
        mode: 'chat',
        routing: { mode: 'chat', confidence: 1, layer: 'bypass' },
        model: 'filter/inlet',
      };
    }
    const message = inlet.text;
    const explicitMode = normalizeMode(req.mode);
    const hasAttachments = (req.attachments?.length ?? 0) > 0;
    const initialRoute = this.resolveRouting(
      message,
      explicitMode,
      hasAttachments,
    );
    const { automatonText } = initialRoute;
    let { routing } = initialRoute;
    const workspaceAgentAvailable = shouldRunWorkspaceAgent(
      this.configPath,
      this.sessionStore,
      this.projectStore,
      sessionId,
      routing.mode,
      message,
      explicitMode,
    );
    if (routing.mode === 'web_dev' && !workspaceAgentAvailable) {
      routing = { ...routing, mode: 'chat', matched_tool: 'chat' };
    }
    const requestedExecutionPolicy = normalizeExecutionPolicy(
      req.execution_policy,
      this.sessionStore.load(sessionId)?.execution_policy,
    );
    this.sessionStore.setExecutionPolicy(sessionId, requestedExecutionPolicy);
    req = { ...req, execution_policy: requestedExecutionPolicy };

    const resolved = await resolveChatModelAsync(
      req.model,
      this.modelRegistry,
      loadUserOverrides(this.configPath),
      this.providerStore,
      {
        mode: effectiveAutoModelMode(routing.mode, message, this.configPath),
        hasAttachments,
      },
    );
    const now = new Date().toISOString();
    this.sessionStore.append(sessionId, { role: 'user', content: message, at: now, mode: routing.mode });

    if (routing.mode === 'automaton_direct') {
      return this.handleAutomatonDirect(sessionId, routing, automatonText);
    }

    if (routing.mode === 'deep_research') {
      return handleDeepResearchMode({
        research: this.research,
        providerStore: this.providerStore,
        sessionStore: this.sessionStore,
        sessionId,
        message,
        routing,
        resolved,
      });
    }

    if (routing.mode === 'image_gen') {
      return handleImageGenMode({
        attachments: this.attachments,
        cloudChat: this.cloudChat,
        imageBackend: this.imageBackend,
        providerStore: this.providerStore,
        sessionStore: this.sessionStore,
        cqrRoot: this.cqrRoot,
        imageOut: this.imageOut,
        sessionId,
        message,
        routing,
        resolved,
        attachmentIds: req.attachments ?? [],
      });
    }

    if (routing.mode === 'browser_automation') {
      return handleBrowserAutomationMode({
        cqrRoot: this.cqrRoot,
        configPath: this.configPath,
        sessionStore: this.sessionStore,
        sessionId,
        message,
        routing,
      });
    }

    if (routing.mode === 'browser_agent') {
      return handleBrowserAgentMode({
        cqrRoot: this.cqrRoot,
        configPath: this.configPath,
        providerStore: this.providerStore,
        sessionStore: this.sessionStore,
        sessionId,
        message,
        routing,
      });
    }

    if (routing.mode === 'web_crawl') {
      return handleWebCrawlMode({
        cqrRoot: this.cqrRoot,
        configPath: this.configPath,
        sessionStore: this.sessionStore,
        sessionId,
        message,
        routing,
      });
    }

    if (
      shouldEnterWorkspaceToolPlane(
        shouldRunWorkspaceAgent(
          this.configPath,
          this.sessionStore,
          this.projectStore,
          sessionId,
          routing.mode,
          message,
          explicitMode,
        ),
        requestedExecutionPolicy,
      )
    ) {
      return runWorkspaceCodeAgent({
        cqrRoot: this.cqrRoot,
        configPath: this.configPath,
        sessionStore: this.sessionStore,
        projectStore: this.projectStore,
        providerStore: this.providerStore,
        req,
        sessionId,
        routing,
        resolved,
        message,
        attachmentContext: await buildAttachmentContext(
          req.attachments ?? [],
          this.attachments,
          sessionId,
          12_000,
          { cqrRoot: this.cqrRoot },
        ),
        imageDataUrls: collectAttachmentImageDataUrls(
          req.attachments ?? [],
          this.attachments,
          sessionId,
          { cqrRoot: this.cqrRoot },
        ),
      });
    }

    const skillMode = resolveLlmSkillMode(routing.mode);
    const chatLikeMode: ChatMode = skillMode ?? 'chat';
    const histModelId =
      resolved.route.type === 'provider' || resolved.route.type === 'local'
        ? resolved.route.modelId
        : undefined;
    let histBudget = { modelId: histModelId } as ReturnType<typeof buildSessionHistoryBudgetOpts>;
    const systemPrompt = skillMode ? resolveSkillSystemPrompt(skillMode, this.cqrRoot, message) : undefined;
    const attachmentCtx = await buildAttachmentContext(
      req.attachments ?? [],
      this.attachments,
      sessionId,
      12_000,
      { cqrRoot: this.cqrRoot },
    );
    const imageDataUrls = collectAttachmentImageDataUrls(
      req.attachments ?? [],
      this.attachments,
      sessionId,
      { cqrRoot: this.cqrRoot },
    );
    rememberMessagePins(this.cqrRoot, sessionId, message);
     this.autoCaptureMemory(sessionId, message);
    histBudget = buildSessionHistoryBudgetOpts({
      cqrRoot: this.cqrRoot,
      sessionId,
      modelId: histModelId,
      debit: {
        visionImageCount: imageDataUrls.length,
        attachmentChars: attachmentCtx ? String(attachmentCtx).length : 0,
      },
    });
    const search = await augmentWithWebSearch(message, this.providerStore, {
      explicit: req.web_search === true,
      cqrRoot: this.cqrRoot,
    });
    const workspaceCtx = buildWorkspaceContext(
      this.configPath,
      this.sessionStore,
      this.projectStore,
      req,
      sessionId,
      routing.mode,
    );
    const hasWorkspaceContext = Boolean(workspaceCtx);
    const mergedCtx = mergeSearchContext(attachmentCtx || undefined, search.context, workspaceCtx || undefined);
    const history = applyHistoryContentBudget(
      sanitizeHistoryForModel(
        this.sessionStore.recentMessages(sessionId, getHistoryTurns(process.env, histBudget)).slice(0, -1),
      ),
      process.env,
      histBudget,
    );

    const chatResult = await this.runChatModel(
      resolved,
      message,
      mergedCtx || undefined,
      history,
      systemPrompt ?? undefined,
      hasWorkspaceContext,
      imageDataUrls,
      sessionId,
    );

    const finalized = await this.finalizeAssistantReply(
      chatResult.content,
      sessionId,
      resolved.route.type === 'provider' ? resolved.route.providerId : null,
      { userMessage: message },
    );

    this.sessionStore.append(sessionId, {
      role: 'assistant',
      content: finalized.content,
      at: new Date().toISOString(),
      model: chatResult.model,
      mode: chatLikeMode,
      image_urls: finalized.imageUrls.length ? finalized.imageUrls : undefined,
    });

    return {
      role: 'assistant',
      content: finalized.content,
      mode: chatLikeMode,
      routing,
      model: chatResult.model,
      image: finalized.imageUrls[0] ? { url: finalized.imageUrls[0] } : undefined,
      images: finalized.imageUrls.map((url) => ({ url })),
      web_search: search.applied
        ? { applied: true, source_count: search.sourceCount }
        : undefined,
    };
  }

  async handleStream(req: ChatRequest, sessionId: string, res: ServerResponse, signal?: AbortSignal): Promise<void> {
    initSse(res);
    const inlet = applyChatInletFilter((req.message ?? '').trim(), {
      sessionId,
      mode: req.mode,
    });
    if (inlet.blocked) {
      sseEvent(res, { type: 'meta', routing: { mode: 'chat', confidence: 1, layer: 'bypass' }, model: 'filter/inlet' });
      sseEvent(res, { type: 'token', text: inlet.blockReason || 'Message blocked by inlet filter.' });
      sseEvent(res, { type: 'done', model: 'filter/inlet', mode: 'chat' });
      sseDone(res);
      return;
    }
    for (const w of inlet.warnings ?? []) {
      sseEvent(res, { type: 'thought', text: applyChatStreamFilter(w), label: 'filter' });
    }
    const message = inlet.text;
    const explicitMode = normalizeMode(req.mode);
    const hasAttachments = (req.attachments?.length ?? 0) > 0;
    const initialRoute = this.resolveRouting(
      message,
      explicitMode,
      hasAttachments,
    );
    const { automatonText } = initialRoute;
    let { routing } = initialRoute;
    const workspaceAgentAvailable = shouldRunWorkspaceAgent(
      this.configPath,
      this.sessionStore,
      this.projectStore,
      sessionId,
      routing.mode,
      message,
      explicitMode,
    );
    if (routing.mode === 'web_dev' && !workspaceAgentAvailable) {
      routing = { ...routing, mode: 'chat', matched_tool: 'chat' };
    }
    const requestedExecutionPolicy = normalizeExecutionPolicy(
      req.execution_policy,
      this.sessionStore.load(sessionId)?.execution_policy,
    );
    this.sessionStore.setExecutionPolicy(sessionId, requestedExecutionPolicy);
    req = { ...req, execution_policy: requestedExecutionPolicy };

    if (routing.mode === 'automaton_direct') {
      try {
        this.sessionStore.append(sessionId, {
          role: 'user',
          content: message,
          at: new Date().toISOString(),
          mode: routing.mode,
        });
        sseEvent(res, { type: 'status', text: statusLabelForMode('automaton_direct') });
        const full = await this.handleAutomatonDirect(sessionId, routing, automatonText, {
          onStatus: (text) => sseEvent(res, { type: 'status', text }),
          onThought: (text) => sseEvent(res, { type: 'thought', text, label: '작업 로그' }),
        });
        const finalized = await this.finalizeAssistantReply(full.content, sessionId, null);
        sseEvent(res, { type: 'meta', routing: full.routing, model: full.model });
        sseEvent(res, { type: 'token', text: finalized.content });
        sseEvent(res, { type: 'done', model: full.model, mode: full.mode });
      } catch (e: unknown) {
        const msg = formatChatErrorMessage(e);
        this.autoReportError({
          subject: 'MY Agent 오류 [automaton_direct]',
          summary: msg,
          mode: 'automaton_direct',
          rawError: e instanceof Error ? e.message : String(e),
        });
        sseEvent(res, { type: 'error', message: msg });
      } finally {
        sseDone(res);
      }
      return;
    }

    if (
      shouldEnterWorkspaceToolPlane(
        shouldRunWorkspaceAgent(
          this.configPath,
          this.sessionStore,
          this.projectStore,
          sessionId,
          routing.mode,
          message,
          explicitMode,
        ),
        requestedExecutionPolicy,
      )
    ) {
      const agentRouting = promoteWorkspaceAgentRouting(routing);
      let userAppended = false;
      try {
        const resolved = await resolveChatModelAsync(
          req.model,
          this.modelRegistry,
          loadUserOverrides(this.configPath),
          this.providerStore,
          {
            mode: effectiveAutoModelMode(agentRouting.mode, message, this.configPath),
            hasAttachments: (req.attachments?.length ?? 0) > 0,
          },
        );
        this.sessionStore.append(sessionId, {
          role: 'user',
          content: message,
          at: new Date().toISOString(),
          mode: agentRouting.mode,
        });
        userAppended = true;
        sseEvent(res, {
          type: 'status',
          text: requestedExecutionPolicy.workspace_behavior === 'plan'
            ? 'Plan · read-only 설계 (코드 탐색만)'
            : '코드 에이전트 · 도구 실행 중…',
        });
        sseEvent(res, { type: 'meta', routing: agentRouting, model: resolved.display });

        const runAgentOnce = async (attempt = 1) =>
          runWorkspaceCodeAgent({
            cqrRoot: this.cqrRoot,
            configPath: this.configPath,
            sessionStore: this.sessionStore,
            projectStore: this.projectStore,
            providerStore: this.providerStore,
            req,
            sessionId,
            routing: agentRouting,
            resolved,
            message,
            attachmentContext: await buildAttachmentContext(
              req.attachments ?? [],
              this.attachments,
              sessionId,
              12_000,
              { cqrRoot: this.cqrRoot },
            ),
            imageDataUrls: collectAttachmentImageDataUrls(
              req.attachments ?? [],
              this.attachments,
              sessionId,
              { cqrRoot: this.cqrRoot },
            ),
            extraSystemNotes:
              attempt > 1
                ? [
                    [
                      '## Infra retry — prior attempt may have already written disk',
                      'Session meta / Exit Gate may list partial paths. Re-read those paths before re-applying the same patch.',
                      'Close the open Exit Gate; do not cold-start Understanding or full repo diagnosis.',
                    ].join('\n'),
                  ]
                : undefined,
            callbacks: {
              onThought: (text) => sseEvent(res, { type: 'thought', text }),
              onCode: (snippet) => sseEvent(res, { type: 'code', ...snippet }),
              onWorkspaceMutate: (paths) => {
                const clean = (paths ?? [])
                  .map((p) => String(p || '').replace(/\\/g, '/').trim())
                  .filter(Boolean);
                if (!clean.length) return;
                sseEvent(res, { type: 'workspace_mutate', paths: clean });
              },
              onStatus: (text) => sseEvent(res, { type: 'status', text }),
              onToolComplete: (event) => sseEvent(res, { type: 'tool_complete', ...event }),
              onExecutionPolicy: (policy) => sseEvent(res, { type: 'execution_policy', ...policy }),
              // Final-only UX: do not stream partial answer tokens for code agent.
              onAnswer: undefined,
              onToolApproval: async (approvalReq) => {
                const approvalPolicy = requestedExecutionPolicy.approval;
                if (approvalPolicy === 'autopilot' && approvalReq.delegable === true) {
                  sseEvent(res, { type: 'status', text: `Autopilot 승인 · 워크스페이스 안전 범위 — ${approvalReq.summary}` });
                  return true;
                }
                if (approvalPolicy === 'delegate' && approvalReq.delegable === true) {
                  sseEvent(res, { type: 'status', text: `나 대신 승인 · 모델 검토 중 — ${approvalReq.summary}` });
                  const review = await reviewToolApproval({
                    providerStore: this.providerStore,
                    cqrRoot: this.cqrRoot,
                    sessionId,
                    userMessage: message,
                    request: approvalReq,
                    signal,
                  });
                  if (review.decision === 'allow') {
                    sseEvent(res, { type: 'status', text: `나 대신 승인 · ${review.reviewer} · ${Math.round(review.confidence * 100)}%` });
                    return true;
                  }
                  sseEvent(res, { type: 'status', text: `모델 판단 보류 · 사용자 승인 필요 — ${review.reason}` });
                }
                const wait = waitForToolApproval(approvalReq.id, { signal });
                sseEvent(res, {
                  type: 'tool_approval',
                  id: approvalReq.id,
                  tool: approvalReq.tool,
                  summary: approvalReq.summary,
                  args_preview: approvalReq.argsPreview,
                  danger: approvalReq.danger,
                  access: approvalReq.access,
                  targets: approvalReq.targets,
                  expires: approvalReq.expires,
                });
                return wait;
              },
            },
            signal,
          });

        const maxAttempts = 1 + toolPlaneInfraRetryLimit();
        const maxAutoResume = toolPlaneAutoResumeLimit();
        let full: Awaited<ReturnType<typeof runWorkspaceCodeAgent>> | null = null;
        let lastErr: unknown = null;
        let autoResume = 0;
        // Outer loop: infra retries, then silent auto-resume (no user 「이어서」 click).
        while (true) {
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
              if (attempt > 1 || autoResume > 0) {
                const parts = [
                  attempt > 1 ? `재시도 ${attempt}/${maxAttempts}` : null,
                  autoResume > 0 ? `자동 이어하기 ${autoResume}/${maxAutoResume}` : null,
                ].filter(Boolean);
                sseEvent(res, {
                  type: 'status',
                  text: `인프라 복구 — ${parts.join(' · ')}…`,
                });
              }
              full = await runAgentOnce(Math.max(attempt, autoResume > 0 ? 2 : 1));
              lastErr = null;
              break;
            } catch (e: unknown) {
              lastErr = e;
              if (isAbortError(e) || signal?.aborted) break;
              if (attempt < maxAttempts && isInfraLlmFailure(e)) continue;
              break;
            }
          }
          if (!lastErr && full) break;
          if (isAbortError(lastErr) || signal?.aborted) break;
          if (!isInfraLlmFailure(lastErr)) break;
          if (autoResume >= maxAutoResume) break;
          const meta = loadAgentRunMeta(this.cqrRoot, sessionId);
          if (!shouldAutoResumeAfterInfra(meta)) break;
          autoResume += 1;
          full = null;
          lastErr = null;
          sseEvent(res, {
            type: 'status',
            text: `인프라 끊김 — 사용자 조작 없이 자동 이어하기 (${autoResume}/${maxAutoResume})…`,
          });
        }

        if (isAbortError(lastErr) || signal?.aborted) {
          if (userAppended) {
            this.persistToolPlaneFailure(sessionId, agentRouting.mode, {
              formattedError: '(중지됨)',
              kind: 'stopped',
            });
          }
          this.emitStopped(res);
          return;
        }

        if (lastErr || !full) {
          const err = lastErr ?? new Error('코드 에이전트 실패');
          if (isNoWorkspaceBoundError(err)) {
            const content = userAppended
              ? appendAssistantReply(this.sessionStore, sessionId, {
                  content: TOOL_PLANE_NO_WORKSPACE_REFUSAL,
                  model: 'policy/no-workspace',
                  mode: agentRouting.mode,
                  userMessage: message,
                })
              : TOOL_PLANE_NO_WORKSPACE_REFUSAL;
            sseEvent(res, { type: 'content_replace', text: content });
            sseEvent(res, {
              type: 'done',
              model: 'policy/no-workspace',
              mode: agentRouting.mode,
            });
            return;
          }
          const msg = formatChatErrorMessage(err);
          this.autoReportError({
            subject: `MY Agent 오류 [${agentRouting.mode}]`,
            summary: msg,
            mode: agentRouting.mode,
            rawError: err instanceof Error ? err.message : String(err),
          });
          const content = userAppended
            ? this.persistToolPlaneFailure(sessionId, agentRouting.mode, {
                formattedError: msg,
                kind: classifyLlmFailure(err),
              })
            : formatToolPlaneFailureAssistant({
                formattedError: msg,
                kind: classifyLlmFailure(err),
              });
          sseEvent(res, { type: 'content_replace', text: content });
          sseEvent(res, { type: 'done', model: 'policy/tool-plane-failure', mode: agentRouting.mode });
          return;
        }

        const finalized = await this.finalizeAssistantReply(
          full.content,
          sessionId,
          resolved.route.type === 'provider' ? resolved.route.providerId : null,
          { userMessage: message },
        );
        sseEvent(res, { type: 'content_replace', text: finalized.content });
        const donePaths = Array.isArray((full as { mutatedPaths?: string[] }).mutatedPaths)
          ? ((full as { mutatedPaths?: string[] }).mutatedPaths ?? [])
              .map((p) => String(p || '').replace(/\\/g, '/').trim())
              .filter(Boolean)
          : [];
        if (donePaths.length) {
          sseEvent(res, { type: 'workspace_mutate', paths: donePaths });
        }
        const checkpointIdRaw = (full as { checkpointId?: string | null }).checkpointId;
        const checkpointId =
          typeof checkpointIdRaw === 'string' && checkpointIdRaw.trim()
            ? checkpointIdRaw.trim()
            : undefined;
        sseEvent(res, {
          type: 'done',
          model: full.model,
          mode: full.mode,
          ...(donePaths.length ? { mutatedPaths: donePaths } : {}),
          ...(checkpointId ? { checkpointId } : {}),
          ...((full as { planConstraintsLocked?: boolean }).planConstraintsLocked !== undefined
            ? { planConstraintsLocked: (full as { planConstraintsLocked?: boolean }).planConstraintsLocked }
            : {}),
        });
      } catch (e: unknown) {
        if (isAbortError(e) || signal?.aborted) {
          if (userAppended) {
            this.persistToolPlaneFailure(sessionId, agentRouting.mode, {
              formattedError: '(중지됨)',
              kind: 'stopped',
            });
          }
          this.emitStopped(res);
          return;
        }
        if (isNoWorkspaceBoundError(e)) {
          const content = userAppended
            ? appendAssistantReply(this.sessionStore, sessionId, {
                content: TOOL_PLANE_NO_WORKSPACE_REFUSAL,
                model: 'policy/no-workspace',
                mode: agentRouting.mode,
                userMessage: message,
              })
            : TOOL_PLANE_NO_WORKSPACE_REFUSAL;
          sseEvent(res, { type: 'content_replace', text: content });
          sseEvent(res, {
            type: 'done',
            model: 'policy/no-workspace',
            mode: agentRouting.mode,
          });
          return;
        }
        const msg = formatChatErrorMessage(e);
        this.autoReportError({
          subject: `MY Agent 오류 [${agentRouting.mode}]`,
          summary: msg,
          mode: agentRouting.mode,
          rawError: e instanceof Error ? e.message : String(e),
        });
        const content = userAppended
          ? this.persistToolPlaneFailure(sessionId, agentRouting.mode, {
              formattedError: msg,
              kind: classifyLlmFailure(e),
            })
          : formatToolPlaneFailureAssistant({
              formattedError: msg,
              kind: classifyLlmFailure(e),
            });
        sseEvent(res, { type: 'content_replace', text: content });
        sseEvent(res, { type: 'done', model: 'policy/tool-plane-failure', mode: agentRouting.mode });
      } finally {
        sseDone(res);
      }
      return;
    }

    const streamable =
      routing.mode === 'chat' || isStreamableLlmSkillMode(routing.mode);

    if (!streamable) {
      try {
        sseEvent(res, { type: 'status', text: statusLabelForMode(routing.mode) });
        const full = await this.handle(req, sessionId);
        const finalized = await this.finalizeAssistantReply(full.content, sessionId, null, {
          userMessage: message,
        });
        sseEvent(res, { type: 'meta', routing: full.routing, model: full.model });
        sseEvent(res, { type: 'token', text: finalized.content });
        if (full.images?.length) {
          for (const img of full.images) sseEvent(res, { type: 'image', image: img });
        } else if (full.image) {
          sseEvent(res, { type: 'image', image: full.image });
        }
        if (full.research) sseEvent(res, { type: 'research', research: full.research });
        sseEvent(res, { type: 'done', model: full.model, mode: full.mode });
      } catch (e: unknown) {
        const msg = formatChatErrorMessage(e);
        this.autoReportError({
          subject: `MY Agent 오류 [${routing.mode}]`,
          summary: msg,
          mode: routing.mode,
          rawError: e instanceof Error ? e.message : String(e),
        });
        sseEvent(res, { type: 'error', message: msg });
      } finally {
        sseDone(res);
      }
      return;
    }

    const resolved = await resolveChatModelAsync(
      req.model,
      this.modelRegistry,
      loadUserOverrides(this.configPath),
      this.providerStore,
      {
        mode: effectiveAutoModelMode(routing.mode, message, this.configPath),
        hasAttachments: (req.attachments?.length ?? 0) > 0,
      },
    );
    const generalModelId = resolved.route.type === 'provider' ? resolved.route.modelId : null;
    const generalProviderId = resolved.route.type === 'provider' ? resolved.route.providerId : null;
    const effectiveReasoning = generalProviderId
      ? resolveSessionReasoningEffort(requestedExecutionPolicy.reasoning, process.env, {
          providerId: generalProviderId,
          modelId: generalModelId,
        })
      : null;
    sseEvent(res, {
      type: 'execution_policy',
      requested: requestedExecutionPolicy,
      effective: { reasoning: effectiveReasoning, autopilot: false },
    });

    this.sessionStore.append(sessionId, {
      role: 'user',
      content: message,
      at: new Date().toISOString(),
      mode: routing.mode,
    });

    sseEvent(res, { type: 'meta', routing, model: resolved.display });

    const skillMode = resolveLlmSkillMode(routing.mode);
    const histModelId =
      resolved.route.type === 'provider' || resolved.route.type === 'local'
        ? resolved.route.modelId
        : undefined;
    let histBudget = { modelId: histModelId } as ReturnType<typeof buildSessionHistoryBudgetOpts>;
    const systemPrompt = skillMode ? resolveSkillSystemPrompt(skillMode, this.cqrRoot, message) : undefined;
    const attachmentCtx = await buildAttachmentContext(
      req.attachments ?? [],
      this.attachments,
      sessionId,
      12_000,
      { cqrRoot: this.cqrRoot },
    );
    const imageDataUrls = collectAttachmentImageDataUrls(
      req.attachments ?? [],
      this.attachments,
      sessionId,
      { cqrRoot: this.cqrRoot },
    );
    rememberMessagePins(this.cqrRoot, sessionId, message);
     this.autoCaptureMemory(sessionId, message);
    histBudget = buildSessionHistoryBudgetOpts({
      cqrRoot: this.cqrRoot,
      sessionId,
      modelId: histModelId,
      debit: {
        visionImageCount: imageDataUrls.length,
        attachmentChars: attachmentCtx ? String(attachmentCtx).length : 0,
      },
    });
    const willSearch = shouldAutoWebSearch(message, this.cqrRoot, req.web_search === true);
    if (willSearch) {
      sseEvent(res, { type: 'status', text: '웹 검색 중…' });
    } else {
      sseEvent(res, { type: 'status', text: statusLabelForMode(routing.mode) });
    }
    const search = await augmentWithWebSearch(message, this.providerStore, {
      explicit: req.web_search === true,
      cqrRoot: this.cqrRoot,
    });
    if (willSearch && search.applied) {
      sseEvent(res, {
        type: 'status',
        text: `검색 완료 (${search.sourceCount}건) · 답변 생성 중…`,
      });
    } else if (willSearch) {
      sseEvent(res, { type: 'status', text: '답변 생성 중…' });
    }
    const workspaceCtx = buildWorkspaceContext(
      this.configPath,
      this.sessionStore,
      this.projectStore,
      req,
      sessionId,
      routing.mode,
    );
    const hasWorkspaceContext = Boolean(workspaceCtx);
    const mergedCtx = mergeSearchContext(attachmentCtx || undefined, search.context, workspaceCtx || undefined);
    const history = applyHistoryContentBudget(
      sanitizeHistoryForModel(
        this.sessionStore.recentMessages(sessionId, getHistoryTurns(process.env, histBudget)).slice(0, -1),
      ),
      process.env,
      histBudget,
    );
    {
      const { loadAgentRunMeta } = await import('../agent/agent-run-meta.js');
      const snap = loadAgentRunMeta(this.cqrRoot, sessionId).lastContextBudget;
      if (snap) sseEvent(res, { type: 'context_budget', contextBudget: snap });
    }

    let streamedPartial = '';
    try {
      if (resolved.route.type === 'provider') {
        const out = await this.cloudChat.completeStream(
          resolved.route.providerId,
          message,
          mergedCtx || undefined,
          history,
          (text) => {
            streamedPartial += text;
            sseEvent(res, { type: 'token', text });
          },
          systemPrompt ?? undefined,
          {
            modelId: resolved.route.modelId,
            hasWorkspaceContext,
            signal,
            imageDataUrls,
            sessionId,
            reasoningEffort: effectiveReasoning,
          },
        );
        const finalized = await this.finalizeAssistantReply(
          out.content,
          sessionId,
          resolved.route.providerId,
          { userMessage: message },
        );
        if (finalized.content !== out.content) {
          sseEvent(res, { type: 'content_replace', text: finalized.content });
        }
        for (const url of finalized.imageUrls) {
          sseEvent(res, { type: 'image', image: { url } });
        }
        this.sessionStore.append(sessionId, {
          role: 'assistant',
          content: finalized.content,
          at: new Date().toISOString(),
          model: out.model,
          mode: routing.mode,
          image_urls: finalized.imageUrls.length ? finalized.imageUrls : undefined,
        });
        sseEvent(res, {
          type: 'done',
          model: out.model,
          mode: routing.mode,
          web_search: search.applied ? { applied: true, source_count: search.sourceCount } : undefined,
        });
        sseDone(res);
        return;
      }

      if (resolved.route.type === 'local') {
        const out = await this.localChat.completeStream(
          resolved.route.path,
          resolved.route.filename,
          message,
          mergedCtx || undefined,
          history,
          (text) => {
            streamedPartial += text;
            sseEvent(res, { type: 'token', text });
          },
          systemPrompt ?? undefined,
          hasWorkspaceContext,
          signal,
        );
        this.sessionStore.append(sessionId, {
          role: 'assistant',
          content: out.content,
          at: new Date().toISOString(),
          model: out.model,
          mode: routing.mode,
        });
        sseEvent(res, { type: 'done', model: out.model, mode: routing.mode });
        sseDone(res);
        return;
      }

      const content =
        resolved.route.type === 'stub' ? resolved.route.reason : '모델을 선택하세요.';
      sseEvent(res, { type: 'token', text: content });
      this.sessionStore.append(sessionId, {
        role: 'assistant',
        content,
        at: new Date().toISOString(),
        model: resolved.display,
        mode: routing.mode,
      });
      sseEvent(res, { type: 'done', model: resolved.display, mode: routing.mode });
      sseDone(res);
    } catch (e: unknown) {
      if (isAbortError(e) || signal?.aborted) {
        this.savePartialAssistant(sessionId, streamedPartial, routing.mode, 'stopped');
        this.emitStopped(res, streamedPartial);
        return;
      }
      const raw = e instanceof Error ? e.message : String(e);
      if (streamedPartial.trim() && isUpstreamConnectionDrop(raw)) {
        this.savePartialAssistant(sessionId, streamedPartial, routing.mode, 'stopped');
        const msg = formatChatErrorMessage(e);
        sseEvent(res, { type: 'error', message: msg });
        sseEvent(res, { type: 'done', model: resolved.display, mode: routing.mode });
        sseDone(res);
        return;
      }
      const msg = formatChatErrorMessage(e);
      this.autoReportError({
        subject: `MY Agent 오류 [${routing.mode}]`,
        summary: msg,
        mode: routing.mode,
        rawError: raw,
      });
      sseEvent(res, { type: 'error', message: msg });
      sseDone(res);
    }
  }

  private async runChatModel(
    resolved: ResolvedModelRoute,
    message: string,
    ctx: string | undefined,
    history: ReturnType<SessionStore['recentMessages']>,
    systemPrompt?: string,
    hasWorkspaceContext = false,
    imageDataUrls: string[] = [],
    sessionId?: string,
  ): Promise<{ content: string; model: string }> {
    if (resolved.route.type === 'provider') {
      try {
        return await this.cloudChat.complete(
          resolved.route.providerId,
          message,
          ctx,
          history,
          systemPrompt,
          { modelId: resolved.route.modelId, hasWorkspaceContext, imageDataUrls, sessionId },
        );
      } catch (e: unknown) {
        if (e instanceof ProviderError) throw e;
        const note = e instanceof Error ? e.message : String(e);
        return { content: `클라우드 API 오류: ${note}`, model: resolved.display };
      }
    }

    if (resolved.route.type === 'local') {
      try {
        return await this.localChat.complete(
          resolved.route.path,
          resolved.route.filename,
          message,
          ctx,
          history,
          systemPrompt,
          hasWorkspaceContext,
        );
      } catch (e: unknown) {
        const note = e instanceof Error ? e.message : String(e);
        const content =
          note === 'LLAMA_BINARY_MISSING'
            ? `로컬 GGUF 추론 불가: runtime/llama-cpp/llama-server.exe 가 없습니다.\n(${resolved.route.filename})`
            : `로컬 추론 오류: ${note}`;
        return { content, model: resolved.display };
      }
    }

    const content = ctx
      ? `${resolved.route.reason}\n\n[첨부 컨텍스트]\n${ctx.slice(0, 800)}`
      : resolved.route.reason;
    return { content, model: resolved.display };
  }

  /** Auto-capture explicit "remember this" style user messages into user memory (알잘딱). */
  private autoCaptureMemory(sessionId: string, message: string): void {
    try {
      const projectId = resolveMemoryProjectId(this.sessionStore, sessionId);
      getUserMemoryStore(this.dataDir).autoCapture(message, projectId);
    } catch {
      // memory capture must never break the chat flow
    }
  }

  private savePartialAssistant(
    sessionId: string,
    content: string,
    mode: ChatMode,
    model: string,
  ): void {
    const text = content.trim();
    if (!text) return;
    const rec = this.sessionStore.load(sessionId);
    if (rec?.messages[rec.messages.length - 1]?.role === 'assistant') return;
    this.sessionStore.append(sessionId, {
      role: 'assistant',
      content: text,
      at: new Date().toISOString(),
      model,
      mode,
    });
  }

  private persistToolPlaneFailure(
    sessionId: string,
    mode: ChatMode | string,
    opts: {
      formattedError: string;
      kind: ReturnType<typeof classifyLlmFailure> | 'stopped';
    },
  ): string {
    const prev = loadAgentRunMeta(this.cqrRoot, sessionId);
    // Belt-and-suspenders: ensure resume Exit Gate + paths survive even if the
    // agent throw path did not flush (e.g. failure before step loop).
    const meta = persistInterruptedAgentProgress({
      cqrRoot: this.cqrRoot,
      sessionId,
      mutatedPaths: prev.mutatedPaths ?? [],
      readPaths: prev.readPaths ?? [],
    });
    const mutatedPaths = meta.mutatedPaths ?? [];
    const content = formatToolPlaneFailureAssistant({
      formattedError: opts.formattedError,
      mutatedPaths,
      kind: opts.kind,
    });
    return appendAssistantReply(this.sessionStore, sessionId, {
      content,
      model: 'policy/tool-plane-failure',
      mode,
      userMessage: opts.formattedError,
    });
  }

  private emitStopped(res: ServerResponse, partial?: string): void {
    try {
      sseEvent(res, { type: 'stopped', partial: partial?.trim() || undefined });
      sseDone(res);
    } catch {
      /* client disconnected */
    }
  }

  private async finalizeAssistantReply(
    content: string,
    sessionId: string,
    providerId: string | null,
    opts?: { maxImages?: number; userMessage?: string },
  ): Promise<{ content: string; imageUrls: string[] }> {
    const outlet = applyChatOutletFilter(content, {
      sessionId,
      userMessage: opts?.userMessage,
    });
    const scrubbed = outlet.text;
    if (!providerId) return { content: scrubbed, imageUrls: [] };
    return ingestOwuiChatImages({
      content: scrubbed,
      providerStore: this.providerStore,
      providerId,
      sessionId,
      imageOutDir: this.imageOut,
      cqrRoot: this.cqrRoot,
      maxImages: opts?.maxImages,
    });
  }

  getResearchMarkdown(sessionId: string, id: string): string | null {
    const p = path.join(this.cqrRoot, 'data', 'outputs', 'research', sessionId, `${id}.md`);
    if (!existsSync(p)) return null;
    return readFileSync(p, 'utf8');
  }

  getImagePath(sessionId: string, filename: string): string | null {
    const p = path.join(this.imageOut, sessionId, filename);
    if (!existsSync(p)) return null;
    return p;
  }

  getBrowserScreenshotPath(folder: string, filename: string): string | null {
    const safeFolder = folder.trim().replace(/[^a-zA-Z0-9_-]/g, '');
    const safeFile = path.basename(filename);
    if (!safeFolder || !safeFile || safeFile !== filename) return null;
    const p = path.join(this.cqrRoot, 'data', 'outputs', 'browser', safeFolder, safeFile);
    if (!existsSync(p)) return null;
    return p;
  }
}

export { parseChatRequest, normalizeMode } from './chat-request.js';
