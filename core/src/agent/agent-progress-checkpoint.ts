import type { VerifyWitness } from './agent-claim-gates.js';

export const PROGRESSIVE_STAGE_ROUNDS = 10;
export const MAX_PROGRESSIVE_STAGES = 10;
/**
 * A single app execution stops after three stages, leaving ample room below
 * the host's 45 physical LLM-request ceiling for provider retries.
 */
export const MAX_PROGRESSIVE_RUN_ROUNDS = 30;
export const MAX_PROGRESSIVE_TOTAL_ROUNDS =
  PROGRESSIVE_STAGE_ROUNDS * MAX_PROGRESSIVE_STAGES;
/** Max agent runs in one user turn: first segment + silent auto-chains. */
export const MAX_PROGRESSIVE_AUTO_CHAINS = Math.ceil(
  MAX_PROGRESSIVE_TOTAL_ROUNDS / MAX_PROGRESSIVE_RUN_ROUNDS,
);
export const FAILURE_CHECKPOINT_THRESHOLD = 3;

/**
 * One orchestration step is one model decision cycle followed by zero or more
 * tool calls. It is not a tool-call count; an infrastructure retry may issue an
 * additional physical LLM request inside the same step.
 */
export const ORCHESTRATION_STEP_DEFINITION =
  '1 step = 1 model decision cycle + 0..N tool calls (infra retry may add an LLM request)';

export type ProgressCheckpointReason = 'stage_boundary' | 'three_failures' | 'budget_exhausted';

export interface AgentProgressCheckpoint {
  version: 1;
  at: string;
  reason: ProgressCheckpointReason;
  step: number;
  stage: number;
  maxStages: number;
  failureCount: number;
  completed: string[];
  remaining: string[];
  resumeFrom: string;
  /** Last non-empty text authored by the model, capped for durable continuation. */
  modelOutput?: string;
  /** Runtime facts that must not be replaced with a synthetic policy model label. */
  runtime?: {
    model: string;
    elapsedMs: number;
    payloadChars: number;
  };
  /** Recent executed tool outcomes, newest last. */
  recentActivity?: string[];
}

export interface ProgressCheckpointInput {
  reason: ProgressCheckpointReason;
  step: number;
  maxSteps: number;
  failureCount: number;
  readPaths: string[];
  mutatedPaths: string[];
  toolsUsed: string[];
  failureDetails: string[];
  verifyWitness: VerifyWitness | null;
  activeTask?: {
    objective: string;
    acceptance: string;
    relatedPaths?: string[];
  } | null;
  modelOutput?: string;
  model?: string;
  elapsedMs?: number;
  payloadChars?: number;
  recentActivity?: string[];
  now?: string;
}

const unique = (values: string[], cap = 8): string[] =>
  [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))].slice(0, cap);

/** Round one app-run budget to ten-round stages while staying below the host limit. */
export function normalizeProgressiveMaxSteps(requested: number): number {
  const safe = Math.max(1, Math.floor(Number.isFinite(requested) ? requested : PROGRESSIVE_STAGE_ROUNDS));
  return Math.min(
    MAX_PROGRESSIVE_RUN_ROUNDS,
    Math.ceil(safe / PROGRESSIVE_STAGE_ROUNDS) * PROGRESSIVE_STAGE_ROUNDS,
  );
}

/** Remaining safe budget for a continuation chain capped at ten total stages. */
export function progressiveRunBudget(requested: number, priorSteps: number): number {
  const remaining = Math.max(0, MAX_PROGRESSIVE_TOTAL_ROUNDS - Math.max(0, Math.floor(priorSteps)));
  return Math.min(remaining, normalizeProgressiveMaxSteps(requested));
}

export function progressiveStageForStep(step: number): number {
  return Math.max(1, Math.ceil(Math.max(1, step) / PROGRESSIVE_STAGE_ROUNDS));
}

/**
 * Whether the host should silently start another 30-step segment in the same
 * user turn (no manual 「이어서」). Stops at the 100-step chain ceiling.
 */
export function shouldAutoChainProgressiveBudget(input: {
  kind?: string | null;
  step?: number | null;
}): boolean {
  if (input.kind !== 'continuation') return false;
  const step = Math.max(0, Math.floor(Number(input.step) || 0));
  return step > 0 && step < MAX_PROGRESSIVE_TOTAL_ROUNDS;
}

/** User-facing notice for a progressive budget stop (mid-chain vs hard cap). */
export function formatProgressiveBudgetNotice(checkpoint: {
  stage: number;
  maxStages: number;
  step: number;
}): { title: string; message: string } {
  const atCap = checkpoint.step >= MAX_PROGRESSIVE_TOTAL_ROUNDS;
  if (atCap) {
    return {
      title: '전체 진행 한도 도달',
      message:
        `${checkpoint.stage}/${checkpoint.maxStages}단계, 누적 ${checkpoint.step} 오케스트레이션 스텝까지 진행했습니다. `
        + '이 대화의 순차 진행 한도에 도달했습니다.',
    };
  }
  return {
    title: '단계 예산 소진 · 자동 이어가기',
    message:
      `${checkpoint.stage}/${checkpoint.maxStages}단계, 누적 ${checkpoint.step} 오케스트레이션 스텝 — `
      + '같은 요청에서 다음 단계를 자동으로 이어갑니다.',
  };
}

