import { Brain, PencilSimple, Plus, Trash, X } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import {
  addUserMemory,
  deleteUserMemory,
  listUserMemory,
  updateUserMemory,
  type UserMemoryEntry,
  type UserMemoryScope,
} from '../api/myAgentClient';

const OPEN_EVENT = 'cqr:open-user-memory';

export interface UserMemoryPanelDetail {
  projectId?: string | null;
  title?: string;
}

/** Open the user memory panel from anywhere (sidebar context menus, settings, …). */
export function openUserMemoryPanel(detail: UserMemoryPanelDetail = {}): void {
  window.dispatchEvent(new CustomEvent<UserMemoryPanelDetail>(OPEN_EVENT, { detail }));
}

function MemorySection({
  label,
  scope,
  projectId,
  entries,
  onChanged,
  onError,
}: {
  label: string;
  scope: UserMemoryScope;
  projectId?: string | null;
  entries: UserMemoryEntry[];
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const submitDraft = () => {
    const text = draft.trim();
    if (!text) return;
    void run(async () => {
      await addUserMemory({ scope, project_id: scope === 'project' ? projectId : null, text });
      setDraft('');
    });
  };

  const submitEdit = (entry: UserMemoryEntry) => {
    const text = editingText.trim();
    setEditingId(null);
    if (!text || text === entry.text) return;
    void run(() => updateUserMemory(entry.id, { text }));
  };

  return (
    <section className="mb-4">
      <h3 className="mb-1.5 px-1 text-[11px] font-semibold text-muted">{label}</h3>
      <ul className="space-y-1">
        {entries.length === 0 ? (
          <li className="rounded-md border border-dashed border-line px-2 py-2 text-[11px] text-muted">
            저장된 메모리가 없습니다.
          </li>
        ) : null}
        {entries.map((entry) => (
          <li
            key={entry.id}
            className={`group flex items-start gap-2 rounded-md border border-line bg-ink/40 px-2 py-1.5 ${entry.enabled ? '' : 'opacity-50'}`}
          >
            <input
              type="checkbox"
              className="mt-0.5 shrink-0 accent-current"
              checked={entry.enabled}
              title={entry.enabled ? '주입 중 (끄면 세션에 주입하지 않음)' : '꺼짐 (켜면 세션에 주입)'}
              aria-label={entry.enabled ? '메모리 끄기' : '메모리 켜기'}
              disabled={busy}
              onChange={() => void run(() => updateUserMemory(entry.id, { enabled: !entry.enabled }))}
            />
            <div className="min-w-0 flex-1">
              {editingId === entry.id ? (
                <input
                  type="text"
                  autoFocus
                  className="w-full rounded border border-line bg-ink px-1.5 py-1 text-[12px] text-text focus:outline-none"
                  value={editingText}
                  disabled={busy}
                  onChange={(e) => setEditingText(e.target.value)}
                  onBlur={() => submitEdit(entry)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitEdit(entry);
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                />
              ) : (
                <p className="whitespace-pre-wrap break-words text-[12px] leading-snug text-text">{entry.text}</p>
              )}
              <p className="mt-0.5 text-[10px] text-muted">
                {entry.source === 'auto' ? '자동 축적' : '직접 입력'} · {new Date(entry.updated_at).toLocaleDateString()}
              </p>
            </div>
            <div className="flex shrink-0 gap-0.5 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
              <button
                type="button"
                className="rounded p-1 hover:bg-ink"
                title="수정"
                aria-label="메모리 수정"
                disabled={busy}
                onClick={() => {
                  setEditingId(entry.id);
                  setEditingText(entry.text);
                }}
              >
                <PencilSimple size={13} />
              </button>
              <button
                type="button"
                className="rounded p-1 text-red-300 hover:bg-ink"
                title="삭제"
                aria-label="메모리 삭제"
                disabled={busy}
                onClick={() => void run(() => deleteUserMemory(entry.id))}
              >
                <Trash size={13} />
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-1.5 flex gap-1">
        <input
          type="text"
          className="min-w-0 flex-1 rounded-md border border-line bg-ink px-2 py-1.5 text-[12px] text-text placeholder:text-muted focus:outline-none"
          placeholder={scope === 'global' ? '항상 기억할 사실 추가…' : '이 프로젝트에서 기억할 사실 추가…'}
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitDraft();
          }}
        />
        <button
          type="button"
          className="flex shrink-0 items-center gap-1 rounded-md border border-line px-2 py-1.5 text-[11px] hover:bg-ink disabled:opacity-40"
          disabled={busy || !draft.trim()}
          onClick={submitDraft}
        >
          <Plus size={12} />추가
        </button>
      </div>
    </section>
  );
}

/**
 * Mount once (ProjectsTree root). Opens on `openUserMemoryPanel(...)` and
 * lets the user view/edit global + per-project memory (알잘딱) entries.
 */
export function UserMemoryPanelHost() {
  const [detail, setDetail] = useState<UserMemoryPanelDetail | null>(null);
  const [entries, setEntries] = useState<{ global: UserMemoryEntry[]; project: UserMemoryEntry[] }>({
    global: [],
    project: [],
  });
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback((projectId?: string | null) => {
    listUserMemory(projectId)
      .then((data) => {
        setEntries(data);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    const onOpen = (event: Event) => {
      const next = (event as CustomEvent<UserMemoryPanelDetail>).detail ?? {};
      setDetail(next);
      reload(next.projectId);
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, [reload]);

  if (!detail) return null;
  const projectId = detail.projectId ?? null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="사용자 메모리"
      onClick={(e) => {
        if (e.target === e.currentTarget) setDetail(null);
      }}
    >
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl border border-line bg-panel shadow-2xl">
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <Brain size={16} />
          <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text">
            메모리{detail.title ? ` — ${detail.title}` : ''}
          </h2>
          <button type="button" className="rounded p-1 hover:bg-ink" title="닫기" aria-label="닫기" onClick={() => setDetail(null)}>
            <X size={14} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <p className="mb-3 text-[11px] leading-snug text-muted">
            켜져 있는 항목은 세션 시작 시 자동으로 컨텍스트에 주입됩니다. 「이거 기억해」처럼 말하면 자동 축적됩니다.
          </p>
          {error ? (
            <p className="mb-2 rounded-md border border-red-400/40 bg-red-400/10 px-2 py-1.5 text-[11px] text-red-300">{error}</p>
          ) : null}
          {projectId ? (
            <MemorySection
              label={`프로젝트 메모리${detail.title ? ` (${detail.title})` : ''}`}
              scope="project"
              projectId={projectId}
              entries={entries.project}
              onChanged={() => reload(projectId)}
              onError={setError}
            />
          ) : null}
          <MemorySection
            label="전역 메모리 (모든 세션)"
            scope="global"
            entries={entries.global}
            onChanged={() => reload(projectId)}
            onError={setError}
          />
        </div>
      </div>
    </div>
  );
}
