/**
 * MAR specialist nodes — browser / research handoffs (ADR-005 Phase 2).
 * Serial only; no parallel mutate.
 */
import path from 'node:path';
import type { ProviderStore } from '../providers/provider-store.js';
import { CloudChatService } from '../providers/cloud-chat.js';
import { DeepResearchPipeline } from '../research/deep-research.js';
import { runBrowserVisionAgent } from '../browser/browser-vision-agent.js';
import { extractUrlFromText, isPlaceholderNavUrl } from '../browser/browser-service.js';
import { isPlaywrightAvailable } from '../browser/playwright-probe.js';
import { appendAgentAuditEvent } from './agent-audit-ledger.js';
import type { AgentRole, HandoffMessage, MarRoleResult } from './agent-mar-types.js';

export interface SpecialistCommonOpts {
  cqrRoot: string;
  configPath: string;
  providerStore: ProviderStore;
  sessionId?: string;
  userMessage: string;
  parentRunId: string;
  agentId: string;
  handoff?: HandoffMessage;
  signal?: AbortSignal;
  onStatus?: (text: string) => void;
}

function researchOutDir(cqrRoot: string): string {
  return path.join(cqrRoot, 'data', 'outputs', 'research');
}

/** Browser specialist via existing vision agent (not a separate HTTP mode). */
export async function runBrowserSpecialistNode(
  opts: SpecialistCommonOpts,
): Promise<MarRoleResult> {
  const role: AgentRole = 'browser';
  opts.onStatus?.('MAR · browser specialist');
  appendAgentAuditEvent(opts.cqrRoot, {
    type: 'role_start',
    sessionId: opts.sessionId,
    agentId: opts.agentId,
    parentRunId: opts.parentRunId,
    role,
  });

  if (!isPlaywrightAvailable(opts.cqrRoot)) {
    const content =
      '브라우저 specialist 스킵: Playwright 런타임이 없습니다. bootstrap-playwright 후 재시도하세요.';
    appendAgentAuditEvent(opts.cqrRoot, {
      type: 'role_end',
      sessionId: opts.sessionId,
      agentId: opts.agentId,
      parentRunId: opts.parentRunId,
      role,
      ok: false,
      detail: 'playwright_unavailable',
    });
    return {
      role,
      agentId: opts.agentId,
      content,
      model: 'browser/unavailable',
      steps: 0,
      mutatedPaths: [],
      ok: false,
      detail: 'playwright_unavailable',
    };
  }

  const task = [
    opts.userMessage,
    opts.handoff?.task ? `\n[Prior]\n${opts.handoff.task.slice(0, 2000)}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const url = extractUrlFromText(task);
  if (url && isPlaceholderNavUrl(url)) {
    const content = [
      '**브라우저 specialist 스킵**',
      '',
      `자리표시자 URL은 열지 않습니다: ${url}`,
      '로컬 HTTP 또는 실제 운영 URL이 있을 때만 브라우저 검증을 실행하세요.',
    ].join('\n');
    appendAgentAuditEvent(opts.cqrRoot, {
      type: 'role_end',
      sessionId: opts.sessionId,
      agentId: opts.agentId,
      parentRunId: opts.parentRunId,
      role,
      ok: true,
      detail: 'skipped_placeholder_url',
      steps: 0,
    });
    return {
      role,
      agentId: opts.agentId,
      content,
      model: 'browser/skip',
      steps: 0,
      mutatedPaths: [],
      ok: true,
      detail: 'skipped_placeholder_url',
    };
  }
  if (!url && !/로그인|클릭|click|fill|검색|submit|form|버튼|스크린샷|screenshot|검증/i.test(task)) {
    const content =
      '브라우저 specialist: URL 또는 상호작용/스크린샷 지시가 없어 스킵했습니다.';
    appendAgentAuditEvent(opts.cqrRoot, {
      type: 'role_end',
      sessionId: opts.sessionId,
      agentId: opts.agentId,
      parentRunId: opts.parentRunId,
      role,
      ok: true,
      detail: 'skipped_no_url',
      steps: 0,
    });
    return {
      role,
      agentId: opts.agentId,
      content,
      model: 'browser/skip',
      steps: 0,
      mutatedPaths: [],
      ok: true,
      detail: 'skipped_no_url',
    };
  }

  try {
    const result = await runBrowserVisionAgent({
      cqrRoot: opts.cqrRoot,
      configPath: opts.configPath,
      providerStore: opts.providerStore,
      sessionId: opts.sessionId ?? 'mar-browser',
      message: task,
    });
    const content = result.ok
      ? result.content
      : `**브라우저 specialist 실패**\n\n${result.content}`;
    appendAgentAuditEvent(opts.cqrRoot, {
      type: 'role_end',
      sessionId: opts.sessionId,
      agentId: opts.agentId,
      parentRunId: opts.parentRunId,
      role,
      ok: result.ok,
      steps: result.steps,
      detail: result.error?.slice(0, 200),
    });
    return {
      role,
      agentId: opts.agentId,
      content,
      model: 'browser/vision-agent',
      steps: result.steps,
      mutatedPaths: [],
      ok: result.ok,
      detail: result.error,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    appendAgentAuditEvent(opts.cqrRoot, {
      type: 'role_end',
      sessionId: opts.sessionId,
      agentId: opts.agentId,
      parentRunId: opts.parentRunId,
      role,
      ok: false,
      detail: msg.slice(0, 200),
    });
    return {
      role,
      agentId: opts.agentId,
      content: `브라우저 specialist 오류: ${msg}`,
      model: 'browser/error',
      steps: 0,
      mutatedPaths: [],
      ok: false,
      detail: msg,
    };
  }
}

/** Research specialist via DeepResearchPipeline (desk research, no invented live URLs). */
export async function runResearchSpecialistNode(
  opts: SpecialistCommonOpts,
): Promise<MarRoleResult> {
  const role: AgentRole = 'researcher';
  opts.onStatus?.('MAR · researcher specialist');
  appendAgentAuditEvent(opts.cqrRoot, {
    type: 'role_start',
    sessionId: opts.sessionId,
    agentId: opts.agentId,
    parentRunId: opts.parentRunId,
    role,
  });

  const query = [
    opts.userMessage,
    opts.handoff?.task ? `\nContext:\n${opts.handoff.task.slice(0, 1500)}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const cloudChat = new CloudChatService(opts.providerStore, undefined, opts.cqrRoot);
    const pipeline = new DeepResearchPipeline(
      researchOutDir(opts.cqrRoot),
      opts.cqrRoot,
      opts.providerStore,
      cloudChat,
    );
    const result = await pipeline.run(query, opts.sessionId ?? 'mar-research');
    const content = [
      `## Research brief (${result.id})`,
      result.markdown.slice(0, 12_000),
      result.file_path ? `\nSaved: ${result.file_path}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    appendAgentAuditEvent(opts.cqrRoot, {
      type: 'role_end',
      sessionId: opts.sessionId,
      agentId: opts.agentId,
      parentRunId: opts.parentRunId,
      role,
      ok: true,
      steps: result.steps.length,
      detail: result.id,
    });
    return {
      role,
      agentId: opts.agentId,
      content,
      model: 'research/deep',
      steps: result.steps.length,
      mutatedPaths: [],
      ok: true,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    appendAgentAuditEvent(opts.cqrRoot, {
      type: 'role_end',
      sessionId: opts.sessionId,
      agentId: opts.agentId,
      parentRunId: opts.parentRunId,
      role,
      ok: false,
      detail: msg.slice(0, 200),
    });
    return {
      role,
      agentId: opts.agentId,
      content: `Research specialist 오류: ${msg}`,
      model: 'research/error',
      steps: 0,
      mutatedPaths: [],
      ok: false,
      detail: msg,
    };
  }
}
