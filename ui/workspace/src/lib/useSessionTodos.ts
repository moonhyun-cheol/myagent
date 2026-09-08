import { useEffect, useState } from 'react';
import { fetchSessionTodos } from '../api/myAgentClient';
import type { TodoProgressItem } from '../components/WorkspaceObjectsPane';

/** Read only: never infer tasks or progress from assistant prose or execution state. */
export function useSessionTodos(sessionId: string | null, busy: boolean) {
  const [view, setView] = useState<{ sessionId: string | null; items: TodoProgressItem[]; error: string | null }>({ sessionId: null, items: [], error: null });
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const todos = await fetchSessionTodos(sessionId, controller.signal);
        if (!controller.signal.aborted) setView({ sessionId, items: todos.map((todo) => ({
          id: todo.id, label: todo.text, status: todo.status === 'doing' ? 'active' : todo.status,
          authoredBy: todo.authoredBy === 'model' ? 'model' : undefined,
        })), error: null });
      } catch {
        if (!controller.signal.aborted) setView({ sessionId, items: [], error: 'TODO를 불러오지 못했습니다. 자동으로 재시도합니다.' });
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), busy ? 1000 : 5000);
      }
    };
    void refresh();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [sessionId, busy]);
  // A previous session must never flash while the next request is pending.
  return view.sessionId === sessionId && sessionId ? view : { items: [], error: null };
}
