/** Per-execution cancellation. Never abort the parent chat controller. */
const executions = new Map<string, { sessionId: string; controller: AbortController; requested: () => void }>();

export function registerToolExecution(id: string, sessionId: string, parent?: AbortSignal, requested = () => {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  executions.set(id, { sessionId, controller, requested });
  return {
    signal: controller.signal,
    dispose() {
      executions.delete(id);
      parent?.removeEventListener('abort', abort);
    },
  };
}

export function cancelToolExecution(id: string, sessionId: string): boolean {
  const execution = executions.get(id);
  if (!execution || execution.sessionId !== sessionId) return false;
  if (!execution.controller.signal.aborted) {
    execution.requested();
    execution.controller.abort();
  }
  return true;
}
