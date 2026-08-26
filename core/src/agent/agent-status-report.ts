/** Human-readable phase line for the operational status channel only. */
export function formatAgentPhaseStatus(opts: {
  step: number;
  providerLabel: string;
  payloadKb?: number;
  kind: 'model' | 'tools' | 'client' | 'answer' | 'self_correct';
  /** Extra suffix after provider (e.g. sticky protocol reason). */
  detail?: string;
}): string {
  const phase =
    opts.kind === 'client'
      ? '도구 호출 생성 중'
      : opts.kind === 'tools'
        ? '다음 도구 계획 중'
        : opts.kind === 'answer'
          ? '최종 답변 작성 중'
          : opts.kind === 'self_correct'
            ? '해결 중… (도구 오류 자동 보정)'
            : '모델 응답 대기 중';
  const size =
    opts.payloadKb != null && opts.payloadKb >= 80
      ? ` · 컨텍스트 ~${opts.payloadKb}KB`
      : '';
  const detail = opts.detail?.trim() ? ` · ${opts.detail.trim()}` : '';
  return `${phase} · ${opts.step}번째 호출${size} — ${opts.providerLabel}${detail}`;
}

export function formatElapsedDuration(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${minutes}분 ${seconds}초`;
}

export async function awaitWithWaitStatus<T>(
  reportStatus: (text: string) => void,
  baseLabel: string,
  work: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const t0 = Date.now();
  reportStatus(`${baseLabel} · ${formatElapsedDuration(0)}`);
  const timer = setInterval(() => {
    if (signal?.aborted) return;
    const sec = Math.floor((Date.now() - t0) / 1000);
    reportStatus(`${baseLabel} · ${formatElapsedDuration(sec)}`);
  }, 1_000);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}


