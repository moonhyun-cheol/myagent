import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { CaretDown, CaretUp, CircleNotch, Stop, Trash } from '@phosphor-icons/react';
import { cancelRunTerminalJob, listActiveRunTerminalJobs, type ActiveTerminalJob } from '../api/myAgentClient';
import { useWorkspaceStore } from '../store/workspaceStore';

/** Collapsible workspace terminal under Preview (PowerShell via /fs/run-terminal). */
export function TerminalPane() {
  const open = useWorkspaceStore((s) => s.terminalOpen);
  const busy = useWorkspaceStore((s) => s.terminalBusy);
  const jobId = useWorkspaceStore((s) => s.terminalJobId);
  const log = useWorkspaceStore((s) => s.terminalLog);
  const filesRoot = useWorkspaceStore((s) => s.filesRoot);
  const attention = useWorkspaceStore((s) => s.terminalAttention);
  const setTerminalOpen = useWorkspaceStore((s) => s.setTerminalOpen);
  const clearTerminalLog = useWorkspaceStore((s) => s.clearTerminalLog);
  const clearTerminalAttention = useWorkspaceStore((s) => s.clearTerminalAttention);
  const runTerminalCommand = useWorkspaceStore((s) => s.runTerminalCommand);
  const cancelTerminalCommand = useWorkspaceStore((s) => s.cancelTerminalCommand);
  const [draft, setDraft] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [liveJobs, setLiveJobs] = useState<ActiveTerminalJob[]>([]);
  const outRef = useRef<HTMLPreElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const folderName = filesRoot
    ? filesRoot.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'workspace'
    : 'workspace';
  const prompt = `PS ${folderName}>`;

  useEffect(() => {
    if (!open) return;
    const el = outRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log, open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Poll agent + UI shell jobs while terminal is open (or a UI command is running).
  useEffect(() => {
    if (!open && !busy) {
      setLiveJobs([]);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const doc = await listActiveRunTerminalJobs();
        if (!cancelled) setLiveJobs(doc.jobs);
      } catch {
        if (!cancelled) setLiveJobs([]);
      }
    };
    void tick();
    const t = window.setInterval(() => void tick(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [open, busy]);

  useEffect(() => {
    const input = inputRef.current;
    if (!open || !input) return;
    const onHistoryKey = (event: globalThis.KeyboardEvent) => {
      if (busy || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
      event.preventDefault();
      if (event.key === 'ArrowUp') {
        const next = Math.min(historyIndex + 1, history.length - 1);
        if (history[next]) {
          setHistoryIndex(next);
          setDraft(history[history.length - 1 - next]);
        }
        return;
      }
      if (historyIndex <= 0) {
        setHistoryIndex(-1);
        setDraft('');
        return;
      }
      const next = historyIndex - 1;
      setHistoryIndex(next);
      setDraft(history[history.length - 1 - next] || '');
    };
    input.addEventListener('keydown', onHistoryKey);
    return () => input.removeEventListener('keydown', onHistoryKey);
  }, [busy, history, historyIndex, open]);

  // Keep the Cursor-style blink visible for a few pulses, then clear.
  useEffect(() => {
    if (!attention) return;
    const t = window.setTimeout(() => clearTerminalAttention(), 2600);
    return () => window.clearTimeout(t);
  }, [attention, clearTerminalAttention]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const cmd = draft.trim();
    if (!cmd || busy) return;
    setDraft('');
    setHistory((previous) => [
      ...previous.filter((item) => item !== cmd),
      cmd,
    ].slice(-50));
    setHistoryIndex(-1);
    void runTerminalCommand(cmd);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setTerminalOpen(false);
    }
  };

  const cancelJob = async (id: string) => {
    try {
      await cancelRunTerminalJob({ jobId: id });
      if (id === jobId) await cancelTerminalCommand();
      const doc = await listActiveRunTerminalJobs();
      setLiveJobs(doc.jobs);
    } catch {
      /* best-effort */
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setTerminalOpen(true)}
        className={`flex h-8 w-full shrink-0 items-center justify-between border-t px-3 text-[11px] text-muted hover:bg-ink hover:text-text ${
          attention
            ? 'animate-terminal-attention border-accent/60 bg-accent/15 text-accent'
            : 'border-line bg-panel'
        }`}
        title="터미널 열기 (Ctrl+`)"
      >
        <span className="inline-flex items-center gap-1.5 font-medium uppercase tracking-[0.12em]">
          <CaretUp size={12} weight="bold" />
          Terminal
          {attention ? <span className="normal-case tracking-normal text-[10px]">· 작업 완료</span> : null}
          {liveJobs.length > 0 ? (
            <span className="normal-case tracking-normal text-[10px] text-accent">
              · {liveJobs.length} job
            </span>
          ) : null}
        </span>
        <span className="truncate text-[10px] text-muted/70">
          {filesRoot ? filesRoot : '폴더 미연결'}
        </span>
      </button>
    );
  }

  return (
    <div
      className={`flex h-full min-h-0 flex-col border-t bg-[#cdd4d0] ${
        attention ? 'animate-terminal-attention border-accent/60' : 'border-line'
      }`}
      onClick={() => {
        if (attention) clearTerminalAttention();
      }}
    >
      <div
        className={`flex shrink-0 items-center justify-between border-b px-3 py-1.5 ${
          attention ? 'border-accent/40 bg-accent/10' : 'border-line/80 bg-panel'
        }`}
      >
        <button
          type="button"
          onClick={() => setTerminalOpen(false)}
          className={`inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] hover:text-text ${
            attention ? 'text-accent' : 'text-muted'
          }`}
          title="터미널 접기 (Ctrl+`)"
        >
          <CaretDown size={12} weight="bold" />
          Terminal
          {busy ? <CircleNotch size={12} className="animate-spin text-accent" /> : null}
          {busy ? (
            <span className="normal-case tracking-normal text-[10px] text-accent">
              · 실행 중{jobId ? ` (${jobId.slice(0, 14)}…)` : ''}
            </span>
          ) : null}
          {attention && !busy ? (
            <span className="normal-case tracking-normal text-[10px]">· 작업 완료</span>
          ) : null}
        </button>
        <div className="flex items-center gap-2">
          {busy ? (
            <button
              type="button"
              onClick={() => void cancelTerminalCommand()}
              className="inline-flex items-center gap-1 rounded-md border border-red-400/40 px-1.5 py-0.5 text-[10px] font-medium text-red-200 hover:bg-red-950/30"
              title="실행 중인 명령 중지"
              data-testid="terminal-cancel"
            >
              <Stop size={11} weight="fill" />
              Stop
            </button>
          ) : null}
          <span className="max-w-[220px] truncate text-[10px] text-muted/70" title={filesRoot ?? undefined}>
            {filesRoot ? filesRoot : '작업 폴더 미연결'}
          </span>
          <button
            type="button"
            onClick={() => clearTerminalLog()}
            className="rounded p-1 text-muted hover:bg-ink hover:text-text"
            title="로그 지우기"
            aria-label="로그 지우기"
          >
            <Trash size={13} />
          </button>
        </div>
      </div>

      {liveJobs.length > 0 ? (
        <div
          className="shrink-0 border-b border-line/60 bg-panel/80 px-3 py-1.5"
          data-testid="terminal-active-jobs"
        >
          <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.1em] text-muted">
            Active jobs ({liveJobs.length})
          </p>
          <ul className="max-h-20 space-y-1 overflow-y-auto">
            {liveJobs.map((j) => (
              <li key={j.id} className="flex items-center gap-2 text-[10px] text-muted">
                <span
                  className={`shrink-0 rounded px-1 py-px uppercase ${
                    j.kind === 'agent'
                      ? 'bg-accent/15 text-accent'
                      : j.kind === 'ui'
                        ? 'bg-sky-500/15 text-sky-200'
                        : 'bg-ink text-muted'
                  }`}
                >
                  {j.kind}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-text/80" title={j.command}>
                  {j.command}
                </span>
                <span className="shrink-0 text-muted/70">{Math.round(j.age_ms / 1000)}s</span>
                <button
                  type="button"
                  className="shrink-0 rounded border border-red-400/30 px-1 py-px text-red-200 hover:bg-red-950/30"
                  onClick={() => void cancelJob(j.id)}
                >
                  Stop
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <pre
        ref={outRef}
        className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[12px] leading-relaxed text-text/90 whitespace-pre-wrap break-words"
      >
        {log || (
          <span className="text-muted">
            PowerShell · {folderName}
            <br />
            예: <code className="text-accent/80">npm --version</code>
          </span>
        )}
      </pre>

      <form
        onSubmit={submit}
        className="flex shrink-0 items-center gap-2 border-t border-line/80 bg-panel px-3 py-1.5"
      >
        <span className="shrink-0 font-mono text-[12px] text-accent">{prompt}</span>
        <input
          ref={inputRef}
          type="text"
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={busy ? '실행 중… Stop으로 취소' : '명령 입력'}
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-text outline-none placeholder:text-muted/50 disabled:opacity-60"
        />
        {busy ? (
          <button
            type="button"
            onClick={() => void cancelTerminalCommand()}
            className="rounded-md border border-red-400/50 bg-red-950/30 px-2.5 py-1 text-[11px] font-medium text-red-200"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!draft.trim()}
            className="rounded-md bg-accent/90 px-2.5 py-1 text-[11px] font-medium text-ink disabled:opacity-40"
          >
            Run
          </button>
        )}
      </form>
    </div>
  );
}
