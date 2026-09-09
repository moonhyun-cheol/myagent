import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { CaretDown, CaretUp, Stop, Trash } from '@phosphor-icons/react';
import { cancelRunTerminalJob, listActiveRunTerminalJobs, type ActiveTerminalJob } from '../api/myAgentClient';
import { useWorkspaceStore } from '../store/workspaceStore';

type CancelState = 'requesting' | 'accepted' | 'failed';

/** Summary remains mounted and visible when folded. ACK is not a final process result. */
export function TerminalPane() {
  const open = useWorkspaceStore(s => s.terminalOpen);
  const busy = useWorkspaceStore(s => s.terminalBusy);
  const agentBusy = useWorkspaceStore(s => s.busy);
  const jobId = useWorkspaceStore(s => s.terminalJobId);
  const log = useWorkspaceStore(s => s.terminalLog);
  const filesRoot = useWorkspaceStore(s => s.filesRoot);
  const attention = useWorkspaceStore(s => s.terminalAttention);
  const clearTerminalAttention = useWorkspaceStore(s => s.clearTerminalAttention);
  const setTerminalOpen = useWorkspaceStore(s => s.setTerminalOpen);
  const clearTerminalLog = useWorkspaceStore(s => s.clearTerminalLog);
  const runTerminalCommand = useWorkspaceStore(s => s.runTerminalCommand);
  const [draft, setDraft] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [liveJobs, setLiveJobs] = useState<ActiveTerminalJob[]>([]);
  const [jobsError, setJobsError] = useState(false);
  const [cancels, setCancels] = useState<Record<string, CancelState>>({});
  const inFlight = useRef(new Set<string>());
  const outRef = useRef<HTMLPreElement>(null);
  const summaryRef = useRef<HTMLButtonElement>(null);
  const followOutput = useRef(true);
  const folderName = filesRoot?.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '폴더 미연결';

  useEffect(() => {
    if (open && followOutput.current && outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight;
  }, [log, open]);
  useEffect(() => {
    if (!attention) return;
    const timer = window.setTimeout(clearTerminalAttention, 2600);
    return () => window.clearTimeout(timer);
  }, [attention, clearTerminalAttention]);
  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      try {
        const doc = await listActiveRunTerminalJobs();
        if (!cancelled) {
          setJobsError(!doc.ok);
          if (doc.ok) setLiveJobs(doc.jobs);
        }
      } catch { if (!cancelled) setJobsError(true); }
      if (!cancelled) timer = window.setTimeout(() => void tick(), open || busy || agentBusy ? 2000 : 6000);
    };
    void tick();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [open, busy, agentBusy]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const cmd = draft.trim();
    if (!cmd || busy) return;
    setDraft(''); setHistoryIndex(-1); followOutput.current = true;
    setHistory(previous => [...previous.filter(item => item !== cmd), cmd].slice(-50));
    void runTerminalCommand(cmd);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Escape') { e.preventDefault(); setTerminalOpen(false); summaryRef.current?.focus({ preventScroll: true }); }
    if (busy || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const next = e.key === 'ArrowUp' ? Math.min(historyIndex + 1, history.length - 1) : Math.max(-1, historyIndex - 1);
    setHistoryIndex(next); setDraft(next < 0 ? '' : history[history.length - 1 - next] || '');
  };
  const cancelJob = async (id: string) => {
    if (inFlight.current.has(id) || cancels[id] === 'accepted') return;
    inFlight.current.add(id);
    setCancels(old => ({ ...old, [id]: 'requesting' }));
    try {
      const result = await cancelRunTerminalJob({ jobId: id });
      setCancels(old => ({ ...old, [id]: result.ok && result.cancelled ? 'accepted' : 'failed' }));
    } catch { setCancels(old => ({ ...old, [id]: 'failed' })); }
    finally { inFlight.current.delete(id); }
  };
  const stopButton = (id: string, name: string) => <button type="button" className="ui-danger shrink-0"
    data-testid={id === jobId ? 'terminal-cancel' : undefined} aria-label={`${name} 중지`}
    disabled={cancels[id] === 'requesting' || cancels[id] === 'accepted'} onClick={() => void cancelJob(id)}>
    <Stop size={14} weight="fill" />{cancels[id] === 'requesting' ? '정지 요청 중…' : cancels[id] === 'accepted' ? '요청 접수됨' : '중지'}
  </button>;
  const count = liveJobs.length + (busy && jobId && !liveJobs.some(job => job.id === jobId) ? 1 : 0);
  const finalLine = log.trim().split(/\r?\n/).at(-1) || '';
  const resultLabel = finalLine === '[cancelled]' ? '실제 중단됨' : /\(failed\)\]$|^ERROR:/.test(finalLine) ? '명령 실패'
    : /^\[exit 0\]$/.test(finalLine) ? '명령 완료' : log ? '로그 있음' : '대기';
  const activeIds = new Set(liveJobs.map(job => job.id));
  if (busy && jobId) activeIds.add(jobId);
  const cancelStates = [...activeIds].map(id => cancels[id]);
  const requestingCount = cancelStates.filter(state => state === 'requesting').length;
  const acceptedCount = cancelStates.filter(state => state === 'accepted').length;
  const hasCancelFailure = cancelStates.includes('failed');
  const summary = `${count || busy ? `실행 중 ${Math.max(1, count)}개` : resultLabel}${requestingCount ? ` · 정지 요청 중 ${requestingCount}개` : ''}${acceptedCount ? ` · 정지 결과 대기 ${acceptedCount}개` : ''}${hasCancelFailure ? ' · 정지 요청 실패' : ''}${jobsError ? ' · 실행 목록 확인 불가' : ''}`;

  return <div className="terminal-surface flex h-full min-h-0 flex-col" data-testid="terminal-pane">
    <div className="flex shrink-0 items-center border-b border-line bg-panel">
      <button ref={summaryRef} type="button" className="terminal-summary min-w-0 flex-1" onClick={() => { setTerminalOpen(!open); if (attention) clearTerminalAttention(); }}
        data-attention={attention} aria-expanded={open} aria-controls="terminal-details" title={`${summary} · ${open ? '접기' : '열기'} (Ctrl+\`) · ${filesRoot || folderName}`}>
        {open ? <CaretDown size={14} /> : <CaretUp size={14} />}<span>터미널 · {summary}</span>
      </button>
      {open && <button type="button" onClick={clearTerminalLog} className="ui-secondary m-1" title="화면 로그만 지웁니다. 실행 중인 프로세스는 종료하지 않습니다." aria-label="로그만 지우기"><Trash size={15} /></button>}
    </div>
    <div id="terminal-details" className="flex min-h-0 flex-1 flex-col" style={{ display: open ? undefined : 'none' }}>
      {(jobsError || hasCancelFailure) && <p role="status" className="px-3 py-1 text-xs text-danger">{jobsError ? '실행 목록을 확인하지 못했습니다. 마지막 목록을 표시하며 자동 재시도합니다. ' : ''}{hasCancelFailure ? '정지 요청 실패 또는 이미 종료된 작업입니다. 로그를 확인한 뒤 필요하면 다시 시도하세요.' : ''}</p>}
      {liveJobs.length > 0 && <details className="shrink-0 border-b border-line px-3 py-1" data-testid="terminal-active-jobs">
        <summary>실행 작업 {liveJobs.length}개 · 명령과 개별 중지</summary>
        <ul className="max-h-36 space-y-2 overflow-auto py-2">
          {liveJobs.map(job => <li key={job.id} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted">{job.kind === 'agent' ? '에이전트' : job.kind === 'ui' ? '직접 실행' : job.kind} · {Math.round(job.age_ms / 1000)}초</span>
            <code className="min-w-0 flex-1 break-all text-text">{job.command}</code>{stopButton(job.id, job.command)}
            {cancels[job.id] === 'accepted' && <span className="text-warning">요청 접수 · 최종 결과는 실행 로그에서 확인</span>}
          </li>)}
        </ul>
      </details>}
      <pre ref={outRef} tabIndex={0} aria-label="터미널 출력" onScroll={e => { const el = e.currentTarget; followOutput.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32; }}
        className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-xs leading-relaxed text-text">
        {log || <span className="text-muted">PowerShell · {folderName}\n명령을 직접 입력하거나 에이전트 실행 내역을 펼쳐 확인하세요.</span>}
      </pre>
      {!busy && log && <p role="status" className={`px-3 text-xs ${resultLabel === '명령 실패' ? 'text-danger' : 'text-muted'}`}>{resultLabel}</p>}
      <form onSubmit={submit} className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line bg-panel px-3 py-2">
        <label className="flex min-w-0 flex-1 items-center gap-2 text-xs"><span className="text-accent">PS &gt;</span>
          <input aria-label="PowerShell 명령" type="text" value={draft} disabled={busy} onChange={e => setDraft(e.target.value)} onKeyDown={onKeyDown}
            placeholder={busy ? '명령 실행 중…' : '명령 입력'} spellCheck={false} autoComplete="off" className="min-w-0 flex-1 bg-transparent py-1 font-mono text-text" />
        </label>
        {busy ? jobId ? stopButton(jobId, '직접 실행 명령') : <span className="text-xs text-muted">시작 중…</span>
          : <button type="submit" disabled={!draft.trim()} className="ui-primary">실행</button>}
      </form>
    </div>
  </div>;
}
