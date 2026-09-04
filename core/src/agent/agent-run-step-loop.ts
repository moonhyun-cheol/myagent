/**
 * Agent tool/model step loop (extracted from agent-run-loop).
 * Mutates `state` in place — same control flow as the former inline while-loop.
 */
import {
  clearClientToolProtocol,
  rememberClientToolProtocol,
  type ToolCompletionResult,
} from '../providers/openai-compatible.js';
import { throwIfAborted } from '../chat/abort.js';
import {
  executeAgentTool,
  normalizeToolCall,
  parseClientToolCalls,
  enrichClientToolCalls,
  contentLooksLikeToolMimic,
  stripToolMimeticNoise,
  toolStatusLabel,
  type AgentToolCall,
} from './tools.js';
import { parseToolArgs, unreadPathsFromReadBeforeWriteError, WorkspaceReadGate } from './tool-read-gate.js';
import {
  contentClaimsStaleShellTitleBar,
  defaultUiReadFallback,
  resolveUiBootstrapPath,
  SHELL_WINDOW_PATH,
  toolCallReadOrList,
  UI_TARGET_MAP_PATH,
  UI_TASK_RE,
  UI_TITLEBAR_RE,
} from './agent-ui-bootstrap.js';

import {
  awaitWithWaitStatus,
  formatAgentPhaseStatus,
} from './agent-status-report.js';
import {
  completeAgentStepClientProtocol,
  completeAgentAnswerStep,
  completeAgentStepWithProtocol,
  contentIsInspectAnswerSynthFailure,
} from './agent-llm-step.js';
import { extractUncOrDrivePaths } from './path-hints.js';
import { normalizeAgentPath, collectReadPathsFromMessages } from './agent-grounding.js';
import { diagnosticsEvidenceStatus } from './agent-outcome-gate.js';
import { formatLockedConstraintsSystemNote } from './agent-locked-constraints.js';
import {
  formatToolSelfCorrection,
  isRecoverableToolFailure,
} from './tool-self-correction.js';
import { applyToolSchemaCompat } from './tool-schema-compat.js';
import {
  createToolLoopGuard,
  formatLoopGuardStop,
  formatLoopGuardUserMessage,
  formatSoftExplorationLoopCorrection,
  isSoftLoopGuardStop,
} from './tool-loop-guard.js';
import {
  canDelegateToolApproval,
  createToolApprovalId,
  formatApprovalDenied,
  needsHumanApproval,
} from './tool-approval.js';
import {
  formatSyntaxBrokenRepairPrompt,
  toolOutputHasSyntaxBroken,
} from './agent-post-mutate-syntax.js';
import { isHookStop } from './agent-hooks.js';
import {
  scrubAgentChannelLeak,
  looksLikeTruncatedAssistantReply,
} from '../chat/chat-filters.js';
import {
  isMutatingAgentTool,
  parseVerifyJson,
  recordVerifyWitness,
} from './verify-loop.js';
import {
  getCodeAgentToolNamesFromTools,
} from './agent-tool-registry.js';
import {
  clearOldCheckpoints,
  createWorkspaceCheckpoint,
} from './agent-checkpoint.js';
import { appendAgentAuditEvent } from './agent-audit-ledger.js';
import type { CodeAgentResult } from './agent-run-types.js';
import {
  collectAutoCheckpointPaths,
  estimateChatPayloadChars,
  extractToolCodeSnippet,
  isOwuiOrGatewayError,
  lastSuccessfulReadPath,
  messagesHadToolRole,
  pushToolResultMessage,
  shrinkMessagesForInfraRetry,
  trimSnippet,
  truncateToolResultForLlm,
  runWithToolBudget,
} from './agent-run-helpers.js';
import { agentToolOutputOk, summarizeAgentToolResult } from './agent-tool-result.js';
import { summarizeResponsesPerfState } from './agent-perf-metrics.js';
import type { AgentRunStepState } from './agent-run-step-state.js';
import { AgentInfraError } from './agent-failure-plane.js';

import {
  buildAgentProgressCheckpoint,
  FAILURE_CHECKPOINT_THRESHOLD,
  formatAgentProgressCheckpointPrompt,
  formatProgressiveBudgetNotice,
  MAX_PROGRESSIVE_TOTAL_ROUNDS,
  PROGRESSIVE_STAGE_ROUNDS,
  progressiveStageForStep,
  type ProgressCheckpointReason,
} from './agent-progress-checkpoint.js';
import {
  loadAgentRunMeta,
  recordSessionProgressCheckpoint,
} from './agent-run-meta.js';

import {
  isParallelReadOnlyTool,
  resolveAgentReadParallelism,
  runParallelToolCalls,
} from './agent-tool-parallel.js';

function noteFirstTool(state: AgentRunStepState): void {
  if (state.firstToolMs == null && state.runStartedAt > 0) {
    state.firstToolMs = Math.max(0, Date.now() - state.runStartedAt);
  }
}

function recoveryToolProtocol(state: AgentRunStepState): 'api' | 'client' {
  return state.nativeToolsLocked ? 'api' : 'client';
}

export async function runAgentStepLoop(state: AgentRunStepState): Promise<CodeAgentResult> {
  return runWithToolBudget({ modelId: state.modelId }, () => runAgentStepLoopInner(state));
}

