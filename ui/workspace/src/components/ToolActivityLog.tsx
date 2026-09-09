import { useEffect, useState } from 'react';
import type { ToolActivity } from '../types';

const duration = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/** Execution evidence only; deliberately separate from model reasoning. */
export function ToolActivityLog({ rows, live }: { rows: ToolActivity[]; live: boolean }) {
  const [now, setNow] = useState(Date.now);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const cancel = async (row: ToolActivity) => {
    if (pending[row.id] || row.cancelRequested) return;
    setPending(old => ({ ...old, [row.id]: true }));
    setErrors(old => ({ ...old, [row.id]: '' }));
    try {
      const response = await fetch('/fs/tool-execution/cancel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: row.id, session_id: row.cancelSessionId }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(response.status === 409 ? '이미 종료되었거나 취소할 수 없는 실행입니다.' : '중지 요청 실패. 다시 시도하세요.');
    } catch (error) {
      setPending(old => ({ ...old, [row.id]: false }));
      setErrors(old => ({ ...old, [row.id]: error instanceof Error ? error.message : '중지 요청 실패' }));
    }
  };
  const cancelButton = (row: ToolActivity) => live && row.state === 'running' && row.cancelSessionId ? (
    <button type="button" className="ui-danger ml-2"
      disabled={pending[row.id] || row.cancelRequested}
      aria-label={`${row.tool} 하위 실행 중지`}
      onClick={event => { event.preventDefault(); event.stopPropagation(); void cancel(row); }}>
      {pending[row.id] || row.cancelRequested ? '중지 요청 중…' : '실행 중지'}
    </button>
  ) : null;
  const running = live && rows.some((row) => row.state === 'running');
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  if (!rows.length) return null;
  const latest = [...rows].reverse().find((row) => row.state === 'running') ?? rows[rows.length - 1];
  const label = (row: ToolActivity) => row.state === 'running'
    ? live ? row.cancelRequested ? '중지 요청 중' : '실행 중' : '연결 종료 · 완료 상태 미수신'
    : ({ success: '완료', failed: '실패', cancelled: '사용자/실행 취소' } as const)[row.state];
  const elapsed = (row: ToolActivity) => duration((row.finishedAt ?? (live ? now : row.updatedAt)) - row.startedAt);
  const lastLine = latest.output.trim().split(/\r?\n/).filter(Boolean).at(-1);
  return (
    <details className="my-2 w-full min-w-0 rounded-xl border border-line bg-ink/30 text-xs" data-tool-activity>
      <summary className="cursor-pointer px-3 py-2 text-muted" aria-label="실제 작업 실행 로그">
        <span className="font-medium text-text">작업 로그 · {latest.tool} · {label(latest)} · {elapsed(latest)}</span>
        {running ? <span className="ml-2">{latest.lastOutputAt
          ? `최근 출력 ${duration(now - latest.lastOutputAt)} 전`
          : '출력 대기'}</span> : null}
        {cancelButton(latest)}
        {errors[latest.id] ? <span role="alert" className="block text-red-300">{errors[latest.id]}</span> : null}
        {lastLine ? <span className="mt-1 block truncate font-mono">{lastLine.slice(-180)}</span> : null}
      </summary>
      <div className="border-t border-line p-3" aria-label="실행 내역">
        <p className="mb-2 text-muted">최근 40개 작업 · 작업별 최근 12,000자 · 주요 비밀값 마스킹</p>
        {rows.map((row) => (
          <details key={row.id} className="mb-3 min-w-0" data-tool-state={row.state}>
            <summary className={row.state === 'failed' ? 'text-danger' : 'text-text'}>
              {row.tool} · {label(row)} · {elapsed(row)}
              {row.exitCode !== undefined ? ` · 종료 코드 ${row.exitCode ?? '없음'}` : ''}
              {cancelButton(row)}
            </summary>
            {errors[row.id] ? <p role="alert" className="text-red-300">{errors[row.id]}</p> : null}
            {row.target ? <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-muted">{row.target}</pre> : null}
            {row.output ? <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-text/90">{row.output}</pre>
              : <p className="mt-1 text-muted">{row.state === 'running' && live ? '출력 대기 중…' : '출력 없음'}</p>}
            {row.truncated ? <p className="text-warning">일부 로그 생략 · 최근 출력만 표시</p> : null}
          </details>
        ))}
      </div>
    </details>
  );
}
