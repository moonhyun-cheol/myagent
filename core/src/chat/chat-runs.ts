import { AsyncLocalStorage } from 'node:async_hooks';
import { beginActiveWork, endActiveWork } from '../system/active-work-registry.js';

export type ChatRunState = 'running' | 'cancelling' | 'stopped' | 'completed' | 'failed';
export interface ChatRun {
  sessionId: string;
  runId: string;
  state: ChatRunState;
  controller: AbortController;
  partial: string;
  updatedAt: number;
}

const context = new AsyncLocalStorage<ChatRun>();
const active = new Map<string, ChatRun>();
const runs = new Map<string, ChatRun>();
const key = (sessionId: string, runId: string) => JSON.stringify([sessionId, runId]);
const workKey = (sessionId: string) => `chat:${sessionId}`;
export const validChatRunId = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);

/** True while any chat/agent turn is in flight (update idle gate: session alive). */
export function hasActiveChatRuns(): boolean {
  return active.size > 0;
}

export function listActiveChatSessionIds(): string[] {
  return [...active.keys()];
}

export class ChatRunConflict extends Error {
  constructor(public readonly code: string) { super(code); }
}

// Retain terminal IDs (including cancel-before-start tombstones) for the process
// lifetime: forgetting a cancelled ID could admit an arbitrarily delayed POST.
// Refuse new IDs at capacity instead of silently reviving old work.
function reserve(run: ChatRun): void {
  if (runs.size >= 100_000) throw new ChatRunConflict('CHAT_RUN_CAPACITY');
  runs.set(key(run.sessionId, run.runId), run);
}

export function currentChatRun(): ChatRun | undefined { return context.getStore(); }
export function chatRunCanPublish(run = context.getStore()): boolean {
  return !run || (run.state === 'running' && !run.controller.signal.aborted && active.get(run.sessionId) === run);
}
export function assertChatRunWritable(sessionId?: string): void {
  const run = context.getStore();
  if (run && ((!chatRunCanPublish(run)) || (sessionId !== undefined && run.sessionId !== sessionId))) {
    throw new DOMException('Chat run stopped or superseded', 'AbortError');
  }
}

export function beginChatRun(sessionId: string, runId: string, signal?: AbortSignal): ChatRun {
  if (!validChatRunId(runId)) throw new ChatRunConflict('INVALID_RUN_ID');
  if (runs.has(key(sessionId, runId))) throw new ChatRunConflict('CHAT_RUN_ALREADY_USED');
  if (active.has(sessionId)) throw new ChatRunConflict('CHAT_RUN_BUSY');
  const run: ChatRun = { sessionId, runId, state: 'running', controller: new AbortController(), partial: '', updatedAt: Date.now() };
  reserve(run);
  active.set(sessionId, run);
  beginActiveWork(workKey(sessionId), `chat run ${runId}`);
  if (signal?.aborted) cancelChatRun(sessionId, runId);
  return run;
}

export function cancelChatRun(sessionId: string, runId: string): ChatRunState {
  if (!validChatRunId(runId)) throw new ChatRunConflict('INVALID_RUN_ID');
  let run = runs.get(key(sessionId, runId));
  if (!run) {
    // Cancellation may overtake the stream request. Never cancel by session only.
    run = { sessionId, runId, state: 'stopped', controller: new AbortController(), partial: '', updatedAt: Date.now() };
    run.controller.abort();
    reserve(run);
  } else if (run.state === 'running') {
    run.state = 'cancelling';
    run.updatedAt = Date.now();
    run.controller.abort();
  }
  return run.state;
}

export async function executeChatRun<T>(
  run: ChatRun,
  signal: AbortSignal | undefined,
  work: (signal: AbortSignal) => Promise<T>,
  onStopped: (run: ChatRun) => void,
): Promise<T | undefined> {
  const abort = () => { cancelChatRun(run.sessionId, run.runId); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let failed = false;
  try {
    return await context.run(run, async () => {
      assertChatRunWritable(run.sessionId);
      return work(run.controller.signal);
    });
  } catch (error) {
    if (!run.controller.signal.aborted) { failed = true; throw error; }
    return undefined;
  } finally {
    signal?.removeEventListener('abort', abort);
    // Keep admission locked until execution AND stopped-record persistence finish.
    // This callback is deliberately outside the cancelled async context.
    if (run.controller.signal.aborted) onStopped(run);
    run.state = run.controller.signal.aborted ? 'stopped' : failed ? 'failed' : 'completed';
    run.updatedAt = Date.now();
    run.partial = '';
    if (active.get(run.sessionId) === run) {
      active.delete(run.sessionId);
      endActiveWork(workKey(run.sessionId));
    }
  }
}
