import { useEffect, useRef, useState } from 'react';
import type { ToolActivity, WorkTimelineItem } from '../types';

const duration = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

interface ToolActivityLogProps {
  rows: ToolActivity[];
  timeline?: WorkTimelineItem[];
  live: boolean;
  modelResponse?: string;
  streamPreview?: string;
}

type DisplayItem =
  | { kind: 'response'; id: string; text: string }
  | { kind: 'tool-group'; id: string; rows: ToolActivity[] };

/** Chronological model-response and execution events, followed by the final answer in the chat bubble. */
export function ToolActivityLog({ rows, timeline, live, modelResponse, streamPreview }: ToolActivityLogProps) {
  const running = rows.some((row) => row.state === 'running');
  const byId = new Map(rows.map((row) => [row.id, row]));
  const seenTools = new Set<string>();
  const chronological: Array<{ kind: 'response'; id: string; text: string } | { kind: 'tool'; activity: ToolActivity }> = [];
  if (timeline?.length) {
    timeline.forEach((item, index) => {
      if (item.kind === 'response') {
        if (item.text.trim()) chronological.push({ kind: 'response', id: `response:${index}`, text: item.text });
        return;
      }
      const activity = byId.get(item.id);
      if (activity) {
        seenTools.add(activity.id);
        chronological.push({ kind: 'tool', activity });
      }
    });
  } else {
    if (modelResponse?.trim()) chronological.push({ kind: 'response', id: 'legacy-response', text: modelResponse.trim() });
  }
  for (const activity of rows) {
    if (!seenTools.has(activity.id)) chronological.push({ kind: 'tool', activity });
  }
  if (streamPreview?.trim()) chronological.push({ kind: 'response', id: 'stream-preview', text: streamPreview });

  const displayItems = chronological.reduce<DisplayItem[]>((grouped, item) => {
    if (item.kind === 'response') {
      grouped.push(item);
      return grouped;
    }
    const groupId = item.activity.activityGroupId ?? `legacy-tool:${item.activity.id}`;
    const previous = grouped.at(-1);
    if (previous?.kind === 'tool-group' && previous.id === groupId) previous.rows.push(item.activity);
    else grouped.push({ kind: 'tool-group', id: groupId, rows: [item.activity] });
    return grouped;
  }, []);

  const [now, setNow] = useState(Date.now);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState(live);
  const wasLive = useRef(live);

  const cancel = async (row: ToolActivity) => {
    if (pending[row.id] || row.cancelRequested) return;
    setPending((old) => ({ ...old, [row.id]: true }));
    setErrors((old) => ({ ...old, [row.id]: '' }));
    try {
      const response = await fetch('/fs/tool-execution/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: row.id, session_id: row.cancelSessionId }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        throw new Error(response.status === 409
          ? '이미 종료되었거나 취소할 수 없는 실행입니다.'
          : '중지 요청 실패. 다시 시도하세요.');
      }
    } catch (error) {
      setPending((old) => ({ ...old, [row.id]: false }));
      setErrors((old) => ({ ...old, [row.id]: error instanceof Error ? error.message : '중지 요청 실패' }));
    }
  };

  const cancelButton = (row: ToolActivity) => row.state === 'running' && row.cancelSessionId ? (
    <button
      type="button"
      className="ui-danger ml-2"
      disabled={pending[row.id] || row.cancelRequested}
      aria-label={`${row.tool} 하위 실행 중지`}
      onClick={(event) => { event.preventDefault(); event.stopPropagation(); void cancel(row); }}
    >
      {pending[row.id] || row.cancelRequested ? '중지 요청 중…' : '실행 중지'}
    </button>
  ) : null;

  const cancelGroupButton = (groupNumber: number, groupRows: ToolActivity[]) => {
    const cancellableRows = groupRows.filter((row) => row.state === 'running' && row.cancelSessionId);
    if (!cancellableRows.length) return null;
    const requesting = cancellableRows.every((row) => pending[row.id] || row.cancelRequested);
    return (
      <button
        type="button"
        className="ml-auto shrink-0 rounded-lg border border-amber-400/40 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-100 transition-colors hover:bg-amber-500/20 disabled:opacity-50"
        disabled={requesting}
        aria-label={`작업 ${groupNumber} 중단 후 이어가기`}
        title="이 작업의 실행 가능한 하위 도구만 중단하고 같은 대화는 계속 진행합니다."
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void Promise.all(cancellableRows.map((row) => cancel(row)));
        }}
      >
        {requesting ? '중단 요청 중…' : '중단 후 이어가기'}
      </button>
    );
  };

  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => {
    if (live) setExpanded(true);
    else if (wasLive.current) setExpanded(false);
    wasLive.current = live;
  }, [live]);

  if (!displayItems.length) return null;

  const label = (row: ToolActivity) => row.state === 'running'
    ? live ? row.cancelRequested ? '중지 요청 중' : '실행 중' : '연결 종료 · 완료 상태 미수신'
    : ({ success: '완료', failed: '실패', cancelled: '사용자/실행 취소' } as const)[row.state];
  const elapsed = (row: ToolActivity) => duration(
    (row.finishedAt ?? (row.state === 'running' ? now : row.updatedAt)) - row.startedAt,
  );
  const groupState = (groupRows: ToolActivity[]) => {
    if (groupRows.some((row) => row.state === 'running')) return 'running' as const;
    if (groupRows.some((row) => row.state === 'failed')) return 'failed' as const;
    if (groupRows.some((row) => row.state === 'cancelled')) return 'cancelled' as const;
    return 'success' as const;
  };
  const groupElapsed = (groupRows: ToolActivity[]) => {
    const startedAt = Math.min(...groupRows.map((row) => row.startedAt));
    const finishedAt = Math.max(...groupRows.map((row) => row.finishedAt ?? (row.state === 'running' ? now : row.updatedAt)));
    return duration(finishedAt - startedAt);
  };
  const responseCount = displayItems.filter((item) => item.kind === 'response').length;
  const toolGroupCount = displayItems.filter((item) => item.kind === 'tool-group').length;
  let responseNumber = 0;
  let toolGroupNumber = 0;

  return (
    <details
      className="my-2 w-full min-w-0 text-xs"
      data-work-timeline
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="cursor-pointer select-none rounded-lg border border-line/80 bg-ink/20 px-3 py-2 text-text marker:text-muted">
        <span className="font-medium">중간 추론 및 작업 로그</span>
        <span className="text-muted">
          {' '}· 응답 {responseCount} · 작업 {toolGroupCount}{live ? ' · 진행 중' : ' · 완료'}
        </span>
      </summary>
      <div className="mt-2 min-w-0 border-l border-line/80 pl-3" aria-label="모델 응답과 실제 작업의 시간순 흐름">
        {displayItems.map((item) => {
          if (item.kind === 'response') {
            responseNumber += 1;
            return (
              <section key={item.id} className="mb-3 min-w-0" data-timeline-kind="response">
                <p className="mb-1 font-medium text-text">응답 {responseNumber}</p>
                <div className="whitespace-pre-wrap break-words text-text/80">{item.text}</div>
                {item.id === 'stream-preview' && live ? <p className="mt-1 text-[11px] text-muted">생성 중</p> : null}
              </section>
            );
          }
          toolGroupNumber += 1;
          const state = groupState(item.rows);
          const stateLabel = state === 'running'
            ? live ? '실행 중' : '연결 종료 · 완료 상태 미수신'
            : ({ success: '완료', failed: '실패', cancelled: '사용자/실행 취소' } as const)[state];
          return (
            <section
              key={item.id}
              className="mb-3 min-w-0"
              data-timeline-kind="tool-group"
              data-activity-group-id={item.id}
              data-tool-state={state}
            >
              <div className={`mb-1 flex items-center gap-2 ${state === 'failed' ? 'text-danger' : 'text-text'}`}>
                <span className="min-w-0">
                  <span className="font-medium">작업 {toolGroupNumber}</span> · {item.rows.length}개 도구 · {stateLabel} · {groupElapsed(item.rows)}
                </span>
                {cancelGroupButton(toolGroupNumber, item.rows)}
              </div>
              <div className="space-y-2 border-l border-line/70 pl-3">
                {item.rows.map((row) => (
                  <div key={row.id} className="min-w-0" data-timeline-kind="tool" data-tool-state={row.state}>
                    <div className={row.state === 'failed' ? 'text-danger' : 'text-text'}>
                      <span className="font-medium">{row.tool}</span> · {label(row)} · {elapsed(row)}
                      {row.exitCode !== undefined ? ` · 종료 코드 ${row.exitCode ?? '없음'}` : ''}
                      {cancelButton(row)}
                    </div>
                    {errors[row.id] ? <p role="alert" className="text-danger">{errors[row.id]}</p> : null}
                    {row.target ? <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-muted">{row.target}</pre> : null}
                    {row.output
                      ? <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-text/90">{row.output}</pre>
                      : <p className="mt-1 text-muted">{row.state === 'running' ? '출력 대기 중…' : '출력 없음'}</p>}
                    {row.truncated ? <p className="text-warning">일부 로그 생략 · 최근 출력만 표시</p> : null}
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </details>
  );
}
