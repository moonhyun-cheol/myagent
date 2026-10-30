import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import type { AttachmentService } from '../attachments/attachment-service.js';
import {
  buildAttachmentContext,
  collectAttachmentImageDataUrls,
  resolveAttachmentContextIds,
} from '../attachments/text-extract.js';
import type { ModelRegistry } from '../models/model-registry.js';
import type { ProviderStore } from '../providers/provider-store.js';
import type { SessionStore } from '../sessions/session-store.js';
import { CloudChatService } from '../providers/cloud-chat.js';
import { createLlmUsageCollector, withLlmUsageContext } from '../providers/llm-usage-log.js';
import { ProviderError } from '../providers/types.js';
import type { ChatRequest, ChatResponse, ChatMode, RouteDecision } from '../router/types.js';
import { DeepResearchPipeline } from '../research/deep-research.js';
import { AutoImageBackend } from '../image/image-backend.js';
import { ingestOwuiChatImages } from '../image/owui-media.js';
import type { GeneratedMedia } from '../media/generated-media-extract.js';
import { persistGeneratedImages, unverifiedMediaNotice } from '../media/generated-media-persist.js';
import type { MediaRecord } from '../media/media-store.js';
import type { ApplicationNotice } from '../sessions/types.js';
import { parseProviderPreference, resolveChatModelAsync } from '../models/model-picker.js';
import { composerSelectionRef, prependModelSwitchContext } from './model-switch.js';
import { findVideoModel, type VideoModelDef } from '../video/video-models.js';
import { handleVideoGenMode, retrieveStoredVideoJob, type RetrieveVideoOutcome } from './modes/video-gen.js';
import { initSse, sseEvent, sseDone } from './sse.js';
import { isAbortError, throwIfAborted } from './abort.js';
import { chatRunCanPublish } from './chat-runs.js';
import { LocalChatService } from '../inference/local-chat.js';
import { loadUserOverrides } from '../config/user-overrides.js';
import {
  isSkillChatMode,
  resolveLlmSkillMode,
  resolveSkillSystemPrompt,
  isStreamableLlmSkillMode,
} from '../skills/chat-skill-flow.js';
import { isOrgSkillMode } from '../skills/organization-skill-store.js';
import { isUserSkillMode } from '../skills/user-skill-store.js';
import { formatChatErrorMessage, isUpstreamConnectionDrop } from '../debug-session-log.js';
import { createToolApprovalId, TOOL_APPROVAL_TIMEOUT_MS, waitForToolApproval } from '../agent/tool-approval.js';
import {
  STEP_BUDGET_EXTENSION,
  STEP_BUDGET_MAX_AUTO_GRANTS,
  decideStepBudgetGrant,
  formatElapsedMinutes,
  formatStepBudgetExtensionNote,
  formatStepBudgetResourceLabel,
  formatStepBudgetTimeNote,
  reviewStepBudget,
} from '../agent/step-budget-review.js';
import {
  addAgentUsage,
  agentUsageFromError,
  emptyAgentUsage,
  sumAgentUsage,
  toMessageUsage,
} from '../agent/agent-usage-carry.js';
import { reviewToolApproval } from '../agent/approval-auto-review.js';
import { queueAutoErrorReport } from '../support/error-report-service.js';
import { resolveRequestedModelForSession } from './session-context.js';
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
import {
  buildAutomatonAckContent,
  formatUnsupportedAutomatonBatch,
} from '../automaton/automaton-ack.js';
import { getAutomatonToolEntry } from '../automaton/tool-catalog.js';
import { loadAdapterConnection } from '../automaton/adapter-connection.js';
import { resolveOpenClawAdapterConfig } from '../automaton/openclaw-adapter-client.js';
import { isAutomatonTool } from '../automaton/tool-map.js';
import { buildAutomatonProgressPath } from '../automaton/progress.js';
import { resolveAutomatonRoot } from '../automaton/paths.js';
import { loadDeployDefaults } from '../config/deploy-defaults.js';
import {
  resolveSlashRoute,
  SLASH_COMMAND_UNREGISTERED_MESSAGE,
} from '../router/automaton-intent.js';
import { matchMarketResearchSlash } from '../skills/market-pipeline-capability.js';
import { shouldAutoRouteSizeGuide } from '../skills/size-guide-capability.js';
import { appendBrandManualIfNeeded } from '../providers/brand-manual-context.js';
import { handleMarketResearchMode } from './modes/market-research.js';
import type { ProjectStore } from '../projects/project-store.js';
import { normalizeMode, statusLabelForMode } from './chat-request.js';
import { buildWorkspaceContext } from './session-context.js';
import { handleBrowserAutomationMode } from './modes/browser-automation.js';
import { handleBrowserAgentMode } from './modes/browser-agent.js';
import { handleWebCrawlMode } from './modes/web-crawl.js';
import { handleDeepResearchMode } from './modes/deep-research.js';
import { handleImageGenMode } from './modes/image-gen.js';
import {
  shouldUseWorkspaceAgentRuntime,
  runWorkspaceCodeAgent,
  preserveWorkspaceAgentRouting,
} from './modes/workspace-agent.js';
import { appendAssistantReply } from './assistant-reply.js';
import {
  TOOL_PLANE_NO_WORKSPACE_REFUSAL,
  classifyLlmFailure,
  formatToolPlaneFailureAssistant,
  failureModelLabel,
  failureModelFromError,
  tagFailureModel,
  withFailureModelLine,
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
  /** data/outputs/videos — sibling of imageOut. */
  private readonly videoOut: string;

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
    this.videoOut = path.join(path.dirname(imageOut), 'videos');
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

    // Host-local market research slashes (not Bulbasaur / OpenClaw).
    const marketSlash = matchMarketResearchSlash(message);
    if (marketSlash) {
      return {
        routing: {
          mode: 'org:market_research',
          matched_tool: marketSlash.toolId,
          confidence: 1,
          layer: 'explicit',
        },
        automatonText: marketSlash.commandText,
      };
    }

    // Org + core Automaton slash commands — must pass cqrRoot so org manifest loads.
    const slash = resolveSlashRoute(message, this.cqrRoot);
    if (slash) {
      return {
        routing: slash.routing,
        automatonText: slash.automatonText,
      };
    }

    // Ambient sample-size ask → org:size_guide when the org skill is installed
    // (non-selectable in +; mirrors brand "ask and it works" intent).
    if (shouldAutoRouteSizeGuide(message, this.cqrRoot)) {
      return {
        routing: {
          mode: 'org:size_guide',
          matched_tool: 'size_guide',
          confidence: 0.9,
          layer: 'intent',
        },
        automatonText: message,
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
    const openclaw = resolveOpenclaw();
    if (defaults.openclaw_adapter_base_url?.trim() && !openclaw) {
      throw new Error(
        'OpenClaw URL은 있으나 토큰/bootstrap이 없습니다. adapter-connection.json bootstrap_key, vault token, 또는 OPENCLAW_ADAPTER_TOKEN을 확인하세요.',
      );
    }
    if (!openclaw && !automatonRoot) {
      throw new Error(
        'Automaton not configured — set openclaw_adapter_base_url + bootstrap/token (or data/vault/openclaw-adapter.json), or LIVE_AUTOMATON_ROOT',
      );
    }
    const progressFile = automatonRoot
      ? buildAutomatonProgressPath(automatonRoot, sessionId, tool)
      : undefined;
    const requestId = randomUUID();
    const response = getAutomatonToolEntry(tool, this.cqrRoot)?.response;
    const unsupportedBatch = formatUnsupportedAutomatonBatch(message, response);
    if (unsupportedBatch) {
      this.sessionStore.append(sessionId, {
        role: 'assistant',
        content: unsupportedBatch,
        at: new Date().toISOString(),
        model: `automaton/${tool}`,
        mode: 'automaton_direct',
      });
      return {
        role: 'assistant',
        content: unsupportedBatch,
        mode: 'automaton_direct',
        routing,
        model: `automaton/${tool}`,
      };
    }
    const ack = buildAutomatonAckContent(message, tool, { requestId, response });
    options?.onStatus?.('명령어 접수');
    const beforeLen = this.sessionStore.load(sessionId)?.messages.length ?? 0;
    this.sessionStore.append(sessionId, {
      role: 'assistant',
      content: ack,
      at: new Date().toISOString(),
      model: `automaton/${tool}`,
      mode: 'automaton_direct',
    });
    const statusMessageIndex = beforeLen;
    void this.runAutomatonBackground(sessionId, {
      message,
      tool,
      automatonRoot,
      progressFile,
      openclaw,
      fallbackLocal: defaults.openclaw_fallback_local !== false && Boolean(automatonRoot),
      statusMessageIndex,
      requestId,
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
      statusMessageIndex?: number;
      requestId: string;
    },
  ): Promise<void> {
    const connection = loadAdapterConnection(this.cqrRoot);
    const editExisting = connection?.progress?.edit_existing_message_when_supported !== false;
    const appendWhenUnsupported = connection?.progress?.append_status_when_edit_unsupported !== false;
    let lastPublished = '';
    const publishStatus = (text: string) => {
      const next = text.trim();
      if (!next || next === lastPublished) return;
      lastPublished = next;
      try {
        if (
          editExisting
          && typeof job.statusMessageIndex === 'number'
          && this.sessionStore.updateMessageContent(sessionId, job.statusMessageIndex, next)
        ) {
          return;
        }
        if (appendWhenUnsupported && chatRunCanPublish()) {
          this.sessionStore.append(sessionId, {
            role: 'assistant',
            content: next,
            at: new Date().toISOString(),
            model: `automaton/${job.tool}`,
            mode: 'automaton_direct',
          });
        }
      } catch {
        /* aborted chat run must not kill adapter polling */
      }
    };

    try {
      const result = await dispatchAutomatonTool(job.message, job.tool, job.automatonRoot, {
        progressFile: job.progressFile,
        openclaw: job.openclaw,
        preferRemote: Boolean(job.openclaw),
        fallbackLocal: job.fallbackLocal,
        cqrRoot: this.cqrRoot,
        requestId: job.requestId,
        onStatus: publishStatus,
      });
      if (result?.content?.trim()) {
        const envelopeStatus = String(result.envelope?.status ?? '').trim().toLowerCase();
        const responseProfile = getAutomatonToolEntry(job.tool, this.cqrRoot)?.response?.profile ?? 'auto';
        const failed = Boolean(
          envelopeStatus
          && !['ok', 'success', 'completed', 'accepted', 'queued', 'running'].includes(envelopeStatus),
        );
        // Declarative response profiles own the final user answer. Legacy `auto`
        // commands keep the historical NOPSPro-only success behavior.
        if (failed || responseProfile !== 'auto') publishStatus(result.content);
      }
    } catch (err: unknown) {
      const content = [
        '**업무 명령 실행 실패**',
        '',
        `접수: \`${job.message.trim()}\``,
        err instanceof Error ? err.message : String(err),
      ].join('\n');
      publishStatus(content);
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
    // Model resolution happens inside; errors carry the running model for failure copy.
    let runningModel: string | undefined;
    try {
      return await this.handleResolved(req, sessionId, (m) => {
        runningModel = m;
      });
    } catch (e: unknown) {
      throw tagFailureModel(e, runningModel);
    }
  }

  private async handleResolved(
    req: ChatRequest,
    sessionId: string,
    noteModel: (model: string | undefined) => void,
  ): Promise<ChatResponse> {
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
    const attachmentContextIds = resolveAttachmentContextIds(
      req.attachments ?? [],
      this.sessionStore.load(sessionId)?.messages ?? [],
    );
    const hasAttachments = attachmentContextIds.length > 0;
    const initialRoute = this.resolveRouting(
      message,
      explicitMode,
      hasAttachments,
    );
    const { automatonText } = initialRoute;
    let { routing } = initialRoute;
    const workspaceAgentAvailable = shouldUseWorkspaceAgentRuntime(
      this.configPath,
      this.sessionStore,
      this.projectStore,
      sessionId,
      routing.mode,
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
      resolveRequestedModelForSession(this.sessionStore, this.projectStore, sessionId, req.model),
      this.modelRegistry,
      loadUserOverrides(this.configPath),
      this.providerStore,
      {
        mode: routing.mode,
        hasAttachments,
      },
    );
    noteModel(resolved.display);
    const now = new Date().toISOString();
    this.sessionStore.append(sessionId, { role: 'user', content: message, at: now, mode: routing.mode,
      attachments: this.attachments.messageAttachments(req.attachments ?? [], sessionId) });

    if (routing.mode === 'automaton_direct') {
      // Automaton tools do not run the chat model.
      noteModel(undefined);
      if (routing.feature_required) {
        const content = appendAssistantReply(this.sessionStore, sessionId, {
          content: routing.feature_required.message,
          model: 'automaton/feature_required',
          mode: 'automaton_direct',
        });
        return {
          role: 'assistant',
          content,
          mode: 'automaton_direct',
          routing,
          model: 'automaton/feature_required',
        };
      }
      if (!routing.matched_tool) {
        const content = appendAssistantReply(this.sessionStore, sessionId, {
          content: SLASH_COMMAND_UNREGISTERED_MESSAGE,
          model: 'automaton/unregistered',
          mode: 'automaton_direct',
        });
        return {
          role: 'assistant',
          content,
          mode: 'automaton_direct',
          routing,
          model: 'automaton/unregistered',
        };
      }
      return this.handleAutomatonDirect(sessionId, routing, automatonText);
    }

    // Video models are an explicit model choice (core catalog); org-module gate is enforced inside.
    const videoModel = resolved.route.type === 'provider' ? findVideoModel(resolved.route.modelId) : null;
    if (videoModel) {
      return handleVideoGenMode({
        providerStore: this.providerStore,
        sessionStore: this.sessionStore,
        cqrRoot: this.cqrRoot,
        videoOut: this.videoOut,
        sessionId,
        message,
        routing,
        resolved,
        model: videoModel,
      });
    }

    if (routing.mode === 'org:market_research') {
      noteModel(undefined);
      const pipelineReply = await handleMarketResearchMode({
        cqrRoot: this.cqrRoot,
        sessionStore: this.sessionStore,
        sessionId,
        message,
        routing,
      });
      if (pipelineReply) return pipelineReply;
      // Fall through to org skill LLM chat with CQR_MARKET_INJECT.
      noteModel(resolved.display);
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

    if (routing.mode === 'browser_automation' || routing.mode === 'browser_agent' || routing.mode === 'web_crawl') {
      // These pipelines do not run the selected chat model.
      noteModel(undefined);
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

    if (workspaceAgentAvailable) {
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
          attachmentContextIds,
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
    const systemPrompt = await appendBrandManualIfNeeded(
      this.cqrRoot,
      message,
      skillMode ? resolveSkillSystemPrompt(skillMode, this.cqrRoot, message) ?? undefined : undefined,
    );
    const attachmentCtx = await buildAttachmentContext(
      attachmentContextIds,
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
    histBudget = buildSessionHistoryBudgetOpts({
      cqrRoot: this.cqrRoot,
      sessionId,
      modelId: histModelId,
      debit: {
        visionImageCount: imageDataUrls.length,
        attachmentChars: attachmentCtx ? String(attachmentCtx).length : 0,
      },
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
    const mergedCtx = [attachmentCtx, workspaceCtx].filter(Boolean).join('\n\n');
    const recentForHistory = this.sessionStore
      .recentMessages(sessionId, getHistoryTurns(process.env, histBudget))
      .slice(0, -1);
    const historySource = isOrgSkillMode(routing.mode)
      ? recentForHistory.filter((m) => m.mode === routing.mode)
      : recentForHistory;
    const history = applyHistoryContentBudget(
      sanitizeHistoryForModel(historySource),
      process.env,
      histBudget,
    );
    const modelCtx = prependModelSwitchContext(mergedCtx || undefined, history, resolved.display);

    const chatResult = await this.runChatModel(
      resolved,
      message,
      modelCtx,
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
      { userMessage: message, generated: chatResult.generated_media, model: chatResult.model },
    );

    this.sessionStore.append(sessionId, {
      role: 'assistant',
      content: finalized.content,
      at: new Date().toISOString(),
      model: chatResult.model,
      mode: chatLikeMode,
      image_urls: finalized.imageUrls.length ? finalized.imageUrls : undefined,
      ...(finalized.media.length ? { media: finalized.media } : {}),
      ...(finalized.notice ? { application_notice: finalized.notice } : {}),
      ...(chatResult.usage ? { usage: chatResult.usage } : {}),
    });

    return {
      role: 'assistant',
      content: finalized.content,
      mode: chatLikeMode,
      routing,
      model: chatResult.model,
      image: finalized.imageUrls[0] ? { url: finalized.imageUrls[0] } : undefined,
      images: finalized.imageUrls.map((url) => ({ url })),
    };
  }

  async handleStream(req: ChatRequest, sessionId: string, res: ServerResponse, signal?: AbortSignal): Promise<void> {
    initSse(res);
    this.sessionStore.beginAssistantThought(sessionId);
    const emitThought = (text: string, label?: string) => {
      if (!text) return;
      this.sessionStore.appendAssistantThought(sessionId, text);
      sseEvent(res, { type: 'thought', text, ...(label ? { label } : {}) });
    };
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
      emitThought(applyChatStreamFilter(w), 'filter');
    }
    const message = inlet.text;
    const explicitMode = normalizeMode(req.mode);
    const attachmentContextIds = resolveAttachmentContextIds(
      req.attachments ?? [],
      this.sessionStore.load(sessionId)?.messages ?? [],
    );
    const hasAttachments = attachmentContextIds.length > 0;
    const initialRoute = this.resolveRouting(
      message,
      explicitMode,
      hasAttachments,
    );
    const { automatonText } = initialRoute;
    let { routing } = initialRoute;
    const workspaceAgentAvailable = shouldUseWorkspaceAgentRuntime(
      this.configPath,
      this.sessionStore,
      this.projectStore,
      sessionId,
      routing.mode,
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

    let userAlreadyAppended = false;

    if (routing.mode === 'automaton_direct') {
      try {
        this.sessionStore.append(sessionId, {
          role: 'user',
          content: message,
          at: new Date().toISOString(),
          mode: routing.mode,
          attachments: this.attachments.messageAttachments(req.attachments ?? [], sessionId),
        });
        if (routing.feature_required) {
          const fr = routing.feature_required;
          sseEvent(res, { type: 'meta', routing, model: 'automaton/feature_required' });
          sseEvent(res, { type: 'token', text: fr.message });
          sseEvent(res, { type: 'done', model: 'automaton/feature_required', mode: 'automaton_direct' });
          this.sessionStore.append(sessionId, {
            role: 'assistant',
            content: fr.message,
            at: new Date().toISOString(),
            model: 'automaton/feature_required',
            mode: 'automaton_direct',
          });
          return;
        }
        if (!routing.matched_tool) {
          sseEvent(res, { type: 'meta', routing, model: 'automaton/unregistered' });
          sseEvent(res, { type: 'token', text: SLASH_COMMAND_UNREGISTERED_MESSAGE });
          sseEvent(res, { type: 'done', model: 'automaton/unregistered', mode: 'automaton_direct' });
          this.sessionStore.append(sessionId, {
            role: 'assistant',
            content: SLASH_COMMAND_UNREGISTERED_MESSAGE,
            at: new Date().toISOString(),
            model: 'automaton/unregistered',
            mode: 'automaton_direct',
          });
          return;
        }
        sseEvent(res, { type: 'status', text: statusLabelForMode('automaton_direct') });
        const full = await this.handleAutomatonDirect(sessionId, routing, automatonText, {
          onStatus: (text) => sseEvent(res, { type: 'status', text }),
          onThought: (text) => emitThought(text, '작업 로그'),
        });
        const finalized = await this.finalizeAssistantReply(full.content, sessionId, null);
        sseEvent(res, { type: 'meta', routing: full.routing, model: full.model });
        sseEvent(res, { type: 'token', text: finalized.content });
        sseEvent(res, {
          type: 'done',
          model: full.model,
          mode: full.mode,
          ...(full.applicationNotice ? { applicationNotice: full.applicationNotice } : {}),
        });
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

    const requestedVideo = this.requestedVideoModel(req, sessionId);
    if (requestedVideo) {
      const videoFailModel = failureModelLabel(requestedVideo.id);
      try {
        const resolved = await resolveChatModelAsync(
          resolveRequestedModelForSession(this.sessionStore, this.projectStore, sessionId, req.model),
          this.modelRegistry,
          loadUserOverrides(this.configPath),
          this.providerStore,
          { mode: routing.mode, hasAttachments },
        );
        this.sessionStore.append(sessionId, {
          role: 'user',
          content: message,
          at: new Date().toISOString(),
          mode: routing.mode,
          attachments: this.attachments.messageAttachments(req.attachments ?? [], sessionId),
        });
        sseEvent(res, { type: 'meta', routing, model: requestedVideo.id });
        sseEvent(res, { type: 'status', text: '동영상 생성 중… (수 분 걸릴 수 있습니다)' });
        const full = await handleVideoGenMode({
          providerStore: this.providerStore,
          sessionStore: this.sessionStore,
          cqrRoot: this.cqrRoot,
          videoOut: this.videoOut,
          sessionId,
          message,
          routing,
          resolved,
          model: requestedVideo,
          signal,
          onStatus: (text) => sseEvent(res, { type: 'status', text }),
          onVideoJob: (job) => sseEvent(res, { type: 'video_job', job: { job_id: job.job_id, status: job.status } }),
        });
        sseEvent(res, { type: 'token', text: full.content });
        for (const img of full.images ?? []) sseEvent(res, { type: 'image', image: img });
        sseEvent(res, { type: 'done', model: full.model, mode: full.mode, ...(full.usage ? { usage: full.usage } : {}) });
      } catch (e: unknown) {
        if (isAbortError(e) || (e instanceof Error && e.message === 'VIDEO_ABORTED')) {
          sseEvent(res, { type: 'done', model: '중지됨', mode: routing.mode });
        } else {
          sseEvent(res, { type: 'error', message: withFailureModelLine(formatChatErrorMessage(e), videoFailModel) });
          if (videoFailModel) sseEvent(res, { type: 'done', model: requestedVideo.id, mode: routing.mode });
        }
      } finally {
        sseDone(res);
      }
      return;
    }

    if (routing.mode === 'org:market_research') {
      try {
        this.sessionStore.append(sessionId, {
          role: 'user',
          content: message,
          at: new Date().toISOString(),
          mode: routing.mode,
        });
        userAlreadyAppended = true;
        sseEvent(res, { type: 'status', text: statusLabelForMode('org:market_research') });
        const pipelineReply = await handleMarketResearchMode({
          cqrRoot: this.cqrRoot,
          sessionStore: this.sessionStore,
          sessionId,
          message,
          routing,
        });
        if (pipelineReply) {
          sseEvent(res, { type: 'meta', routing: pipelineReply.routing, model: pipelineReply.model });
          sseEvent(res, { type: 'token', text: pipelineReply.content });
          sseEvent(res, {
            type: 'done',
            model: pipelineReply.model,
            mode: pipelineReply.mode,
            ...(pipelineReply.research ? { research: pipelineReply.research } : {}),
          });
          sseDone(res);
          return;
        }
        // Fall through to skill stream with userAlreadyAppended=true.
      } catch (e: unknown) {
        const msg = formatChatErrorMessage(e);
        sseEvent(res, { type: 'error', message: msg });
        sseDone(res);
        return;
      }
    }

    if (workspaceAgentAvailable) {
      const agentRouting = preserveWorkspaceAgentRouting(routing);
      let userAppended = false;
      // Model actually running this turn — kept so failure/stop replies say which model failed.
      let runModel: string | undefined;
      try {
        const resolved = await resolveChatModelAsync(
          resolveRequestedModelForSession(this.sessionStore, this.projectStore, sessionId, req.model),
          this.modelRegistry,
          loadUserOverrides(this.configPath),
          this.providerStore,
          {
            mode: agentRouting.mode,
            hasAttachments,
          },
        );
        if (!userAlreadyAppended) {
          this.sessionStore.append(sessionId, {
            role: 'user',
            content: message,
            at: new Date().toISOString(),
            mode: agentRouting.mode,
            attachments: this.attachments.messageAttachments(req.attachments ?? [], sessionId),
          });
          userAppended = true;
        } else {
          userAppended = true;
        }
        sseEvent(res, { type: 'status', text: '코드 에이전트 · 도구 실행 중…' });
        runModel = failureModelLabel(resolved.display) || undefined;
        sseEvent(res, { type: 'meta', routing: agentRouting, model: resolved.display });
        // Reply the user just answered (skip this turn's user message). The decision model
        // sees only its tail, and only for fixed-severe approvals such as push.
        const previousAssistantReply = (() => {
          const recent = this.sessionStore.recentMessages(sessionId, 6);
          for (let i = recent.length - 1; i >= 0; i -= 1) {
            if (recent[i].role === 'assistant') return recent[i].content;
          }
          return '';
        })();

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
              attachmentContextIds,
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
            // Retries re-run this same turn: resume stored progress explicitly instead of
            // relying on the original message matching the 「이어서」 wording.
            continuationRetry: attempt > 1,
            callbacks: {
              onThought: (text) => emitThought(text),
              onToolActivity: (activity) => {
                this.sessionStore.appendToolActivity(sessionId, activity);
                sseEvent(res, { type: 'tool_activity', activity });
              },
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
                const fixedSevere = approvalReq.fixedSeverity === 'severe';
                // Network destinations (unrequested site / first user-MCP call) are where web
                // injection exfiltrates data, so Autopilot hands them to the decision model.
                const networkAccess = approvalReq.access === 'network';
                if (approvalPolicy === 'autopilot' && approvalReq.delegable === true && !fixedSevere && !networkAccess) {
                  sseEvent(res, { type: 'status', text: `Autopilot 승인 · 워크스페이스 안전 범위 — ${approvalReq.summary}` });
                  return { approved: true, by: 'policy' };
                }
                // 「나 대신 승인」: read-only tools (external reads, NAS included) cannot
                // damage anything, so they run without spending a decision-model call.
                if (approvalPolicy === 'delegate' && approvalReq.delegable === true && approvalReq.access === 'external_read') {
                  sseEvent(res, { type: 'status', text: `나 대신 승인 · 읽기 전용 — ${approvalReq.summary}` });
                  return { approved: true, by: 'policy' };
                }
                const approvalOverrides = loadUserOverrides(this.configPath);
                // Autopilot still asks the decision model for folder wipes / DB destruction.
                const reviewMode = approvalPolicy === 'delegate' || (approvalPolicy === 'autopilot' && (fixedSevere || networkAccess))
                  ? 'delegate'
                  : approvalPolicy === 'ask' && approvalOverrides.approval_card_triage === true ? 'triage' : null;
                if (reviewMode && approvalReq.delegable === true) {
                  const modeLabel = reviewMode === 'delegate' ? '나 대신 승인' : '승인 카드 선별';
                  sseEvent(res, { type: 'status', text: `${modeLabel} · 판단 모델 검토 중 — ${approvalReq.summary}` });
                  const review = await reviewToolApproval({
                    providerStore: this.providerStore,
                    cqrRoot: this.cqrRoot,
                    sessionId,
                    reviewerPreference: approvalOverrides.approval_reviewer_model,
                    mode: reviewMode,
                    userMessage: message,
                    previousAssistantReply,
                    request: approvalReq,
                    imageDataUrls: collectAttachmentImageDataUrls(
                      req.attachments ?? [],
                      this.attachments,
                      sessionId,
                      { cqrRoot: this.cqrRoot },
                    ),
                    signal,
                  });
                  if (review.decision === 'allow') {
                    const fallbackNote = review.escalated
                      ? ` (${review.escalated === 'image' ? '이미지 첨부' : '긴 맥락'} → 최신 Jev)`
                      : review.fallback ? ' (선택 모델 실패 → 대체 모델)' : '';
                    sseEvent(res, { type: 'status', text: `${modeLabel} · ${review.reviewer}${fallbackNote} · ${Math.round(review.confidence * 100)}%` });
                    return { approved: true, by: 'reviewer', reviewer: review.reviewer };
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
                  timeout_ms: TOOL_APPROVAL_TIMEOUT_MS,
                  session_title: this.sessionStore.load(sessionId)?.title ?? '',
                });
                return wait;
              },
              // A안: reviewer says continue/redirect → 「나 대신 승인」/Autopilot grant +50
              // automatically (max 2 per run); otherwise, or after that, the user is asked.
              onStepBudgetExhausted: async ({ facts, workingModelId, autoGrantsUsed }) => {
                const approvalPolicy = requestedExecutionPolicy.approval;
                const spend = formatStepBudgetResourceLabel(facts.resources, STEP_BUDGET_EXTENSION);
                const spendSuffix = spend ? ` · ${spend}` : '';
                const byTime = facts.trigger === 'time';
                const elapsedMs = facts.elapsedMs ?? 0;
                const elapsedLabel = formatElapsedMinutes(elapsedMs);
                sseEvent(res, { type: 'status', text: byTime
                  ? `작업 ${elapsedLabel} 경과 · ${facts.stepsUsed} 스텝${spendSuffix} · 검토 모델이 진행 상황을 판단 중`
                  : `실행 예산 ${facts.stepLimit} 스텝 도달 · ${elapsedLabel} 경과${spendSuffix} · 검토 모델이 진행 상황을 판단 중` });
                const review = await reviewStepBudget({
                  providerStore: this.providerStore,
                  cqrRoot: this.cqrRoot,
                  sessionId,
                  workingModelId,
                  facts,
                  signal,
                });
                const verdictLabel = review.verdict === 'redirect' ? '방향 수정 후 계속' : review.verdict === 'continue' ? '계속' : '멈춤';
                const grantMode = decideStepBudgetGrant({ review, approvalPolicy, autoGrantsUsed, elapsedMs, trigger: facts.trigger });
                if (grantMode === 'stop') {
                  sseEvent(res, { type: 'status', text: `검토 모델 판단: 멈춤 — ${review.reason}` });
                  return { extend: 0, stopReason: `검토 모델(${review.reviewer}) 판단: 멈춤 (${elapsedLabel} 경과) — ${review.reason}` };
                }
                if (byTime && grantMode === 'auto') {
                  sseEvent(res, { type: 'status', text: `작업 ${elapsedLabel} 경과 · 계속 진행 (자동) · ${verdictLabel} — ${review.reason}` });
                  return { extend: STEP_BUDGET_EXTENSION, auto: true, note: formatStepBudgetTimeNote(review, elapsedMs, 'auto') };
                }
                if (grantMode === 'auto') {
                  sseEvent(res, { type: 'status', text: `추가 ${STEP_BUDGET_EXTENSION} 스텝 자동 승인 (${autoGrantsUsed + 1}/${STEP_BUDGET_MAX_AUTO_GRANTS}) · ${verdictLabel} — ${review.reason}${spendSuffix}` });
                  return { extend: STEP_BUDGET_EXTENSION, auto: true, note: formatStepBudgetExtensionNote(review, STEP_BUDGET_EXTENSION, 'auto') };
                }
                const id = createToolApprovalId();
                const wait = waitForToolApproval(id, { signal });
                const why = review.reviewer === 'unavailable' ? '검토 모델을 쓸 수 없어 직접 확인이 필요합니다' : `검토 모델 판단: ${verdictLabel} — ${review.reason}`;
                sseEvent(res, {
                  type: 'tool_approval',
                  id,
                  tool: 'step_budget',
                  summary: byTime
                    ? `작업을 시작한 지 ${elapsedLabel}이 지났습니다 (${facts.stepsUsed} 스텝). 계속 진행할까요? (${why})${spend ? ` [사용량: ${spend}]` : ''}`
                    : `실행 예산 ${facts.stepLimit} 스텝을 다 썼습니다 (${elapsedLabel} 경과). 추가 ${STEP_BUDGET_EXTENSION} 스텝을 줄까요? (${why})${spend ? ` [사용량: ${spend}]` : ''}`,
                  args_preview: JSON.stringify({
                    trigger: facts.trigger ?? 'steps',
                    elapsed_minutes: Math.round(elapsedMs / 60_000),
                    extend: byTime ? 0 : STEP_BUDGET_EXTENSION,
                    verdict: review.verdict,
                    instruction: review.instruction || undefined,
                    cost_usd_so_far: facts.resources?.costUsd === undefined ? undefined : Number(facts.resources.costUsd.toFixed(4)),
                    est_extension_cost_usd: facts.resources?.costPerStepUsd === undefined ? undefined : Number((facts.resources.costPerStepUsd * STEP_BUDGET_EXTENSION).toFixed(4)),
                    cache_hit_rate: facts.resources ? Number(facts.resources.cacheHitRate.toFixed(3)) : undefined,
                  }).slice(0, 1200),
                  danger: false,
                  access: 'operation',
                  expires: 'once',
                  timeout_ms: TOOL_APPROVAL_TIMEOUT_MS,
                  session_title: this.sessionStore.load(sessionId)?.title ?? '',
                });
                const approved = await wait;
                if (!approved) {
                  return { extend: 0, stopReason: byTime
                    ? `작업 ${elapsedLabel} 경과 후 계속 진행을 승인하지 않아 멈췄습니다.`
                    : '추가 실행 예산을 승인하지 않아 멈췄습니다.' };
                }
                const granted = review.reviewer === 'unavailable' || review.verdict === 'stop_ask_user'
                  ? { ...review, verdict: 'continue' as const, reason: '사용자가 직접 승인했습니다.' }
                  : review;
                return { extend: STEP_BUDGET_EXTENSION, note: byTime
                  ? formatStepBudgetTimeNote(granted, elapsedMs, 'user')
                  : formatStepBudgetExtensionNote(granted, STEP_BUDGET_EXTENSION, 'user') };
              },
            },
            signal,
          });

        const maxAttempts = 1 + toolPlaneInfraRetryLimit();
        const maxAutoResume = toolPlaneAutoResumeLimit();
        let full: Awaited<ReturnType<typeof runWorkspaceCodeAgent>> | null = null;
        let lastErr: unknown = null;
        let autoResume = 0;
        // Tokens spent by attempts that threw (infra retry / auto-resume / abort).
        const carriedUsage = emptyAgentUsage();
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
              addAgentUsage(carriedUsage, agentUsageFromError(e));
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
          const stoppedUsage = toMessageUsage(
            full
              ? sumAgentUsage(carriedUsage, loadAgentRunMeta(this.cqrRoot, sessionId).lastPerf?.usage)
              : carriedUsage,
          );
          if (userAppended) {
            this.persistToolPlaneFailure(sessionId, agentRouting.mode, {
              formattedError: '(중지됨)',
              kind: 'stopped',
              model: runModel,
              selected_model: composerSelectionRef(req.model),
            });
            if (stoppedUsage) this.sessionStore.setLastAssistantUsage(sessionId, stoppedUsage);
          }
          this.emitStopped(res, undefined, stoppedUsage);
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
                model: runModel,
                selected_model: composerSelectionRef(req.model),
              })
            : formatToolPlaneFailureAssistant({
                formattedError: msg,
                kind: classifyLlmFailure(err),
                model: runModel,
              });
          const failedUsage = toMessageUsage(carriedUsage);
          if (userAppended && failedUsage) this.sessionStore.setLastAssistantUsage(sessionId, failedUsage);
          sseEvent(res, { type: 'content_replace', text: content });
          sseEvent(res, {
            type: 'done',
            model: runModel ?? 'policy/tool-plane-failure',
            mode: agentRouting.mode,
            ...(failedUsage ? { usage: failedUsage } : {}),
          });
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
        const lastUsage = loadAgentRunMeta(this.cqrRoot, sessionId).lastPerf?.usage;
        const lastProcessedTokens = lastUsage
          ? Math.max(0, (lastUsage.prompt_tokens ?? 0) + (lastUsage.completion_tokens ?? 0))
          : undefined;
        // Include tokens from earlier attempts that threw before this one succeeded.
        const agentUsage = toMessageUsage(sumAgentUsage(carriedUsage, lastUsage));
        if (agentUsage) this.sessionStore.setLastAssistantUsage(sessionId, agentUsage);
        const applicationNotice = (full as { applicationNotice?: import('../sessions/types.js').ApplicationNotice }).applicationNotice;
        sseEvent(res, {
          type: 'done',
          model: full.model,
          mode: full.mode,
          ...(applicationNotice ? { applicationNotice } : {}),
          ...(agentUsage ? { usage: agentUsage } : {}),
          ...(lastProcessedTokens !== undefined ? { lastProcessedTokens } : {}),
          ...(donePaths.length ? { mutatedPaths: donePaths } : {}),
          ...(checkpointId ? { checkpointId } : {}),
        });
      } catch (e: unknown) {
        const thrownUsage = toMessageUsage(agentUsageFromError(e));
        if (isAbortError(e) || signal?.aborted) {
          if (userAppended) {
            this.persistToolPlaneFailure(sessionId, agentRouting.mode, {
              formattedError: '(중지됨)',
              kind: 'stopped',
              model: runModel,
              selected_model: composerSelectionRef(req.model),
            });
            if (thrownUsage) this.sessionStore.setLastAssistantUsage(sessionId, thrownUsage);
          }
          this.emitStopped(res, undefined, thrownUsage);
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
              model: runModel,
              selected_model: composerSelectionRef(req.model),
            })
          : formatToolPlaneFailureAssistant({
              formattedError: msg,
              kind: classifyLlmFailure(e),
              model: runModel,
            });
        if (userAppended && thrownUsage) this.sessionStore.setLastAssistantUsage(sessionId, thrownUsage);
        sseEvent(res, { type: 'content_replace', text: content });
        sseEvent(res, {
          type: 'done',
          model: runModel ?? 'policy/tool-plane-failure',
          mode: agentRouting.mode,
          ...(thrownUsage ? { usage: thrownUsage } : {}),
        });
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
        sseEvent(res, { type: 'done', model: full.model, mode: full.mode, ...(full.usage ? { usage: full.usage } : {}) });
      } catch (e: unknown) {
        const msg = formatChatErrorMessage(e);
        // One-shot modes resolve the model inside handle(); it rides on the error.
        const oneShotFailModel = failureModelFromError(e);
        this.autoReportError({
          subject: `MY Agent 오류 [${routing.mode}]`,
          summary: msg,
          mode: routing.mode,
          rawError: e instanceof Error ? e.message : String(e),
        });
        sseEvent(res, { type: 'error', message: withFailureModelLine(msg, oneShotFailModel) });
        if (oneShotFailModel) sseEvent(res, { type: 'done', model: oneShotFailModel, mode: routing.mode });
      } finally {
        sseDone(res);
      }
      return;
    }

    const resolved = await resolveChatModelAsync(
      resolveRequestedModelForSession(this.sessionStore, this.projectStore, sessionId, req.model),
      this.modelRegistry,
      loadUserOverrides(this.configPath),
      this.providerStore,
      {
        mode: routing.mode,
        hasAttachments,
      },
    );
    const generalModelId = resolved.route.type === 'provider' ? resolved.route.modelId : null;
    const generalProviderId = resolved.route.type === 'provider' ? resolved.route.providerId : null;
    const effectiveReasoning = generalProviderId
      ? resolveSessionReasoningEffort(requestedExecutionPolicy.reasoning, process.env, {
          providerId: generalProviderId,
          modelId: generalModelId,
          userMessage: message,
        })
      : null;
    sseEvent(res, {
      type: 'execution_policy',
      requested: requestedExecutionPolicy,
      effective: { reasoning: effectiveReasoning, autopilot: false },
    });

    if (!userAlreadyAppended) {
      this.sessionStore.append(sessionId, {
        role: 'user',
        content: message,
        at: new Date().toISOString(),
        mode: routing.mode,
        attachments: this.attachments.messageAttachments(req.attachments ?? [], sessionId),
      });
    }

    sseEvent(res, { type: 'meta', routing, model: resolved.display });

    const skillMode = resolveLlmSkillMode(routing.mode);
    const histModelId =
      resolved.route.type === 'provider' || resolved.route.type === 'local'
        ? resolved.route.modelId
        : undefined;
    let histBudget = { modelId: histModelId } as ReturnType<typeof buildSessionHistoryBudgetOpts>;
    const systemPrompt = await appendBrandManualIfNeeded(
      this.cqrRoot,
      message,
      skillMode ? resolveSkillSystemPrompt(skillMode, this.cqrRoot, message) ?? undefined : undefined,
    );
    const attachmentCtx = await buildAttachmentContext(
      attachmentContextIds,
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
    histBudget = buildSessionHistoryBudgetOpts({
      cqrRoot: this.cqrRoot,
      sessionId,
      modelId: histModelId,
      debit: {
        visionImageCount: imageDataUrls.length,
        attachmentChars: attachmentCtx ? String(attachmentCtx).length : 0,
      },
    });
    sseEvent(res, { type: 'status', text: statusLabelForMode(routing.mode) });
    const workspaceCtx = buildWorkspaceContext(
      this.configPath,
      this.sessionStore,
      this.projectStore,
      req,
      sessionId,
      routing.mode,
    );
    const hasWorkspaceContext = Boolean(workspaceCtx);
    const mergedCtx = [attachmentCtx, workspaceCtx].filter(Boolean).join('\n\n');
    const recentForHistory = this.sessionStore
      .recentMessages(sessionId, getHistoryTurns(process.env, histBudget))
      .slice(0, -1);
    const historySource = isOrgSkillMode(routing.mode)
      ? recentForHistory.filter((m) => m.mode === routing.mode)
      : recentForHistory;
    const history = applyHistoryContentBudget(
      sanitizeHistoryForModel(historySource),
      process.env,
      histBudget,
    );
    const modelCtx = prependModelSwitchContext(mergedCtx || undefined, history, resolved.display);
    {
      const { loadAgentRunMeta } = await import('../agent/agent-run-meta.js');
      const snap = loadAgentRunMeta(this.cqrRoot, sessionId).lastContextBudget;
      if (snap) sseEvent(res, { type: 'context_budget', contextBudget: snap });
    }

    let streamedPartial = '';
    try {
      if (resolved.route.type === 'provider') {
        const { providerId, modelId } = resolved.route;
        // Usage log: session/provider for plain chat streams (image models chosen in chat included).
        const usageCollector = createLlmUsageCollector();
        const out = await withLlmUsageContext({ cqrRoot: this.cqrRoot, sessionId, providerId, collect: usageCollector.collect }, () => this.cloudChat.completeStream(
          providerId,
          message,
          modelCtx,
          history,
          (text) => {
            streamedPartial += text;
            sseEvent(res, { type: 'token', text });
          },
          systemPrompt ?? undefined,
          {
            modelId,
            hasWorkspaceContext,
            signal,
            imageDataUrls,
            sessionId,
            reasoningEffort: effectiveReasoning,
            onThought: (text) => emitThought(text, '모델 추론'),
          },
        ));
        const finalized = await this.finalizeAssistantReply(
          out.content,
          sessionId,
          resolved.route.providerId,
          { userMessage: message, generated: out.generated_media, model: out.model },
        );
        if (finalized.content !== out.content) {
          sseEvent(res, { type: 'content_replace', text: finalized.content });
        }
        for (const url of finalized.imageUrls) {
          sseEvent(res, { type: 'image', image: { url } });
        }
        // Image models picked in plain chat: show the billed cost under the bubble like image mode.
        const replyCost = finalized.imageUrls.length || finalized.media.length ? usageCollector.result()?.cost_usd : undefined;
        const replyUsage = replyCost !== undefined ? { ...(out.usage ?? {}), cost_usd: replyCost } : out.usage;
        this.sessionStore.append(sessionId, {
          role: 'assistant',
          content: finalized.content,
          at: new Date().toISOString(),
          model: out.model,
          ...(composerSelectionRef(req.model) ? { selected_model: composerSelectionRef(req.model) } : {}),
          mode: routing.mode,
          image_urls: finalized.imageUrls.length ? finalized.imageUrls : undefined,
          ...(finalized.media.length ? { media: finalized.media } : {}),
          ...(finalized.notice ? { application_notice: finalized.notice } : {}),
          ...(replyUsage ? { usage: replyUsage } : {}),
        });
        sseEvent(res, {
          type: 'done',
          model: out.model,
          mode: routing.mode,
          ...(replyUsage ? { usage: replyUsage } : {}),
          ...(finalized.notice ? { applicationNotice: finalized.notice } : {}),
        });
        sseDone(res);
        return;
      }

      if (resolved.route.type === 'local') {
        const out = await this.localChat.completeStream(
          resolved.route.path,
          resolved.route.filename,
          message,
          modelCtx,
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
          ...(composerSelectionRef(req.model) ? { selected_model: composerSelectionRef(req.model) } : {}),
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
      // Model that was running when the general chat stream failed/stopped (display ref).
      const failModel = failureModelLabel(resolved.display);
      if (isAbortError(e) || signal?.aborted) {
        this.savePartialAssistant(sessionId, streamedPartial, routing.mode, failModel || 'stopped');
        this.emitStopped(res, streamedPartial);
        return;
      }
      const raw = e instanceof Error ? e.message : String(e);
      if (streamedPartial.trim() && isUpstreamConnectionDrop(raw)) {
        this.savePartialAssistant(sessionId, streamedPartial, routing.mode, failModel || 'stopped');
        const msg = withFailureModelLine(formatChatErrorMessage(e), failModel);
        sseEvent(res, { type: 'error', message: msg });
        sseEvent(res, { type: 'done', model: resolved.display, mode: routing.mode });
        sseDone(res);
        return;
      }
      const baseMsg = formatChatErrorMessage(e);
      this.autoReportError({
        subject: `MY Agent 오류 [${routing.mode}]`,
        summary: baseMsg,
        mode: routing.mode,
        rawError: raw,
      });
      sseEvent(res, { type: 'error', message: withFailureModelLine(baseMsg, failModel) });
      if (failModel) sseEvent(res, { type: 'done', model: resolved.display, mode: routing.mode });
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
  ): Promise<{
    content: string;
    model: string;
    usage?: { input_tokens?: number; output_tokens?: number };
    generated_media?: GeneratedMedia;
  }> {
    if (resolved.route.type === 'provider') {
      try {
        const { providerId, modelId } = resolved.route;
        return await withLlmUsageContext({ cqrRoot: this.cqrRoot, sessionId, providerId }, () => this.cloudChat.complete(
          providerId,
          message,
          ctx,
          history,
          systemPrompt,
          { modelId, hasWorkspaceContext, imageDataUrls, sessionId },
        ));
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
      model?: string;
      selected_model?: string;
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
      model: opts.model,
    });
    return appendAssistantReply(this.sessionStore, sessionId, {
      content,
      // Real model when known so the reply header / premium badge show what failed.
      model: opts.model || 'policy/tool-plane-failure',
      ...(opts.selected_model ? { selected_model: opts.selected_model } : {}),
      mode,
      userMessage: opts.formattedError,
    });
  }

  private emitStopped(
    res: ServerResponse,
    partial?: string,
    usage?: { input_tokens: number; output_tokens: number },
  ): void {
    try {
      sseEvent(res, { type: 'stopped', partial: partial?.trim() || undefined, ...(usage ? { usage } : {}) });
      sseDone(res);
    } catch {
      /* client disconnected */
    }
  }

  private async finalizeAssistantReply(
    content: string,
    sessionId: string,
    providerId: string | null,
    opts?: { maxImages?: number; userMessage?: string; generated?: GeneratedMedia; model?: string },
  ): Promise<{ content: string; imageUrls: string[]; media: MediaRecord[]; notice?: ApplicationNotice }> {
    const outlet = applyChatOutletFilter(content, {
      sessionId,
      userMessage: opts?.userMessage,
    });
    const scrubbed = outlet.text;
    if (!providerId) return { content: scrubbed, imageUrls: [], media: [] };
    const owui = await ingestOwuiChatImages({
      content: scrubbed,
      providerStore: this.providerStore,
      providerId,
      sessionId,
      imageOutDir: this.imageOut,
      cqrRoot: this.cqrRoot,
      maxImages: opts?.maxImages,
    });
    if (!opts?.generated) return owui;
    // Images carried as structured provider output (not text) — CQR_PA image-missing P0.
    const persisted = persistGeneratedImages(opts.generated, {
      imageOutDir: this.imageOut,
      sessionId,
      cqrRoot: this.cqrRoot,
      knownSha256: owui.media.map((m) => m.sha256),
      maxImages: opts.maxImages,
      model: opts.model,
    });
    const media = [...owui.media, ...persisted.media];
    const notice = unverifiedMediaNotice(persisted, opts.model);
    let text = owui.content;
    if (!text.trim() && !media.length) {
      text = '모델이 글 없이 생성 결과만 보냈지만 파일로 저장하지 못했습니다.';
    }
    return {
      content: text,
      imageUrls: media.map((m) => m.url),
      media,
      ...(notice ? { notice } : {}),
    };
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

  getVideoPath(sessionId: string, filename: string): string | null {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId) || !/^[A-Za-z0-9-]+\.(mp4|webm)$/.test(filename)) return null;
    const p = path.join(this.videoOut, sessionId, filename);
    if (!existsSync(p)) return null;
    return p;
  }

  /** 「결과 다시 받기」 for a stored provider video job (status check + download only). */
  retrieveVideoJob(sessionId: string, jobId: string): Promise<RetrieveVideoOutcome> {
    return retrieveStoredVideoJob({
      providerStore: this.providerStore,
      sessionStore: this.sessionStore,
      cqrRoot: this.cqrRoot,
      videoOut: this.videoOut,
      sessionId,
      jobId,
    });
  }

  /** Requested model (session/explicit) when it is a core-catalog video model. */
  private requestedVideoModel(req: ChatRequest, sessionId: string): VideoModelDef | null {
    const pref = resolveRequestedModelForSession(this.sessionStore, this.projectStore, sessionId, req.model);
    const parsed = pref ? parseProviderPreference(pref) : null;
    return findVideoModel(parsed?.modelId);
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
