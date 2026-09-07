import { Brain, Plus, X } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { addUserMemory, batchUserMemory, listUserMemory, updateUserMemory, type UserMemoryEntry, type UserMemoryScope } from '../api/myAgentClient';
import { confirmDialog, getConfirmDialogPending } from '../lib/confirmDialog';

const OPEN_EVENT = 'cqr:open-user-memory';
const PAGE_SIZE = 30;
const labels: Record<UserMemoryScope, string> = { global: '전역', project: '프로젝트 / 작업폴더', session: '현재 챗' };
const control = 'rounded border border-line bg-ink px-2 py-1.5 text-[12px] text-text disabled:opacity-40';
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();

export interface UserMemoryPanelDetail {
  projectId?: string | null;
  sessionId?: string | null;
  title?: string;
}

export function openUserMemoryPanel(detail: UserMemoryPanelDetail = {}): void {
  window.dispatchEvent(new CustomEvent<UserMemoryPanelDetail>(OPEN_EVENT, { detail }));
}

export function UserMemoryPanelHost() {
  const [detail, setDetail] = useState<UserMemoryPanelDetail | null>(null);
  const opened = useRef(false);
  useEffect(() => {
    const onOpen = (event: Event) => {
      // A second open must not silently discard a draft or redirect a pending mutation.
      if (opened.current) return;
      opened.current = true;
      setDetail((event as CustomEvent<UserMemoryPanelDetail>).detail ?? {});
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);
  return detail ? <MemoryManager detail={detail} onClose={() => { opened.current = false; setDetail(null); }} /> : null;
}

function MemoryManager({ detail, onClose }: { detail: UserMemoryPanelDetail; onClose: () => void }) {
  const [entries, setEntries] = useState<UserMemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const alive = useRef(true);
  const request = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<UserMemoryScope | 'all'>('all');
  const [status, setStatus] = useState('all');
  const [source, setSource] = useState('all');
  const [sort, setSort] = useState('updated');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<UserMemoryEntry | 'new' | null>(null);
  const [text, setText] = useState('');
  const [target, setTarget] = useState<UserMemoryScope>(detail.sessionId ? 'session' : detail.projectId ? 'project' : 'global');
  const [addScope, setAddScope] = useState<UserMemoryScope>(target);
  const scopes = useMemo(() => (['session', 'project', 'global'] as UserMemoryScope[])
    .filter((s) => s === 'global' || (s === 'session' ? detail.sessionId : detail.projectId)), [detail]);
  const dirty = editing === 'new' ? !!text.trim() : !!editing && text !== editing.text;
  const locked = loading || busy;

  const reload = useCallback(async () => {
    const seq = ++request.current;
    setLoading(true);
    try {
      const data = await listUserMemory(detail.projectId, detail.sessionId);
      if (!alive.current || seq !== request.current) return;
      const next = [...data.session, ...data.project, ...data.global];
      setEntries(next);
      setSelected((old) => new Set([...old].filter((id) => next.some((e) => e.id === id))));
      setError('');
    } catch (err) {
      if (alive.current && seq === request.current) {
        setEntries([]);
        setSelected(new Set());
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (alive.current && seq === request.current) setLoading(false);
    }
  }, [detail]);

  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement as HTMLElement | null;
    root.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
    void reload();
    return () => { alive.current = false; request.current++; previous?.focus(); };
  }, [reload]);

  const discard = async () => !dirty || await confirmDialog({
    title: '수정 내용 버리기', message: '저장하지 않은 수정 내용을 버릴까요?', confirmLabel: '버리기', danger: true,
  });
  const close = async () => {
    if (busyRef.current || getConfirmDialogPending()) return;
    if (await discard()) onClose();
  };
  const edit = async (entry: UserMemoryEntry | 'new' | null) => {
    if (locked || busyRef.current || !await discard() || !alive.current) return;
    setEditing(entry);
    setText(entry && entry !== 'new' ? entry.text : '');
    if (entry === 'new') setAddScope(scope === 'all' ? scopes[0] : scope);
  };

  const visible = useMemo(() => entries.filter((e) =>
    (scope === 'all' || e.scope === scope)
    && (status === 'all' || e.enabled === (status === 'enabled'))
    && (source === 'all' || e.source === source)
    && normalize(e.text).includes(normalize(query)))
    .sort((a, b) => sort === 'text' ? a.text.localeCompare(b.text, 'ko')
      : sort === 'created' ? b.created_at.localeCompare(a.created_at)
      : sort === 'oldest' ? a.updated_at.localeCompare(b.updated_at) : b.updated_at.localeCompare(a.updated_at)),
  [entries, scope, status, source, query, sort]);
  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const rows = visible.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const filterChanged = () => { setPage(0); setSelected(new Set()); };
  const duplicate = editing && entries.some((e) => e.id !== (editing === 'new' ? '' : editing.id)
    && e.scope === (editing === 'new' ? addScope : editing.scope) && normalize(e.text) === normalize(text));

  const run = async (work: () => Promise<unknown>, message: string) => {
    if (busyRef.current || loading) return;
    busyRef.current = true;
    setBusy(true); setError(''); setNotice('');
    try {
      await work();
      if (!alive.current) return;
      setEditing(null); setText(''); setSelected(new Set()); setNotice(message);
      await reload();
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const save = () => {
    if (!editing || !text.trim() || duplicate || text.trim().length > 500) return;
    void run(() => editing === 'new'
      ? addUserMemory({ scope: addScope, project_id: detail.projectId, session_id: detail.sessionId, text: text.trim() })
      : updateUserMemory(editing.id, { text: text.trim() }), '메모리를 저장했습니다.');
  };
  const batch = async (action: 'enable' | 'disable' | 'delete' | 'move') => {
    if (locked || !selected.size || !await discard() || !alive.current) return;
    const ids = [...selected];
    const summary = action === 'delete' ? `${ids.length}개 메모리를 삭제합니다. 되돌릴 수 없습니다.`
      : action === 'move' ? `${ids.length}개 메모리를 ${labels[target]} 범위로 이동합니다. 저장 범위가 바뀌며 활성 상태는 유지됩니다.`
      : `${ids.length}개 메모리를 ${action === 'enable' ? '활성화' : '비활성화'}합니다. 이번 챗만이 아니라 저장 범위 전체에 영향을 줍니다.`;
    if (!await confirmDialog({ title: '메모리 일괄 관리', message: summary, danger: action === 'delete', confirmLabel: '적용', allowEnterConfirm: false }) || !alive.current) return;
    void run(() => batchUserMemory({ ids, action, target_scope: target, project_id: detail.projectId, session_id: detail.sessionId }), `${ids.length}개 메모리에 적용했습니다.`);
  };

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-2 sm:p-5" onClick={(e) => { if (e.target === e.currentTarget) void close(); }}>
    <div ref={root} role="dialog" aria-modal="true" aria-label="메모리 관리" className="flex h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-line bg-panel text-text shadow-2xl"
      onKeyDown={(e) => {
        if (getConfirmDialogPending()) return;
        if (e.key === 'Escape') { e.stopPropagation(); void close(); }
        if (e.key === 'Tab') {
          const nodes = [...(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)') ?? [])].filter((n) => n.getClientRects().length);
          const first = nodes[0]; const last = nodes[nodes.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }
      }}>
      <header className="flex items-center gap-2 border-b border-line p-3"><Brain size={18} /><h2 className="min-w-0 flex-1 truncate font-semibold">메모리 관리{detail.title ? ` — ${detail.title}` : ''}</h2><button className={control} disabled={busy} aria-label="닫기" onClick={() => void close()}><X size={16} /></button></header>
      <p className="px-3 py-2 text-[11px] text-muted">활성 상태는 저장 범위 전체에 적용됩니다. ‘이번 챗에서만 제외’ 설정이 아니며, 활성 메모리가 모든 응답에 전달되는 것은 아닙니다.</p>
      <div className="flex flex-wrap gap-2 border-b border-line px-3 pb-3">
        <input type="search" aria-label="메모리 검색" placeholder="메모리 검색…" className={`${control} min-w-40 flex-1`} value={query} onChange={(e) => { setQuery(e.target.value); filterChanged(); }} />
        <select aria-label="활성 상태 필터" className={control} value={status} onChange={(e) => { setStatus(e.target.value); filterChanged(); }}><option value="all">모든 상태</option><option value="enabled">활성</option><option value="disabled">비활성</option></select>
        <select aria-label="등록 방식 필터" className={control} value={source} onChange={(e) => { setSource(e.target.value); filterChanged(); }}><option value="all">모든 등록 방식</option><option value="user">직접 입력 / 편집</option><option value="auto">기존 자동 축적</option></select>
        <select aria-label="메모리 정렬" className={control} value={sort} onChange={(e) => { setSort(e.target.value); setPage(0); }}><option value="updated">최근 수정순</option><option value="oldest">오래된 수정순</option><option value="created">최근 생성순</option><option value="text">본문순</option></select>
        <button className={control} disabled={locked} onClick={() => { void edit('new'); }}><Plus className="inline" size={12} /> 추가</button>
        <button className={control} disabled={locked || dirty} onClick={() => void reload()}>새로고침</button>
      </div>
      {error && <p role="alert" className="px-3 py-2 text-sm text-red-300">{error}</p>}
      {notice && <p role="status" className="px-3 py-1 text-xs text-muted">{notice}</p>}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav aria-label="메모리 범위" className="flex shrink-0 gap-1 overflow-x-auto border-b border-line p-2 md:w-44 md:flex-col md:border-b-0 md:border-r">
          {(['all', ...scopes] as const).map((s) => <button key={s} aria-pressed={scope === s} className={`${control} shrink-0 text-left ${scope === s ? 'ring-1 ring-current' : ''}`} onClick={() => { setScope(s); filterChanged(); }}>{s === 'all' ? '전체' : labels[s]} ({s === 'all' ? entries.length : entries.filter((e) => e.scope === s).length})</button>)}
          <p className="hidden break-all pt-2 text-[10px] text-muted md:block">현재 소속만 표시합니다.<br />{detail.projectId ? `소속: ${detail.projectId}` : '소속 없음'}<br />{detail.sessionId ? `챗: ${detail.sessionId}` : '챗 선택 없음'}</p>
        </nav>
        <section aria-label="메모리 목록" className={`min-h-0 min-w-0 flex-1 flex-col ${editing ? 'hidden md:flex' : 'flex'}`}>
          <div className="flex items-center gap-2 border-b border-line p-2 text-xs"><input type="checkbox" aria-label="현재 페이지 전체 선택" disabled={locked || !rows.length} checked={!!rows.length && rows.every((e) => selected.has(e.id))} onChange={(e) => setSelected((old) => { const next = new Set(old); rows.forEach((row) => e.target.checked ? next.add(row.id) : next.delete(row.id)); return next; })} /><span>{loading ? '불러오는 중…' : `${visible.length}개 검색됨`}</span></div>
          <ul className="min-h-0 flex-1 overflow-y-auto p-2">
            {!loading && !rows.length && <li className="p-5 text-sm text-muted">{error ? '목록을 불러오지 못했습니다. 새로고침으로 다시 시도하세요.' : entries.length ? '조건에 맞는 메모리가 없습니다.' : '저장된 메모리가 없습니다.'}</li>}
            {rows.map((entry) => <li key={entry.id} className={`mb-1 flex items-start gap-2 rounded border border-line p-2 ${editing && editing !== 'new' && editing.id === entry.id ? 'bg-ink' : ''}`}>
              <input type="checkbox" className="mt-1" aria-label={`선택: ${entry.text}`} disabled={locked} checked={selected.has(entry.id)} onChange={(e) => setSelected((old) => { const next = new Set(old); if (e.target.checked) next.add(entry.id); else next.delete(entry.id); return next; })} />
              <button className="min-w-0 flex-1 text-left" disabled={locked} onClick={() => void edit(entry)}><span className="line-clamp-2 break-words text-[12px]">{entry.text}</span><span className="mt-1 block text-[10px] text-muted">{labels[entry.scope]} · {entry.enabled ? '활성' : '비활성'} · {new Date(entry.updated_at).toLocaleDateString()}</span></button>
            </li>)}
          </ul>
          <div className="flex items-center justify-center gap-3 border-t border-line p-2 text-xs"><button className={control} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>이전</button><span>{currentPage + 1} / {pages}</span><button className={control} disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>다음</button></div>
        </section>
        <section aria-label="메모리 상세" className={`${editing ? 'flex' : 'hidden md:flex'} min-h-0 flex-1 flex-col overflow-y-auto border-line p-3 md:max-w-sm md:border-l`}>
          {!editing ? <p className="text-sm text-muted">목록에서 항목을 선택해 내용을 확인하거나 편집하세요. 체크박스는 일괄 작업 선택입니다.</p> : <>
            <h3 className="mb-3 text-sm font-semibold">{editing === 'new' ? '메모리 추가' : '메모리 상세 / 편집'}</h3>
            {editing === 'new' ? <label className="mb-2 text-xs">저장 위치 <select aria-label="추가 저장 위치" className={control} disabled={busy} value={addScope} onChange={(e) => setAddScope(e.target.value as UserMemoryScope)}>{scopes.map((s) => <option key={s} value={s}>{labels[s]}</option>)}</select></label> : <div className="mb-3 break-all text-xs text-muted"><p>저장 위치: {labels[editing.scope]}</p><p>상태: {editing.enabled ? '활성' : '비활성'}</p><p>등록 방식: {editing.source === 'auto' ? '기존 자동 축적' : '직접 입력 / 편집'}</p><p>생성: {new Date(editing.created_at).toLocaleString()}</p><p>수정: {new Date(editing.updated_at).toLocaleString()}</p><p className="mt-2">추출 출처: 기록 없음</p></div>}
            <label htmlFor="memory-text" className="mb-1 text-xs">메모리 본문</label><textarea id="memory-text" className={`${control} min-h-40 resize-y`} disabled={busy} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} />
            <p className="mt-1 text-right text-[10px] text-muted">{text.length} / 500</p>
            {duplicate && <p role="alert" className="text-xs text-amber-300">같은 범위에 동일한 내용이 있습니다. 기존 항목을 확인하세요.</p>}
            <div className="mt-3 flex gap-2"><button className={control} disabled={locked || !text.trim() || !!duplicate || (!dirty && editing !== 'new')} onClick={save}>저장</button><button className={control} disabled={busy} onClick={() => void edit(null)}>취소 / 목록</button></div>
            <p className="mt-4 text-[11px] text-muted">범위 이동·활성 변경·삭제는 목록의 체크박스로 선택한 뒤 하단에서 적용합니다. 의미상 충돌은 본문을 직접 검토하세요.</p>
          </>}
        </section>
      </div>
      <footer className="flex flex-wrap items-center gap-2 border-t border-line p-3 text-xs"><span>{selected.size}개 선택{selected.size > 0 ? ` (현재 페이지 밖 ${[...selected].filter((id) => !rows.some((e) => e.id === id)).length}개)` : ''}</span><button className={control} disabled={!selected.size || busy} onClick={() => setSelected(new Set())}>선택 해제</button><button className={control} disabled={locked || !selected.size} onClick={() => void batch('enable')}>활성화</button><button className={control} disabled={locked || !selected.size} onClick={() => void batch('disable')}>비활성화</button><select aria-label="이동할 저장 위치" className={control} value={target} disabled={busy} onChange={(e) => setTarget(e.target.value as UserMemoryScope)}>{scopes.map((s) => <option key={s} value={s}>{labels[s]}</option>)}</select><button className={control} disabled={locked || !selected.size} onClick={() => void batch('move')}>범위 이동</button><button className={`${control} text-red-300`} disabled={locked || !selected.size} onClick={() => void batch('delete')}>삭제</button>{busy && <span role="status">처리 중…</span>}</footer>
    </div>
  </div>;
}
