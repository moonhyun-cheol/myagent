import { appendFileSync } from 'node:fs';
import path from 'node:path';

function debugEnabled(): boolean {
  const v = process.env.CQR_DEBUG?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export function writeDebugSessionLog(
  cqrRoot: string,
  payload: {
    hypothesisId: string;
    location: string;
    message: string;
    data?: Record<string, unknown>;
    runId?: string;
  },
): void {
  if (!debugEnabled()) return;
  try {
    const logPath = path.join(cqrRoot, 'logs', 'cqr-debug.log');
    const entry = {
      timestamp: Date.now(),
      ...payload,
    };
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    /* ignore debug log failures */
  }
}

export function formatChatErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';
  const lower = raw.toLowerCase();

  if (raw.includes('OWUI_GATEWAY_TIMEOUT') || raw.includes('UPSTREAM_HTML_ERROR')) {
    return [
      '**MY OpenRouter 응답 시간 초과(504/502)**',
      '',
      'OpenRouter 또는 모델 제공사가 요청 처리 전에 연결을 끊었습니다.',
      '앱은 컨텍스트 축소 재시도와 자동 이어하기를 이미 수행했습니다.',
      '',
      '그래도 반복되면:',
      '1. 잠시 뒤 다시 시도하거나 더 빠른 모델 선택',
      '2. 요청을 더 작은 단위로 나누기',
    ].join('\n');
  }
  if (raw.includes('INVALID_RESPONSE') && raw.includes('504')) {
    return [
      '**MY OpenRouter 응답 시간 초과(504)**',
      '',
      '게이트웨이 HTML 오류 페이지가 반환되었습니다. 요청을 나눠 다시 시도하세요.',
    ].join('\n');
  }
  if (name === 'TimeoutError' || lower.includes('aborted') || lower.includes('timeout')) {
    return '요청 시간이 초과되었습니다. 긴 작업은 더 작은 단위로 나눠 다시 보내세요.';
  }
  if (raw.includes('EMPTY_COMPLETION')) {
    return '모델이 빈 응답을 반환했습니다. 모델 설정·컨텍스트 길이를 확인하세요.';
  }
  if (
    raw.includes('exceeded')
    && (raw.includes('tool steps') || raw.includes('LLM orchestration rounds'))
  ) {
    return `${raw} 이 상한은 개별 툴 수가 아니라 모델 왕복 횟수입니다. 작업을 더 작은 단위로 나눠 다시 요청하세요.`;
  }
  if (isUpstreamConnectionDrop(raw)) {
    return [
      '**답변 도중 연결이 끊겼습니다**',
      '',
      'OpenRouter 또는 모델 제공사가 응답을 끝까지 보내기 전에 연결을 닫은 경우가 많습니다.',
      '위에 이미 나온 글은 유지됩니다. 이어서 「이어서」라고 다시 보내거나, 요청을 짧게 나눠 주세요.',
    ].join('\n');
  }
  return raw;
}

/** Remote stream closed mid-response (undici "terminated", socket hang up, etc.). */
export function isUpstreamConnectionDrop(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('terminated')
    || message.includes('[1000]')
    || lower.includes('socket hang up')
    || lower.includes('econnreset')
    || lower.includes('other side closed')
    || lower.includes('fetch failed')
  );
}
