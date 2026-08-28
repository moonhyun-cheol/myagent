import { CheckCircle, FolderPlus, FolderSimple, Trash } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import {
  deleteProject,
  fetchWorkspaceTree,
  setDevWorkspace,
  type WorkspaceNode,
  type WorkspaceTreePayload,
} from '../api/myAgentClient';
import { confirmDialog } from '../lib/confirmDialog';
import { FolderBrowserModal } from './FolderBrowserModal';
import { SettingsProgramSection } from './SettingsProgramSection';

interface SettingsWorkspacePageProps {
  readOnly: boolean;
  onWorkspaceChanged?: (root: string | null) => void;
}

export function SettingsWorkspacePage({ readOnly, onWorkspaceChanged }: SettingsWorkspacePageProps) {
  const [tree, setTree] = useState<WorkspaceTreePayload | null>(null);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const next = await fetchWorkspaceTree();
      setTree(next);
      onWorkspaceChanged?.(next.dev_workspace_root);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '워크스페이스 목록을 불러오지 못했습니다.');
    } finally {
      setBusy(false);
    }
  }, [onWorkspaceChanged]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const activateWorkspace = async (node: WorkspaceNode) => {
    const root = node.folder_path?.trim();
    if (!root) return;
    setBusy(true);
    setMessage('');
    try {
      await setDevWorkspace(root);
      onWorkspaceChanged?.(root);
      setMessage(`활성 워크스페이스: ${root}`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '워크스페이스 활성화 실패');
    } finally {
      setBusy(false);
    }
  };

  const addWorkspace = async (root: string) => {
    setBrowseOpen(false);
    setBusy(true);
    setMessage('');
    try {
      await setDevWorkspace(root);
      onWorkspaceChanged?.(root);
      setMessage(`워크스페이스를 추가하고 활성화했습니다: ${root}`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '워크스페이스 추가 실패');
    } finally {
      setBusy(false);
    }
  };

  const removeWorkspace = async (node: WorkspaceNode) => {
    const root = node.folder_path || node.title;
    const ok = await confirmDialog({
      title: '워크스페이스 제거',
      message: `사전 승인 목록에서 "${root}"을(를) 제거할까요? 디스크의 파일은 삭제하지 않습니다.`,
      confirmLabel: '제거',
      cancelLabel: '취소',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setMessage('');
    try {
      await deleteProject(node.id, true);
      setMessage('워크스페이스를 제거했습니다.');
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '워크스페이스 제거 실패');
    } finally {
      setBusy(false);
    }
  };

  const roots = (tree?.workspace_trees ?? []).filter((node) => node.kind === 'workspace_root');
  const activeId = tree?.active_workspace_project_id;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-ink px-8 py-7">
      <header className="mb-6 pr-12">
        <h2 className="text-xl font-semibold">사전 승인 워크스페이스</h2>
        <p className="mt-1 text-sm text-muted">
          등록된 작업 폴더만 에이전트의 로컬 쓰기 및 승인 위임 대상이 됩니다.
        </p>
      </header>

      {message ? <p className="mb-5 rounded-xl border border-line bg-panel px-4 py-3 text-sm text-muted">{message}</p> : null}

      <section className="max-w-3xl rounded-2xl border border-line bg-panel p-5 shadow-sm">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <FolderSimple size={21} className="text-accent" />
              <h3 className="font-semibold">등록된 작업 폴더</h3>
            </div>
            <p className="mt-1 text-xs leading-5 text-muted">
              현재 활성 폴더가 승인 정책의 기준입니다. 폴더를 활성화해 바꿀 수 있습니다.
            </p>
          </div>
          <button
            type="button"
            disabled={readOnly || busy}
            onClick={() => setBrowseOpen(true)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-45"
          >
            <FolderPlus size={15} weight="bold" />
            폴더 추가
          </button>
        </div>

        {busy && !tree ? <p className="py-5 text-sm text-muted">불러오는 중...</p> : null}
        {!busy && roots.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line px-4 py-6 text-center">
            <p className="text-sm text-muted">등록된 워크스페이스가 없습니다.</p>
            <p className="mt-1 text-xs text-muted">폴더를 추가하면 승인 위임 정책을 사용할 수 있습니다.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {roots.map((node) => {
              const active = node.id === activeId;
              return (
                <div key={node.id} className={`flex items-center gap-3 rounded-xl border px-3 py-3 ${active ? 'border-accent/50 bg-accent/5' : 'border-line bg-ink/35'}`}>
                  <FolderSimple size={19} className={active ? 'shrink-0 text-accent' : 'shrink-0 text-muted'} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-text">{node.title}</p>
                    <p className="truncate font-mono text-[11px] text-muted" title={node.folder_path ?? undefined}>
                      {node.folder_path || '경로 없음'}
                    </p>
                  </div>
                  {active ? (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-accent/15 px-2 py-1 text-[10px] font-medium text-accent">
                      <CheckCircle size={13} weight="fill" />
                      활성
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={readOnly || busy}
                      onClick={() => void activateWorkspace(node)}
                      className="shrink-0 rounded-lg border border-line px-2.5 py-1.5 text-[11px] text-muted enabled:hover:border-accent/50 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      활성화
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={readOnly || busy}
                    onClick={() => void removeWorkspace(node)}
                    className="shrink-0 rounded-lg p-1.5 text-muted hover:bg-red-500/10 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-45"
                    aria-label={`${node.title} 제거`}
                    title="목록에서 제거"
                  >
                    <Trash size={15} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <SettingsProgramSection readOnly={readOnly} />

      <FolderBrowserModal open={browseOpen} onClose={() => setBrowseOpen(false)} onSelect={(root) => void addWorkspace(root)} />
    </div>
  );
}
