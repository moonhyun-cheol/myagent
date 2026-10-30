import type { SessionMessage } from '../sessions/types.js';

/**
 * 자동화 실행의 임시 대화는 실행 직후 삭제되므로, 삭제 전에 중간 과정(메시지·도구 호출)을
 * `outputs/automations/<runId>/trace.jsonl`로 남긴다. tool_activity는 이미 표시용으로
 * 가린(redacted) 값이며, 용량 폭주를 막기 위해 본문은 잘라서 기록한다.
 */
const MAX_CONTENT_CHARS = 4_000;
const MAX_TOOL_OUTPUT_CHARS = 2_000;
const MAX_TOOL_ROWS_PER_MESSAGE = 200;

export type SchedulerTraceEntry =
  | { type: 'run'; event: 'start' | 'end'; at: string; ok?: boolean; error?: string; duration_ms?: number }
  | {
    type: 'message';
    role: SessionMessage['role'];
    at: string;
    model?: string;
    status?: SessionMessage['status'];
    content: string;
    content_truncated: boolean;
  }
  | {
    type: 'tool';
    tool: string;
    target: string;
    state: string;
    started_at: string | null;
    finished_at: string | null;
    exit_code?: number | null;
    failure_kind?: string;
    output: string;
    output_truncated: boolean;
  };

function clip(text: unknown, limit: number): { text: string; truncated: boolean } {
  const value = String(text ?? '');
  return value.length > limit
    ? { text: `${value.slice(0, limit)}…`, truncated: true }
    : { text: value, truncated: false };
}

function isoOrNull(ms: unknown): string | null {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function buildSchedulerTraceEntries(messages: SessionMessage[] | undefined): SchedulerTraceEntry[] {
  const entries: SchedulerTraceEntry[] = [];
  for (const message of messages ?? []) {
    const content = clip(message.content, MAX_CONTENT_CHARS);
    entries.push({
      type: 'message',
      role: message.role,
      at: message.at,
      ...(message.model ? { model: message.model } : {}),
      ...(message.status ? { status: message.status } : {}),
      content: content.text,
      content_truncated: content.truncated,
    });
    for (const row of (message.tool_activity ?? []).slice(0, MAX_TOOL_ROWS_PER_MESSAGE)) {
      const output = clip(row.output, MAX_TOOL_OUTPUT_CHARS);
      entries.push({
        type: 'tool',
        tool: row.tool,
        target: row.target,
        state: row.state,
        started_at: isoOrNull(row.startedAt),
        finished_at: isoOrNull(row.finishedAt),
        ...(row.exitCode !== undefined ? { exit_code: row.exitCode } : {}),
        ...(row.failureKind ? { failure_kind: row.failureKind } : {}),
        output: output.text,
        output_truncated: output.truncated || row.truncated === true,
      });
    }
  }
  return entries;
}
