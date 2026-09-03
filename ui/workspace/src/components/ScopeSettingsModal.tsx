import { Brain, FloppyDisk, SlidersHorizontal, X } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';
import {
  updateProjectScopeSettings,
  updateSessionScopeSettings,
} from '../api/myAgentClient';
import { useWorkspaceStore } from '../store/workspaceStore';
import { openUserMemoryPanel } from './UserMemoryPanel';

const OPEN_EVENT = 'cqr:open-scope-settings';

export type ScopeSettingsKind = 'workspace' | 'project' | 'session';

export interface ScopeSettingsDetail {
  kind: ScopeSettingsKind;
  id: string;
  title: string;
  preferredModel?: string | null;
  allowedPaths?: string[];
  projectId?: string | null;
}

export function openScopeSettings(detail: ScopeSettingsDetail): void {
  window.dispatchEvent(new CustomEvent<ScopeSettingsDetail>(OPEN_EVENT, { detail }));
}

const scopeLabel = (kind: ScopeSettingsKind) =>
  kind === 'workspace' ? '워크스페이스' : kind === 'project' ? '프로젝트' : '대화';

export function ScopeSettingsModalHost() {
  const [detail, setDetail] = useState<ScopeSettingsDetail | null>(null);
  const [model, setModel] = useState('');
  const [paths, setPaths] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const modelOptions = useWorkspaceStore((state) => state.modelOptions);
  const refreshModelPicker = useWorkspaceStore((state) => state.refreshModelPicker);
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId);
  const loadChatSession = useWorkspaceStore((state) => state.loadChatSession);

  useEffect(() => {
    const onOpen = (event: Event) => {
      const next = (event as CustomEvent<ScopeSettingsDetail>).detail;
      if (!next?.id) return;
      setDetail(next);
      setModel(next.preferredModel?.trim() ?? '');
      setPaths((next.allowedPaths ?? []).join('\n'));
      setMessage(null);
      if (modelOptions.length <= 1) void refreshModelPicker();
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, [modelOptions.length, refreshModelPicker]);

  const normalizedPaths = useMemo(
    () => [...new Set(paths.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean))],
    [paths],
  );
  const invalidPaths = useMemo(
    () => normalizedPaths.filter((entry) => !/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(entry)),
    [normalizedPaths],
  );

  if (!detail) return null;
  const label = scopeLabel(detail.kind);

  const save = async () => {
    if (invalidPaths.length) {
      setMessage(`절대 경로가 아닌 항목을 확인하세요: ${invalidPaths[0]}`);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const patch = { preferred_model: model || null, allowed_paths: normalizedPaths };
      if (detail.kind === 'session') await updateSessionScopeSettings(detail.id, patch);
      else await updateProjectScopeSettings(detail.id, patch);
      window.dispatchEvent(new Event('cqr:workspace-tree-changed'));
      if (detail.kind === 'session' && activeSessionId === detail.id) {
        await loadChatSession(detail.id);
      }
      setMessage('설정을 저장했습니다.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '설정 저장에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const openMemory = () => {
    openUserMemoryPanel({
      projectId: detail.kind === 'session' ? detail.projectId ?? null : detail.id,
      sessionId: detail.kind === 'session' ? detail.id : null,
      title: detail.title,
    });
    setDetail(null);
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`${label} 설정`}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) setDetail(null);
      }}
    >
      <div className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl">
        <header className="flex items-center gap-3 border-b border-line px-6 py-4">
          <span className="rounded-lg bg-accent/10 p-2 text-accent"><SlidersHorizontal size={18} /></span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold text-text">{label} 설정</h2>
            <p className="truncate text-xs text-muted">{detail.title}</p>
          </div>
          <button type="button" className="rounded-md p-1.5 text-muted hover:bg-ink hover:text-text" aria-label="닫기" onClick={() => setDetail(null)} disabled={busy}>
            <X size={16} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <section className="border-b border-line pb-5">
            <label className="mb-2 block text-sm font-semibold text-text" htmlFor="scope-default-model">기본 모델</label>
            <p className="mb-3 text-xs leading-5 text-muted">이 {label}에서 새 요청에 사용할 모델입니다. 대화 도중 변경한 모델은 각 응답에 별도로 기록됩니다.</p>
            <select
              id="scope-default-model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              className="w-full rounded-lg border border-line bg-ink px-3 py-2.5 text-sm text-text outline-none focus:border-accent"
            >
              <option value="">{detail.kind === 'session' ? '소속 프로젝트·작업폴더 설정 따르기' : '전역 기본 모델 따르기'}</option>
              {modelOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </section>

          <section className="border-b border-line py-5">
            <label className="mb-2 block text-sm font-semibold text-text" htmlFor="scope-allowed-paths">수정 허용 경로</label>
            <p className="mb-3 text-xs leading-5 text-muted">에이전트가 기본 승인 범위로 사용할 절대 경로를 한 줄에 하나씩 입력합니다. 첫 경로는 상대경로 기준점이며, 목록 밖 쓰기는 별도 승인을 요청합니다. 비워 두면 {detail.kind === 'session' ? '소속 프로젝트·작업폴더' : '연결된 작업폴더'} 경계를 따릅니다.</p>
            <textarea
              id="scope-allowed-paths"
              value={paths}
              onChange={(event) => setPaths(event.target.value)}
              rows={4}
              spellCheck={false}
              placeholder={'D:\\work\\project\\src\nD:\\work\\project\\tests'}
              className="w-full resize-y rounded-lg border border-line bg-ink px-3 py-2.5 font-mono text-xs leading-5 text-text outline-none placeholder:text-muted/60 focus:border-accent"
            />
            <p className={`mt-2 text-[11px] ${invalidPaths.length ? 'text-red-300' : 'text-muted'}`}>
              {invalidPaths.length
                ? `절대 경로가 아닌 항목 ${invalidPaths.length}개`
                : `현재 ${normalizedPaths.length}개 경로`}
            </p>
          </section>

          <section className="pt-5">
            <h3 className="text-sm font-semibold text-text">지역 메모리</h3>
            <p className="mt-1 text-xs leading-5 text-muted">이 {label}에만 적용할 지식과 지침을 추가·수정·비활성화합니다.</p>
            <button type="button" onClick={openMemory} className="mt-3 inline-flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-xs font-medium text-text hover:bg-ink">
              <Brain size={15} />지역 메모리 관리
            </button>
          </section>

          {message ? <p className="mt-5 rounded-lg border border-line bg-ink px-3 py-2 text-xs text-muted">{message}</p> : null}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-line bg-ink/35 px-6 py-4">
          <button type="button" className="rounded-lg border border-line px-4 py-2 text-xs text-muted hover:bg-panel hover:text-text" onClick={() => setDetail(null)} disabled={busy}>취소</button>
          <button type="button" className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-white hover:brightness-110 disabled:opacity-50" onClick={() => void save()} disabled={busy}>
            <FloppyDisk size={14} />{busy ? '저장 중…' : '설정 저장'}
          </button>
        </footer>
      </div>
    </div>
  );
}