/** Build a deterministic, compact hand-off instead of asking the model to remember its loop. */
export function buildAgentProgressCheckpoint(input: ProgressCheckpointInput): AgentProgressCheckpoint {
  const completed: string[] = [];
  const remaining: string[] = [];
  const reads = unique(input.readPaths);
  const mutations = unique(input.mutatedPaths);
  const tools = unique(input.toolsUsed);
  const failures = unique(input.failureDetails, FAILURE_CHECKPOINT_THRESHOLD);

  if (reads.length) completed.push(`조회 확인: ${reads.join(', ')}`);
  if (mutations.length) completed.push(`수정 반영: ${mutations.join(', ')}`);
  if (tools.length) completed.push(`성공 도구: ${tools.join(', ')}`);
  if (input.verifyWitness?.ok === true) completed.push('Acceptance 검증 성공 기록 있음');
  if (!completed.length) completed.push('아직 확정된 조회·수정·검증 내역 없음');

  if (failures.length) remaining.push(`실패 복구: ${failures.join(' | ')}`);
  if (!mutations.length) remaining.push('대상 파일을 확정하고 첫 수정 반영');
  if (mutations.length && input.verifyWitness?.ok !== true) remaining.push('수정 경로에 대한 명시적 Acceptance 검증');
  if (input.activeTask?.acceptance) remaining.push(`수락 조건 확인: ${input.activeTask.acceptance}`);
  if (!remaining.length) remaining.push('현재 결과를 최종 점검하고 작업 종료 판단');

  const stage = progressiveStageForStep(input.step);
  const maxStages = Math.max(1, Math.ceil(input.maxSteps / PROGRESSIVE_STAGE_ROUNDS));
  const target = input.activeTask?.objective || '사용자의 최신 작업 목표';
  const related = unique(input.activeTask?.relatedPaths ?? [], 4);
  const modelOutput = String(input.modelOutput || '').trim().slice(-6_000);
  const model = String(input.model || '').trim();
  const recentActivity = unique(input.recentActivity ?? [], 8);
  const resumeFrom = [
    `${target} 기준으로 미완료 항목 첫 번째부터 재개`,
    related.length ? `우선 경로: ${related.join(', ')}` : '',
    failures.length ? '동일 실패 호출을 반복하지 말고 원인 조회 또는 다른 도구 경로 사용' : '',
  ].filter(Boolean).join(' · ');

  return {
    version: 1,
    at: input.now ?? new Date().toISOString(),
    reason: input.reason,
    step: input.step,
    stage,
    maxStages,
    failureCount: Math.max(0, input.failureCount),
    completed,
    remaining,
    resumeFrom,
    ...(modelOutput ? { modelOutput } : {}),
    ...(model
      ? {
          runtime: {
            model,
            elapsedMs: Math.max(0, Math.floor(input.elapsedMs ?? 0)),
            payloadChars: Math.max(0, Math.floor(input.payloadChars ?? 0)),
          },
        }
      : {}),
    ...(recentActivity.length ? { recentActivity } : {}),
  };
}

function formatElapsedMs(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatAgentProgressCheckpoint(checkpoint: AgentProgressCheckpoint): string {
  const reason = checkpoint.reason === 'three_failures'
    ? '도구 실패 3회 누적'
    : checkpoint.reason === 'budget_exhausted'
      ? '이번 실행 단계 예산 소진'
      : `${checkpoint.stage}단계 경계`;
  return [
    `## 중간 정리 (${reason}, ${checkpoint.stage}/${checkpoint.maxStages}단계)`,
    checkpoint.runtime
      ? `실행 메타: ${checkpoint.runtime.model} · ${checkpoint.step} 오케스트레이션 스텝 · ${formatElapsedMs(checkpoint.runtime.elapsedMs)} · 컨텍스트 ${Math.round(checkpoint.runtime.payloadChars / 1024)}KB`
      : '',
    '진행된 내역:',
    ...checkpoint.completed.map((item) => `- ${item}`),
    ...(checkpoint.recentActivity?.length
      ? ['최근 실행:', ...checkpoint.recentActivity.map((item) => `- ${item}`)]
      : []),
    '추가 과제:',
    ...checkpoint.remaining.map((item) => `- ${item}`),
    `재개 지점: ${checkpoint.resumeFrom}`,
    checkpoint.modelOutput ? `마지막 모델 출력:\n${checkpoint.modelOutput}` : '',
  ].filter(Boolean).join('\n');
}

export function formatAgentProgressCheckpointPrompt(checkpoint: AgentProgressCheckpoint): string {
  return [
    formatAgentProgressCheckpoint(checkpoint),
    '',
    'CONTROL: 위 중간 정리를 현재 사실 기준으로 검토한 뒤 재개 지점부터 계속 실행하라.',
    '이미 성공한 전체 조회를 반복하지 말고, 실패 원인을 바꾸거나 다음 미완료 과제를 처리하라.',
    '이 메시지에 계획만 답하고 멈추지 말라. 완료 조건을 충족하면 검증 후 종료하라.',
  ].join('\n');
}

export function formatAgentProgressResumeNote(checkpoint: AgentProgressCheckpoint): string {
  return [
    '## Persisted progress checkpoint',
    formatAgentProgressCheckpoint(checkpoint),
    'Continue from RESTART POINT. Do not repeat completed discovery unless the source changed.',
  ].join('\n');
}
