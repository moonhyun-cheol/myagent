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

/**
 * Host safety ceiling, not a provider/tool failure. The agent runtime converts
 * this interrupt into a durable continuation result when live state exists.
 */
export function isAgentExecutionLimit(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /Code agent exceeded \d+ (?:LLM orchestration rounds(?: \(not tool calls\))?|tool steps)\b/i.test(
    msg,
  );
}

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
  /** Resolved model that was running when the run failed/stopped (display ref). */
  model?: string | null;
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
    lines.push('AI 공급자 오류로 작업이 중단되었습니다. 도구 연결과 작업 상태는 그대로 유지됩니다.');
  } else {
    lines.push('코드 작업이 오류로 중단되었습니다.');
  }
  const model = failureModelLabel(opts.model);
  if (model) lines.push(`작업 모델: ${model}`);
  lines.push('');
  lines.push(err);
  if (paths.length) {
    lines.push('');
    lines.push(`지금까지 저장된 파일은 유지됩니다: ${paths.join(', ')}`);
  }
  if (kind === 'infra') {
    lines.push('');
    lines.push(
      'AI 공급자 오류에 대한 자동 재시도를 모두 수행했지만 복구되지 않았습니다. 잠시 뒤 다시 시도해 주세요.',
    );
  }
  lines.push('');
  lines.push('같은 작업 대화에서 「이어서 진행」하면 현재 작업공간과 맥락을 유지합니다.');
  return lines.join('\n').trim();
}

/** Append `작업 모델: …` to a plain chat error message when the model is known. */
export function withFailureModelLine(message: string, model: string | null | undefined): string {
  const label = failureModelLabel(model);
  const msg = String(message ?? '').trim();
  return label ? `${msg}\n작업 모델: ${label}` : msg;
}

/** Usable model ref for failure copy; drops placeholders such as `none` / `policy/*`. */
export function failureModelLabel(model: string | null | undefined): string {
  const m = String(model ?? '').trim();
  if (!m || m === 'none' || m.startsWith('policy/')) return '';
  return m;
}

const FAILURE_MODEL = Symbol.for('my-agent.failureModel');

/**
 * Attach the model that was running to a thrown error so an outer catch that
 * never saw the model resolution (e.g. one-shot image/research modes) can still
 * name it. Non-enumerable; primitives and placeholders are left untouched.
 */
export function tagFailureModel<T>(err: T, model: string | null | undefined): T {
  const label = failureModelLabel(model);
  if (!label || !err || typeof err !== 'object') return err;
  if (FAILURE_MODEL in (err as object)) return err;
  try {
    Object.defineProperty(err, FAILURE_MODEL, { value: label, enumerable: false, configurable: true });
  } catch {
    /* frozen error objects stay untagged */
  }
  return err;
}

/** Model label previously attached by `tagFailureModel` ('' when unknown). */
export function failureModelFromError(err: unknown): string {
  if (!err || typeof err !== 'object') return '';
  const v = (err as Record<symbol, unknown>)[FAILURE_MODEL];
  return typeof v === 'string' ? v : '';
}

/** Max infra retries on the same tool plane (user message already appended once). */
export function toolPlaneInfraRetryLimit(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(String(env.MY_AGENT_TOOL_PLANE_INFRA_RETRIES ?? '').trim(), 10);
  if (Number.isFinite(n)) return Math.min(5, Math.max(0, n));
  return 2;
}

/**
 * Optional recovery after ordinary infra retries are exhausted. Disabled by
 * default because it starts another complete agent run and can multiply prompt
 * tokens or repeat side effects. Operators may opt in explicitly.
 */
export function toolPlaneAutoResumeLimit(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(String(env.MY_AGENT_TOOL_PLANE_AUTO_RESUME ?? '').trim(), 10);
  if (Number.isFinite(n)) return Math.min(4, Math.max(0, n));
  return 0;
}

/** Whether session meta has enough breadcrumbs to make auto-resume useful. */
export function shouldAutoResumeAfterInfra(meta: {
  mutatedPaths?: string[] | null;
  readPaths?: string[] | null;
}): boolean {
  // Require real disk breadcrumbs. Infra retries (MY_AGENT_TOOL_PLANE_INFRA_RETRIES)
  // already cover cold-start 504.
  if ((meta.mutatedPaths?.length ?? 0) > 0) return true;
  if ((meta.readPaths?.length ?? 0) > 0) return true;
  return false;
}
