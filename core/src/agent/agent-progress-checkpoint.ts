/**
 * Legacy persisted checkpoint shape. New runs write AgentContinuationSnapshot;
 * this type and formatter remain only to read sessions created before migration.
 */
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
  modelOutput?: string;
  runtime?: {
    model: string;
    elapsedMs: number;
    payloadChars: number;
  };
  recentActivity?: string[];
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
      ? '이전 실행 단계 예산 소진'
      : `${checkpoint.stage}단계 경계`;
  return [
    `## 이전 버전 중간 정리 (${reason}, ${checkpoint.stage}/${checkpoint.maxStages}단계)`,
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

export function formatAgentProgressResumeNote(checkpoint: AgentProgressCheckpoint): string {
  return [
    '## Persisted progress checkpoint (legacy read-only)',
    formatAgentProgressCheckpoint(checkpoint),
    'Continue from RESTART POINT. New progress must be persisted as TODO/Evidence Continuation Snapshot.',
  ].join('\n');
}
