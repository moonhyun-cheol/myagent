/**
 * ADR-008 · Failure plane (structural).
 *
 * Invariants:
 * 1. Infra/provider failures are errors — never assistant "answers".
 * 2. A tool-plane turn must not demote to tool-less chat on failure
 *    (that path invents "tools not connected" fiction).
 * 3. Classification is by failure class, not by chasing Korean phrases.
 */
import { isUpstreamConnectionDrop } from '../debug-session-log.js';
import { isOwuiOrGatewayError } from './agent-run-helpers.js';

export type LlmFailureClass = 'infra' | 'abort' | 'other';

export class AgentInfraError extends Error {
  readonly failureClass = 'infra' as const;
  readonly causeRaw: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'AgentInfraError';
    this.causeRaw = cause;
  }
}

export function classifyLlmFailure(err: unknown): LlmFailureClass {
  if (err instanceof AgentInfraError) return 'infra';
  const name = err instanceof Error ? err.name : '';
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (name === 'AbortError' || /\babort(?:ed|error)\b/i.test(msg)) return 'abort';
  if (isOwuiOrGatewayError(err) || isUpstreamConnectionDrop(msg)) return 'infra';
  if (
    /PROVIDER_NOT_|PROVIDER_NOT_SUPPORTED|BASE_URL_REQUIRED|API_KEY_EMPTY|PROVIDER_UNKNOWN/i.test(
      msg,
    )
  ) {
    return 'infra';
  }
  return 'other';
}

export function isInfraLlmFailure(err: unknown): boolean {
  return classifyLlmFailure(err) === 'infra';
}

/** Critical MAR roles: infra/other failure aborts the turn (no prose merge). */
export function roleFailureMustAbortTurn(role: string): boolean {
  return role === 'coder' || role === 'planner';
}

/** Soft roles: may skip on infra without aborting a prior successful coder. */
export function roleFailureMaySoftSkip(role: string): boolean {
  return role === 'reviewer' || role === 'researcher' || role === 'browser';
}

/**
 * Client/UI invariant: never retry a tool-plane request as plain chat.
 * (`workspaceStore` historically did code → chat demotion on stream error.)
 */
export function mustNotDemoteToolPlaneToChat(requestedToolPlane: boolean): boolean {
  return requestedToolPlane === true;
}

export function wrapAsInfraError(err: unknown): AgentInfraError {
  if (err instanceof AgentInfraError) return err;
  const msg = err instanceof Error ? err.message : String(err ?? 'unknown infra failure');
  return new AgentInfraError(msg, err);
}

/**
 * Defense-in-depth: if a role failure string still appears as content, treat as infra leak.
 * Used by supervisor merge / outcome paths — not a phrase denylist for the model.
 */
export function contentLooksLikeLeakedRoleInfraFailure(content: string): boolean {
  const t = String(content || '').trim();
  if (!t) return false;
  if (
    /^(?:coder|planner|reviewer|browser|researcher)\s*실패\s*:/im.test(t)
    && /OWUI_GATEWAY|UPSTREAM_HTML|HTTP\s*50[234]|ECONNREFUSED|ETIMEDOUT|timeout|fetch failed|INVALID_RESPONSE/i.test(
      t,
    )
  ) {
    return true;
  }
  return /^OWUI_GATEWAY_TIMEOUT\b/m.test(t);
}

/**
 * Policy copy when the agent plane runs without a bound work folder.
 * Must be an assistant reply (200), never INTERNAL_ERROR 500.
 */
export const TOOL_PLANE_NO_WORKSPACE_REFUSAL =
  '이 대화에는 연결된 작업 폴더가 없습니다. '
  + '노트북에서 폴더/프로젝트 채팅을 열거나, Manager에서 전역 작업 폴더를 지정해 주세요.';

/** True when an error string is the legacy thrown no-workspace message (or current refusal). */
export function isNoWorkspaceBoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return (
    /연결된\s*작업\s*폴더가\s*없습니다/i.test(msg)
    || msg.includes(TOOL_PLANE_NO_WORKSPACE_REFUSAL.slice(0, 24))
  );
}

/**
 * Persistable assistant body after tool-plane interrupt (504 / abort / other).
 * Kept in session history so the next turn is not a dangling user message.
 */
export function formatToolPlaneFailureAssistant(opts: {
  formattedError: string;
  mutatedPaths?: string[];
  kind?: LlmFailureClass | 'stopped';
}): string {
  const err = String(opts.formattedError || '').trim() || '알 수 없는 오류';
  const paths = (opts.mutatedPaths ?? [])
    .map((p) => String(p).replace(/\\/g, '/').trim())
    .filter(Boolean)
    .slice(0, 12);
  const kind = opts.kind ?? 'other';
  const lines: string[] = [];
  if (kind === 'stopped') {
    lines.push('코드 작업이 중지되었습니다.');
  } else if (kind === 'infra') {
    lines.push('코드 작업이 인프라 오류로 중단되었습니다. (도구 평면 유지 — 일반 채팅으로 강등하지 않음)');
  } else {
    lines.push('코드 작업이 오류로 중단되었습니다.');
  }
  lines.push('');
  lines.push(err);
  if (paths.length) {
    lines.push('');
    lines.push(`이 세션에서 이미 디스크에 반영된 경로(참고): ${paths.join(', ')}`);
  }
  lines.push('');
  lines.push(
    '앱이 자동 재시도·이어하기를 이미 수행했습니다. 계속 실패하면 잠시 뒤 다시 시도하거나 더 짧은 요청으로 나눠 주세요.',
  );
  lines.push('같은 작업 대화에서 「이어서 진행」하면 현재 작업공간과 맥락을 유지합니다.');
  return lines.join('\n').trim();
}

/** Max infra retries on the same tool plane (user message already appended once). */
export function toolPlaneInfraRetryLimit(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(String(env.MY_AGENT_TOOL_PLANE_INFRA_RETRIES ?? '').trim(), 10);
  if (Number.isFinite(n)) return Math.min(5, Math.max(0, n));
  return 2;
}

/**
 * After infra retries exhaust, silently resume the same tool-plane turn up to N times
 * (continuity/openGate already flushed) so the user is not forced to click 「이어서」.
 */
export function toolPlaneAutoResumeLimit(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(String(env.MY_AGENT_TOOL_PLANE_AUTO_RESUME ?? '').trim(), 10);
  if (Number.isFinite(n)) return Math.min(4, Math.max(0, n));
  return 2;
}

/** Whether session meta has enough breadcrumbs to make auto-resume useful. */
export function shouldAutoResumeAfterInfra(meta: {
  mutatedPaths?: string[] | null;
  readPaths?: string[] | null;
  openGate?: { status?: string; gate?: string } | null;
}): boolean {
  // Require real disk breadcrumbs. Infra retries (MY_AGENT_TOOL_PLANE_INFRA_RETRIES)
  // already cover cold-start 504; auto-resume on empty/openGate-only caused
  // planner↔HTTP 500 thrash after interrupt Exit Gate poison.
  if ((meta.mutatedPaths?.length ?? 0) > 0) return true;
  if ((meta.readPaths?.length ?? 0) > 0) return true;
  return false;
}