async function runAgentStepLoopInner(state: AgentRunStepState): Promise<CodeAgentResult> {
  let toolFailuresSinceCheckpoint = 0;
  const cumulativeSteps = (): number => Math.min(
    MAX_PROGRESSIVE_TOTAL_ROUNDS,
    state.priorSteps + state.steps,
  );
  const writeProgressCheckpoint = (
    reason: ProgressCheckpointReason,
    injectForNextRound: boolean,
  ) => {
    const activeTask = loadAgentRunMeta(state.opts.cqrRoot, state.opts.sessionId).activeTask ?? null;
    const recentFailures = state.toolTrace
      .filter((entry) => !entry.ok)
      .slice(-FAILURE_CHECKPOINT_THRESHOLD)
      .map((entry) => `${entry.name}: ${entry.failure_type ?? `step ${entry.step}`}`);
    const recentActivity = state.toolTrace
      .slice(-8)
      .map((entry) => `${entry.name}: ${entry.ok ? 'ok' : entry.failure_type ?? 'failed'} (step ${entry.step})`);
    const checkpoint = buildAgentProgressCheckpoint({
      reason,
      step: cumulativeSteps(),
      maxSteps: MAX_PROGRESSIVE_TOTAL_ROUNDS,
      failureCount: toolFailuresSinceCheckpoint,
      readPaths: [...state.successfulReadsThisRun],
      mutatedPaths: [...state.mutatedPathsThisRun, ...state.sessionMutatedPaths],
      toolsUsed: [...state.toolsUsedThisRun],
      failureDetails: recentFailures,
      verifyWitness: state.verifyWitness,
      activeTask,
      modelOutput: state.lastModelOutput || state.answerBuf.trim(),
      model: state.lastModel,
      elapsedMs: state.priorElapsedMs + (Date.now() - state.runStartedAt),
      payloadChars: estimateChatPayloadChars(state.messages),
      recentActivity,
    });
    recordSessionProgressCheckpoint(state.opts.cqrRoot, state.opts.sessionId, checkpoint);
    state.persistLiveSessionMeta();
    state.reportStatus(
      reason === 'three_failures'
        ? `중간 정리 · 실패 ${FAILURE_CHECKPOINT_THRESHOLD}회 누적 — 재개 지점 재설정`
        : `중간 정리 · ${checkpoint.stage}/${checkpoint.maxStages}단계 — 진행 내역 확인`,
    );
    if (injectForNextRound) {
      state.messages.push({
        role: 'user',
        content: formatAgentProgressCheckpointPrompt(checkpoint),
      });
    }
    return checkpoint;
  };

  const withApiTimeout = <T extends object>(opts: T): T & { timeoutMs?: number } => {
    if (state.toolProtocol === 'api' && state.apiToolsTimeoutMs) {
      return { ...opts, timeoutMs: state.apiToolsTimeoutMs };
    }
    return opts;
  };

  // Pre-model status so UI is never silent while first LLM round is in flight (P1.1).
  if (state.steps === 0) {
    state.reportStatus(
      state.toolProtocol === 'client'
        ? '에이전트 시작 · TEXT TOOL_CALL'
        : state.apiToolsTimeoutMs
          ? `에이전트 시작 · API tools probe (${Math.round(state.apiToolsTimeoutMs / 1000)}s)`
          : '에이전트 시작 · 모델 호출',
    );
  }

  while (state.steps < state.maxSteps) {
    throwIfAborted(state.opts.signal);
    state.steps += 1;
    state.thoughtBuf = '';
    state.answerBuf = '';
    const payloadChars = estimateChatPayloadChars(state.messages);
    const payloadKb = Math.max(1, Math.round(payloadChars / 1024));
    const modelWaitLabel = formatAgentPhaseStatus({
      step: state.steps,
      providerLabel: state.def.name,
      payloadKb,
      kind: state.toolProtocol === 'client'
          ? 'client'
          : 'model',
      detail:
        state.toolProtocol === 'client'
          ? 'TEXT TOOL_CALL'
          : state.toolProtocol === 'api'
            ? '네이티브 tools'
            : undefined,
    });
    const waitForModel = async <T,>(label: string, work: () => Promise<T>): Promise<T> => {
      const t0 = Date.now();
      const responsesBefore = summarizeResponsesPerfState(state.opts.responsesState);
      try {
        try {
          return await awaitWithWaitStatus(state.reportStatus, label, work, state.opts.signal);
        } catch (e: unknown) {
          // Same-step infra retry after shrinking payload — avoids dumping 504 to the user
          // when OWUI choked on a fat tool transcript mid-loop.
          if (!isOwuiOrGatewayError(e) || state.opts.signal?.aborted) throw e;
          const dropped = shrinkMessagesForInfraRetry(state.messages);
          const afterKb = Math.max(1, Math.round(estimateChatPayloadChars(state.messages) / 1024));
          state.reportStatus(
            `${label} · 인프라 타임아웃 → 컨텍스트 축소(-${Math.round(dropped / 1024)}KB→${afterKb}KB) 재시도…`,
          );
          return await awaitWithWaitStatus(
            state.reportStatus,
            `${label} · infra-retry`,
            work,
            state.opts.signal,
          );
        }
      } finally {
        const durationMs = Date.now() - t0;
        state.llmRoundTrips += 1;
        state.llmCompletionMs += durationMs;
        if (state.llmTrace.length < 60) {
          const responsesAfter = summarizeResponsesPerfState(state.opts.responsesState);
          state.llmTrace.push({
            step: state.steps,
            label: label.slice(0, 80),
            duration_ms: durationMs,
            wire_api: state.opts.wireApi ?? 'chat_completions',
            responses_before: responsesBefore,
            responses_after: responsesAfter,
            responses_chain_advanced: Boolean(
              responsesAfter
              && (
                responsesAfter.next_message_index !== responsesBefore?.next_message_index
                || responsesAfter.replay_item_count !== responsesBefore?.replay_item_count
                || responsesAfter.has_previous_response_id !== responsesBefore?.has_previous_response_id
              )
            ),
          });
        }
      }
    };

    const beforeModel = await state.hooks.beforeModel?.({ step: state.steps, messageCount: state.messages.length });
    if (isHookStop(beforeModel)) {
      state.hooks.onEvent?.({ type: 'hook_stop', reason: beforeModel.reason, phase: 'beforeModel' });
      return state.finish({ content: `Agent stopped: ${beforeModel.reason}`, model: state.lastModel, steps: state.steps });
    }
    state.hooks.onEvent?.({ type: 'model_start', step: state.steps });

    const streamAnswer = true;
    const publishModelThought = (delta: string) => {
      state.thoughtBuf += delta;
      state.publishThoughtPanel();
    };
    const publishModelAnswer = (delta: string) => {
      state.answerBuf += delta;
      // Main chat bubble: only stream when this step is an answer turn (not tool-first).
      if (streamAnswer) state.opts.onAnswer?.(delta);
    };
    // Always mirror Open WebUI content into the thought panel (even on tool-first state.steps).
    const streamHandlers = {
      onThought: publishModelThought,
      onContent: publishModelAnswer,
    };

    let result: ToolCompletionResult;

    if (state.toolProtocol === 'client') {
      result = await waitForModel(modelWaitLabel, () =>
        completeAgentStepClientProtocol(
          state.baseUrl,
          state.secret.api_key,
          state.modelId,
          state.messages,
          state.opts,
          state.toolNames,
        ),
      );
    } else {
      const step = await waitForModel(modelWaitLabel, () =>
        completeAgentStepWithProtocol(
          state.toolProtocol,
          state.baseUrl,
          state.secret.api_key,
          state.modelId,
          state.messages,
          state.opts,
          state.agentTools,
          state.toolNames,
          withApiTimeout({
            streamHandlers,
            stream: true,
            // The model decides whether a native tool is needed. Completion is
            // judged from tool/disk/diagnostic evidence later; prose never forces
            // a second tool-call turn.
            toolChoice: 'auto' as const,
          }),
          state.protocolCacheKey,
        ),
      );
      result = step.result;
      if (step.protocol !== state.toolProtocol) state.toolProtocol = step.protocol;
    }

    state.lastModel = `${state.def.name}/${result.model}`;
    if (result.content?.trim()) {
      state.lastModelOutput = result.content.trim();
    }
    if (result.usage) {
      state.llmUsage.prompt_tokens += result.usage.prompt_tokens ?? 0;
      state.llmUsage.completion_tokens += result.usage.completion_tokens ?? 0;
      state.llmUsage.reasoning_tokens += result.usage.reasoning_tokens ?? 0;
      state.llmUsage.cached_tokens += result.usage.cached_tokens ?? 0;
      state.llmUsage.cache_write_tokens += result.usage.cache_write_tokens ?? 0;
    }

    // Non-stream completions never call onContent — mirror Open WebUI text into thought.
    if (result.content?.trim() && !state.answerBuf.trim()) {
      state.answerBuf = result.content.trim();
      state.publishThoughtPanel();
    }

    // Legacy TEXT mode may embed XML/<invoke> tool mimetics in content. Never
    // execute those on a native-locked transport: that would silently recreate
    // the TEXT fallback which provider configuration explicitly rejected.
    if (state.toolProtocol === 'client' && !result.tool_calls.length && result.content) {
      const lifted = enrichClientToolCalls(
        parseClientToolCalls(result.content).map((call) => normalizeToolCall(call)),
        result.content,
      );
      if (lifted.length) {
        state.reportStatus(`모델 텍스트에서 도구 ${lifted.length}개 파싱`);
        result = {
          ...result,
          tool_calls: lifted,
          content: stripToolMimeticNoise(result.content) || null,
        };
      }
    }

    if (!result.tool_calls.length) {
      let text = (result.content ?? '').trim();
      if (!text) {
        state.reportStatus('빈 응답 — 도구 없이 재시도');
        const retry = await completeAgentAnswerStep(
          state.baseUrl,
          state.secret.api_key,
          state.modelId,
          [
            ...state.messages,
            {
              role: 'user',
              content:
                'Previous assistant content was empty. Answer the user now in Korean as normal prose. Do not call tools unless absolutely required.',
            },
          ],
          state.opts,
          streamHandlers,
        );
        const retryText = (retry.content ?? '').trim();
        if (retryText) {
          if (!state.answerBuf.trim()) {
            state.answerBuf = retryText;
            state.publishThoughtPanel();
          }
          if (!streamAnswer) state.opts.onAnswer?.(retryText);
          return state.finish({ content: retryText, model: state.lastModel, steps: state.steps });
        } else {
          return state.finish({
            content:
              '모델이 빈 응답을 반환했습니다. 같은 요청을 다시 보내 주세요. (코드 모드에서 설명만 필요하면 「텍스트」 모드도 가능합니다.)',
            model: state.lastModel, steps: state.steps
          });
        }
      }

      if (text && !state.answerBuf.trim()) {
        state.answerBuf = text;
        state.publishThoughtPanel();
      }
      if (!streamAnswer && text) state.opts.onAnswer?.(text);
      return state.finish({ content: text, model: state.lastModel, steps: state.steps });
    }

    const toolCalls = result.tool_calls.map((call) => normalizeToolCall(call as AgentToolCall));
    if (state.toolProtocol === 'api' && toolCalls.length) {
      clearClientToolProtocol(state.protocolCacheKey);
    }
    const loopGuard = createToolLoopGuard(state.messages);

    // Keep read gate in sync with prior tool_calls (avoids false read_before_write loops).
    for (const m of state.messages) {
      if (m.role === 'assistant' && m.tool_calls?.length) {
        state.readGate.syncFromAssistantToolCalls(m.tool_calls);
      }
    }

    state.messages.push({
      role: 'assistant',
      content: result.content,
      tool_calls: toolCalls,
    });

    let loopHardStop: ReturnType<typeof formatLoopGuardUserMessage> | null = null;
    let syntaxBrokenThisStep = false;
    let syntaxBrokenOutput = '';

    // Start independent read-only calls together so one model round does not
    // become N serial disk/index waits. Custom tool hooks keep serial semantics.
    type ParallelPreflight = {
      compat: ReturnType<typeof applyToolSchemaCompat>;
      admit: ReturnType<typeof loopGuard.admit>;
      beforeTool: Awaited<ReturnType<NonNullable<typeof state.hooks.beforeTool>>>;
      runnable: boolean;
    };
    const parallelPreflight = new Map<string, ParallelPreflight>();
    let parallelResults: Promise<Map<string, { output: string; durationMs: number }>> | null = null;
    const parallelism = resolveAgentReadParallelism();
    const parallelEligible = parallelism > 1
      && toolCalls.length > 1
      && !state.opts.hooks?.beforeTool
      && !state.opts.hooks?.afterTool
      && toolCalls.every((call) => {
        const compat = applyToolSchemaCompat(call, state.agentTools);
        if (!compat.validation.ok || !isParallelReadOnlyTool(compat.toolCall.function.name)) return false;
        const args = parseToolArgs(compat.toolCall.function.arguments);
        return !needsHumanApproval(compat.toolCall.function.name, args, process.env, {
          workspaceRoot: state.opts.workspaceRoot,
          allowedWriteRoots: state.opts.allowedWriteRoots,
          approvedExternalReadRoots: state.approvedExternalReadRoots,
        }).needed;
      });

    if (parallelEligible) {
      const runnable: AgentToolCall[] = [];
      for (const call of toolCalls) {
        const compat = applyToolSchemaCompat(call, state.agentTools);
        const execCall = compat.toolCall;
        const admit = loopGuard.admit(execCall);
        const args = parseToolArgs(execCall.function.arguments);
        const beforeTool = admit.triggered
          ? undefined
          : await state.hooks.beforeTool?.({
              tool: execCall.function.name,
              args,
              step: state.steps,
            });
        const canRun = !admit.triggered && !isHookStop(beforeTool);
        parallelPreflight.set(call.id, { compat, admit, beforeTool, runnable: canRun });
        if (canRun) runnable.push(execCall);
      }
      if (runnable.length > 0) {
        state.reportStatus(`병렬 조회 · ${runnable.length}개 (동시 실행 최대 ${parallelism})`);
        for (const execCall of runnable) {
          state.hooks.onEvent?.({ type: 'tool_start', tool: execCall.function.name, step: state.steps });
          state.toolCallCount += 1;
          noteFirstTool(state);
        }
        parallelResults = runParallelToolCalls(
          runnable,
          parallelism,
          (execCall) => executeAgentTool(state.opts.workspaceRoot, execCall, state.guard, state.toolCtx),
        ).then((rows) => new Map(rows.map((row) => [row.call.id, {
          output: row.output,
          durationMs: row.durationMs,
        }])));
      }
    }

    for (const call of toolCalls) {
      const preflight = parallelPreflight.get(call.id);
      const compat = preflight?.compat ?? applyToolSchemaCompat(call, state.agentTools);
      const execCall = compat.toolCall;

      if (compat.reroutedFrom) {
        state.reportStatus(`Tool: ${compat.reroutedFrom} → ${execCall.function.name}`);
      }

      const admit = loopGuard.admit(execCall);
      if (admit.triggered) {
        // Soft success re-hit: actionable correction (read→mutate), never dump raw guard to user.
        // Hard-stop only on repeated failures.
        const output = isSoftLoopGuardStop(admit)
          ? formatSoftExplorationLoopCorrection(admit, execCall.function.name)
          : formatLoopGuardStop(admit);
        loopGuard.noteResult(execCall, output);
        state.reportStatus(
          isSoftLoopGuardStop(admit)
            ? `탐색 재호출 차단 · ${toolStatusLabel(execCall)} — 읽기/수정으로 전환`
            : `Tool loop guard: ${execCall.function.name}`,
        );
        pushToolResultMessage(state.messages, execCall.id, output, execCall.function.name);
        if (isSoftLoopGuardStop(admit)) {
          continue;
        }
        loopHardStop = formatLoopGuardUserMessage(admit);
        break;
      }

      if (!compat.validation.ok && compat.validation.hasSchema) {
        const raw = `ERROR: invalid tool arguments — ${compat.validation.repairHint ?? 'check required fields'}`;
        const output = formatToolSelfCorrection(execCall.function.name, raw, state.toolNames, { writeFailStreak: state.writeFailStreak,
        });
        if (execCall.function.name === 'write_file' || execCall.function.name === 'apply_patch') {
          state.writeFailStreak += 1;
        }
        loopGuard.noteResult(execCall, output);
        state.reportStatus(
          `도구 인자 오류 · ${toolStatusLabel(execCall)} — 모델이 다시 호출합니다`,
        );
        pushToolResultMessage(state.messages, execCall.id, output, execCall.function.name);
        continue;
      }

      const args = parseToolArgs(execCall.function.arguments);

      // Approval is evaluated before retrieval auto-heal, read-before-write and
      // checkpoint creation. No outside-workspace path may be touched while the
      // user is still looking at an approval card.
      const hitl = needsHumanApproval(execCall.function.name, args, process.env, {
        workspaceRoot: state.opts.workspaceRoot,
        allowedWriteRoots: state.opts.allowedWriteRoots,
        approvedExternalReadRoots: state.approvedExternalReadRoots,
      });
      if (hitl.needed) {
        let approved = false;
        const delegable = canDelegateToolApproval(execCall.function.name, args, state.opts.workspaceRoot);
        if (state.opts.onToolApproval) {
          const id = createToolApprovalId();
          state.reportStatus(
            `승인 대기 · ${hitl.summary} — 화면의 승인/거절을 눌러 주세요`,
          );
          const approvalStarted = Date.now();
          approved = await state.opts.onToolApproval({
            id,
            tool: execCall.function.name,
            summary: hitl.summary,
            argsPreview: JSON.stringify(args).slice(0, 1200),
            danger: hitl.danger,
            delegable,
            access: hitl.access,
            targets: hitl.targets,
            expires: hitl.expires,
          });
          const approvalDurationMs = Date.now() - approvalStarted;
          state.approvalWaitMs += approvalDurationMs;
          if (state.approvalTrace.length < 40) {
            state.approvalTrace.push({
              step: state.steps,
              name: execCall.function.name,
              duration_ms: approvalDurationMs,
              approved,
              delegable,
              access: hitl.access,
            });
          }
        } else if (args.confirm === true) {
          approved = true;
        } else {
          const output = formatApprovalDenied(execCall.function.name, 'confirm_required');
          loopGuard.noteResult(execCall, output);
          state.reportStatus(`Tool: ${toolStatusLabel(execCall)} (승인 필요)`);
          pushToolResultMessage(state.messages, execCall.id, output, execCall.function.name);
          continue;
        }
        if (!approved) {
          const output = formatApprovalDenied(execCall.function.name, 'user_rejected');
          loopGuard.noteResult(execCall, output);
          state.reportStatus(`Tool: ${toolStatusLabel(execCall)} (거절됨)`);
          pushToolResultMessage(state.messages, execCall.id, output, execCall.function.name);
          continue;
        }
        if (hitl.access === 'external_read') {
          for (const root of hitl.grantRoots ?? []) state.approvedExternalReadRoots.add(root);
        }
        state.reportStatus(`승인됨 · ${hitl.summary} 실행 중…`);
      }

      let readBlock = state.readGate.assertCanMutate(execCall.function.name, args);
      if (readBlock && state.readBeforeWriteAutoHeals < 2) {
        const missing = unreadPathsFromReadBeforeWriteError(readBlock);
        const needsParentList =
          /list_directory|brand-new|parent folder/i.test(readBlock)
          || (execCall.function.name === 'write_file' && missing.length > 0);
        if (missing.length || needsParentList) {
          state.readBeforeWriteAutoHeals += 1;
          state.reportStatus(
            needsParentList
              ? `read-before-write 자동 치유 · list_directory + ${missing.slice(0, 2).join(', ') || 'new file'}`
              : `read-before-write 자동 치유 · ${missing.slice(0, 3).join(', ')}`,
          );
          if (needsParentList) {
            const parents = new Set<string>(['.']);
            const seedPaths = [
              ...missing,
              typeof args.path === 'string' ? args.path : '',
            ].filter(Boolean);
            for (const p of seedPaths) {
              const n = WorkspaceReadGate.normalizeRel(p);
              parents.add(n.includes('/') ? n.slice(0, n.lastIndexOf('/')) || '.' : '.');
            }
            for (const [i, dir] of [...parents].slice(0, 3).entries()) {
              const listCall: AgentToolCall = {
                id: `auto_list_${state.steps}_${i}`,
                type: 'function',
                function: {
                  name: 'list_directory',
                  arguments: JSON.stringify({ path: dir }),
                },
              };
              state.messages.push({
                role: 'assistant',
                content: null,
                tool_calls: [listCall],
              });
              try {
                const listRes = await executeAgentTool(
                  state.opts.workspaceRoot,
                  listCall,
                  state.guard,
                  state.toolCtx,
                );
                pushToolResultMessage(
                  state.messages,
                  listCall.id,
                  listRes.output,
                  'list_directory',
                );
                state.readGate.noteListDirectory(dir);
                state.toolCallCount += 1;
                noteFirstTool(state);
                state.toolsUsedThisRun.add('list_directory');
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                pushToolResultMessage(
                  state.messages,
                  listCall.id,
                  `ERROR: auto_list_failed\n${msg}`,
                  'list_directory',
                );
                state.readGate.noteListDirectory(dir);
              }
            }
          }
          const autoReads: AgentToolCall[] = missing.slice(0, 4).map((p, i) => ({
            id: `auto_read_${state.steps}_${i}`,
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ path: p }),
            },
          }));
          if (autoReads.length) {
            state.messages.push({
              role: 'assistant',
              content: null,
              tool_calls: autoReads,
            });
            for (const readCall of autoReads) {
              const readArgs = parseToolArgs(readCall.function.arguments);
              const rel =
                typeof readArgs.path === 'string' ? normalizeAgentPath(readArgs.path) : '';
              try {
                const readRes = await executeAgentTool(
                  state.opts.workspaceRoot,
                  readCall,
                  state.guard,
                  state.toolCtx,
                );
                pushToolResultMessage(
                  state.messages,
                  readCall.id,
                  readRes.output,
                  'read_file',
                );
                if (rel) {
                  state.readGate.noteReadFile(rel);
                  state.successfulReadsThisRun.add(rel);
                  state.readBodiesFetchedThisRun.add(rel);
                }
                state.toolCallCount += 1;
                noteFirstTool(state);
                state.toolsUsedThisRun.add('read_file');
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                pushToolResultMessage(
                  state.messages,
                  readCall.id,
                  `ERROR: auto_read_failed\n${msg}`,
                  'read_file',
                );
              }
            }
          }
          readBlock = state.readGate.assertCanMutate(execCall.function.name, args);
        }
      }
      if (readBlock) {
        const output = formatToolSelfCorrection(execCall.function.name, readBlock, state.toolNames, { writeFailStreak: state.writeFailStreak,
        });
        loopGuard.noteResult(execCall, output);
        state.reportStatus(`Tool: ${toolStatusLabel(execCall)} (read-before-write)`);
        pushToolResultMessage(state.messages, execCall.id, output, execCall.function.name);
        continue;
      }

      if (isMutatingAgentTool(execCall.function.name) && !state.autoCheckpointTaken) {
        try {
          const focusPaths = collectAutoCheckpointPaths(
            execCall.function.name,
            args,
            state.successfulReadsThisRun,
          );
          if (!focusPaths.length) {
            state.reportStatus(
              'checkpoint skipped: 대상 경로 없음 (전체 폴더 스냅샷 생략 — 지연 방지)',
            );
            state.autoCheckpointTaken = true;
          } else {
            const meta = createWorkspaceCheckpoint(state.opts.workspaceRoot, state.opts.cqrRoot, {
              sessionKey: state.opts.sessionId ?? 'default',
              label: 'auto-before-mutate',
              paths: focusPaths, guard: state.guard
            });
            state.autoCheckpointTaken = true;
            state.lastAutoCheckpointId = meta.id;
            clearOldCheckpoints(state.opts.cqrRoot, state.opts.sessionId ?? 'default', 5);
            appendAgentAuditEvent(state.opts.cqrRoot, {
              type: 'checkpoint',
              sessionId: state.opts.sessionId,
              detail: meta.id,
            });
            state.reportStatus(`checkpoint ${meta.id} (${meta.fileCount} files)`);
          }
        } catch (e: unknown) {
          const note = e instanceof Error ? e.message : String(e);
          state.reportStatus(`checkpoint skipped: ${note.slice(0, 120)}`);
        }
      }

      const label = toolStatusLabel(execCall);
      if (!preflight?.runnable) state.reportStatus(`실행 · ${label}`);
      const beforeTool = preflight
        ? preflight.beforeTool
        : await state.hooks.beforeTool?.({
            tool: execCall.function.name,
            args,
            step: state.steps,
          });
      if (isHookStop(beforeTool)) {
        state.hooks.onEvent?.({ type: 'hook_stop', reason: beforeTool.reason, phase: 'beforeTool' });
        const output = `ERROR: hook_blocked\n${beforeTool.reason}`;
        loopGuard.noteResult(execCall, output);
        pushToolResultMessage(state.messages, execCall.id, output, execCall.function.name);
        continue;
      }
      let output: string;
      let durationMs: number;
      if (preflight?.runnable && parallelResults) {
        const resultMap = await parallelResults;
        const parallelResult = resultMap.get(execCall.id);
        output = parallelResult?.output ?? 'ERROR: parallel_tool_result_missing';
        durationMs = parallelResult?.durationMs ?? 0;
      } else {
        state.hooks.onEvent?.({ type: 'tool_start', tool: execCall.function.name, step: state.steps });
        const toolStarted = Date.now();
        state.toolCallCount += 1;
        noteFirstTool(state);
        ({ output } = await executeAgentTool(state.opts.workspaceRoot, execCall, state.guard, state.toolCtx));
        durationMs = Date.now() - toolStarted;
      }
      if (
        execCall.function.name === 'edit_file'
        && typeof args.path === 'string'
        && (output.startsWith('ERROR:') || /"ok"\s*:\s*false/.test(output))
      ) {
        // Failed hunk must not sticky-block a later read_file on the same path.
        state.readBodiesFetchedThisRun.delete(normalizeAgentPath(args.path));
      }
      if (
        isRecoverableToolFailure(output)
        && !output.includes('tool_call_failed')
        && !toolOutputHasSyntaxBroken(execCall.function.name, output)
      ) {
        if (execCall.function.name === 'write_file' || execCall.function.name === 'apply_patch') {
          state.writeFailStreak += 1;
        }
        output = formatToolSelfCorrection(execCall.function.name, output, state.toolNames, { writeFailStreak: state.writeFailStreak,
        });
      }
      const syntaxBroken = toolOutputHasSyntaxBroken(execCall.function.name, output);
      const toolOk = !syntaxBroken && agentToolOutputOk(output);
      const toolSummary = summarizeAgentToolResult(output);
      if (state.toolTrace.length < 120) {
        state.toolTrace.push({
          step: state.steps,
          name: execCall.function.name,
          ok: toolOk,
          duration_ms: durationMs,
          failure_type: syntaxBroken ? 'syntax_error' : toolSummary.failure_type,
          exit_code: toolSummary.exit_code,
          skipped: toolSummary.skipped,
          weak: toolSummary.weak,
        });
      }
      if (toolOk) {
        state.selfCorrectionStreak = 0;
        if (isMutatingAgentTool(execCall.function.name)) state.writeFailStreak = 0;
        if (
          execCall.function.name === 'run_diagnostics'
          || execCall.function.name === 'run_tests'
          || (execCall.function.name === 'run_terminal'
            && /(?:--check|node\s|npm\s+test|pytest|tsc\b|workspace:build)/i.test(execCall.function.arguments || ''))
        ) {
          state.ranVerifyCommand = true;
          const kind =
            execCall.function.name === 'run_tests'
              ? 'tests'
              : execCall.function.name === 'run_terminal'
                ? 'terminal'
                : 'diagnostics';
          const parsed = parseVerifyJson(output);
          if (parsed) {
            // Prefer explicit command from tool args for workspace:build Exit Gate.
            let command = parsed.command;
            try {
              const rawArgs = JSON.parse(execCall.function.arguments || '{}') as { command?: string };
              if (typeof rawArgs.command === 'string' && rawArgs.command.trim()) {
                command = rawArgs.command.trim();
              }
            } catch {
              /* ignore */
            }
            recordVerifyWitness(state, {
              kind,
              diag: { ...parsed, command },
              atStep: state.steps,
            });
            if (kind === 'diagnostics' || kind === 'tests') {
              state.evidenceDiagOk = diagnosticsEvidenceStatus(parsed);
            }
          }
        }
      } else {
        if (syntaxBroken) {
          state.writeFailStreak += 1;
          state.evidenceDiagOk = false;
          syntaxBrokenThisStep = true;
          syntaxBrokenOutput = output;
        }
      }
      state.hooks.onEvent?.({
        type: 'tool_end',
        tool: execCall.function.name,
        step: state.steps,
        ok: toolOk,
        durationMs,
      });
      state.opts.onToolComplete?.({
        tool: execCall.function.name,
        ok: toolOk,
        durationMs,
      });
      if (!toolOk) toolFailuresSinceCheckpoint += 1;
      const afterTool = await state.hooks.afterTool?.({
        tool: execCall.function.name,
        args,
        step: state.steps,
        output,
        durationMs,
      });
      if (isHookStop(afterTool)) {
        state.hooks.onEvent?.({ type: 'hook_stop', reason: afterTool.reason, phase: 'afterTool' });
        loopGuard.noteResult(execCall, output);
        pushToolResultMessage(state.messages, execCall.id, output, execCall.function.name);
        return state.finish({ content: `Agent stopped after tool: ${afterTool.reason}`, model: state.lastModel, steps: state.steps });
      }
      loopGuard.noteResult(execCall, output);

      if (toolOk) {
        state.toolsUsedThisRun.add(execCall.function.name);
        if (execCall.function.name === 'read_file' && typeof args.path === 'string') {
          state.readGate.noteReadFile(args.path);
          const n = normalizeAgentPath(args.path);
          state.successfulReadsThisRun.add(n);
          state.readBodiesFetchedThisRun.add(n);
        } else if (execCall.function.name === 'list_directory') {
          state.readGate.noteListDirectory(typeof args.path === 'string' ? args.path : '.');
        } else if (
          (execCall.function.name === 'write_file' || execCall.function.name === 'edit_file')
          && typeof args.path === 'string'
        ) {
          state.readGate.noteWritten(args.path);
          state.mutatedPathsThisRun.add(normalizeAgentPath(args.path));
          // Cursor-like: do not sticky-open workspace:build Exit Gate on every src mutate.
          // Same-turn outcome may still nudge once; next turns are not hijacked.
        } else if (execCall.function.name === 'apply_patch') {
          if (typeof args.path === 'string') {
            state.mutatedPathsThisRun.add(normalizeAgentPath(args.path));
          }
          if (Array.isArray(args.files)) {
            for (const f of args.files) {
              if (f && typeof f === 'object' && typeof (f as { path?: string }).path === 'string') {
                const p = (f as { path: string }).path;
                state.mutatedPathsThisRun.add(normalizeAgentPath(p));
              }
            }
          }
          const patchText = typeof args.patch === 'string' ? args.patch : '';
          for (const m of patchText.matchAll(/\*\*\*\s*(?:Update|Add|Delete)\s+File:\s*([^\n]+)/gi)) {
            const p = m[1]?.trim();
            if (p) state.mutatedPathsThisRun.add(normalizeAgentPath(p));
          }
        } else if (execCall.function.name === 'delete_file' && typeof args.path === 'string') {
          state.mutatedPathsThisRun.add(normalizeAgentPath(args.path));
        }
        if (isMutatingAgentTool(execCall.function.name)) {
          // Disk write landed (even if SYNTAX_BROKEN). Silent verify / syntax repair still run.
          state.mutatedOkRun = true;
          // Persist before next LLM round — infra 504 must not leave empty session meta.
          state.persistLiveSessionMeta();
        } else if (execCall.function.name === 'read_file') {
          state.persistLiveSessionMeta();
        }
        if (
          state.mutatedPathsThisRun.size > 0
          && (
            execCall.function.name === 'run_tests'
            || execCall.function.name === 'run_terminal'
            || execCall.function.name.startsWith('browser_')
          )
        ) {
          state.explicitAcceptanceOk = true;
        }
        // After local plugin install/toggle, re-merge catalog so same-run plugin_* works.
        if (
          toolOk
          && (execCall.function.name === 'plugin_install'
            || execCall.function.name === 'plugin_set_enabled')
        ) {
          let pluginJsonOk = true;
          try {
            const doc = JSON.parse(output) as { ok?: boolean };
            if (doc && doc.ok === false) pluginJsonOk = false;
          } catch {
            /* not JSON — still refresh if no ERROR: prefix */
          }
          if (pluginJsonOk) {
            try {
              const { getCodeAgentToolsByPackAsync } = await import('./tools.js');
              const packTools = await getCodeAgentToolsByPackAsync(
                state.opts.cqrRoot,
                state.toolPack,
              );
              state.agentTools = packTools;
              state.toolNames = getCodeAgentToolNamesFromTools(packTools);
              state.reportStatus(
                `Plugin catalog refreshed (${state.toolNames.filter((n) => n.startsWith('plugin_')).length} plugin_* tools)`,
              );
            } catch {
              /* best-effort */
            }
          }
        }
        // Notify UI as soon as disk mutate lands (Preview code tabs).
        if (
          isMutatingAgentTool(execCall.function.name)
          && state.opts.onWorkspaceMutate
        ) {
          const just: string[] = [];
          if (
            (execCall.function.name === 'write_file'
              || execCall.function.name === 'edit_file'
              || execCall.function.name === 'delete_file')
            && typeof args.path === 'string'
          ) {
            just.push(normalizeAgentPath(args.path));
          } else if (execCall.function.name === 'apply_patch') {
            if (typeof args.path === 'string') just.push(normalizeAgentPath(args.path));
            if (Array.isArray(args.files)) {
              for (const f of args.files) {
                if (f && typeof f === 'object' && typeof (f as { path?: string }).path === 'string') {
                  just.push(normalizeAgentPath((f as { path: string }).path));
                }
              }
            }
            const patchText = typeof args.patch === 'string' ? args.patch : '';
            for (const m of patchText.matchAll(/\*\*\*\s*(?:Update|Add|Delete)\s+File:\s*([^\n]+)/gi)) {
              const p = m[1]?.trim();
              if (p) just.push(normalizeAgentPath(p));
            }
          }
          const uniq = [...new Set(just.filter(Boolean))];
          if (uniq.length) state.opts.onWorkspaceMutate(uniq);
        }
      }

      const snippet = extractToolCodeSnippet(execCall);
      if (snippet) {
        const text = snippet.text || output;
        if (text.trim()) {
          state.opts.onCode?.({ label: snippet.label, text: trimSnippet(text) });
        }
      }
      state.messages.push({
        role: 'tool',
        tool_call_id: execCall.id,
        content: truncateToolResultForLlm(output, execCall.function.name),
      });
    }

    if (loopHardStop) {
      return state.finish({ content: loopHardStop, model: state.lastModel, steps: state.steps });
    }

    let failureCheckpointInjected = false;
    if (toolFailuresSinceCheckpoint >= FAILURE_CHECKPOINT_THRESHOLD) {
      writeProgressCheckpoint('three_failures', true);
      toolFailuresSinceCheckpoint = 0;
      failureCheckpointInjected = true;
    }

    if (syntaxBrokenThisStep && state.silentVerifyAttempts < state.maxVerify) {
      state.reportStatus('verify · syntax gate (broken)');
      state.evidenceDiagOk = false;
      state.silentVerifyAttempts += 1;
      state.ranVerifyCommand = true;
      recordVerifyWitness(state, {
        kind: 'diagnostics',
        diag: {
          ok: false,
          skipped: false,
          weak: false,
          command: 'post-mutate-syntax',
        },
        atStep: state.steps,
      });
      appendAgentAuditEvent(state.opts.cqrRoot, {
        type: 'verify_fail',
        sessionId: state.opts.sessionId,
        detail: `syntax attempt=${state.silentVerifyAttempts}`,
      });
      state.messages.push({
        role: 'user',
        content: formatSyntaxBrokenRepairPrompt({
            output: syntaxBrokenOutput,
            attempt: state.silentVerifyAttempts,
            maxAttempts: state.maxVerify,
            mutatedPaths: [...state.mutatedPathsThisRun],
          }),
      });
      continue;
    }

    const chainSteps = cumulativeSteps();
    if (
      !failureCheckpointInjected
      && chainSteps % PROGRESSIVE_STAGE_ROUNDS === 0
      && chainSteps < MAX_PROGRESSIVE_TOTAL_ROUNDS
      && state.steps < state.maxSteps
    ) {
      writeProgressCheckpoint('stage_boundary', true);
      toolFailuresSinceCheckpoint = 0;
      state.reportStatus(
        `순차 진행 · ${progressiveStageForStep(chainSteps) + 1}단계 시작 (단계당 ${PROGRESSIVE_STAGE_ROUNDS}회)`,
      );
    }
  }

  const checkpoint = writeProgressCheckpoint('budget_exhausted', false);
  const modelContent = (state.lastModelOutput || state.answerBuf).trim();
  const notice = formatProgressiveBudgetNotice(checkpoint);
  return state.finish({
    content: modelContent || '이번 단계에서 모델이 별도의 서술형 작업 결과를 남기지 않았습니다.',
    model: checkpoint.runtime?.model ?? state.lastModel,
    steps: state.steps,
    applicationNotice: {
      kind: 'continuation',
      title: notice.title,
      message: notice.message,
      model: checkpoint.runtime?.model ?? state.lastModel,
      elapsedMs: checkpoint.runtime?.elapsedMs
        ?? state.priorElapsedMs + (Date.now() - state.runStartedAt),
      step: checkpoint.step,
    },
  });
}
