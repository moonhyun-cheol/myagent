import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FileNode } from '../types';
import {
  DOCUMENT_SCRATCH,
  joinDocumentSavePath,
  normalizeRelPath,
  validateDocumentFileName,
} from '../lib/documentFile';
import { confirmDialog } from '../lib/confirmDialog';

export type DocumentSaveMode = 'project' | 'saveAs' | 'rename';

interface DocumentSaveModalProps {
  open: boolean;
  mode: DocumentSaveMode;
  filesRoot: string | null;
  files: FileNode[];
  initialFolder?: string;
  initialName?: string;
  /** Current workspace path when renaming or saving-as from an existing file. */
  currentPath?: string | null;
  onClose: () => void;
  onConfirm: (relPath: string) => void | Promise<void>;
}

function collectFolders(nodes: FileNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    if (node.kind !== 'folder') continue;
    out.push(node.id.replace(/\\/g, '/'));
    if (node.children?.length) collectFolders(node.children, out);
  }
  return out;
}

function pathExistsAsFile(nodes: FileNode[], relPath: string): boolean {
  const target = normalizeRelPath(relPath).toLowerCase();
  const walk = (list: FileNode[]): boolean => {
    for (const node of list) {
      if (node.kind === 'file' && node.id.replace(/\\/g, '/').toLowerCase() === target) return true;
      if (node.children?.length && walk(node.children)) return true;
    }
    return false;
  };
  return walk(nodes);
}

export function DocumentSaveModal({
  open,
  mode,
  filesRoot,
  files,
  initialFolder,
  initialName,
  currentPath,
  onClose,
  onConfirm,
}: DocumentSaveModalProps) {
  const docsDir = DOCUMENT_SCRATCH.projectDocsDir;
  const folders = useMemo(() => {
    const list = collectFolders(files);
    if (!list.includes(docsDir)) list.unshift(docsDir);
    if (!list.includes('')) list.push('');
    return [...new Set(list.map((f) => normalizeRelPath(f)))].sort((a, b) => a.localeCompare(b));
  }, [files, docsDir]);

  const [folder, setFolder] = useState(initialFolder || docsDir);
  const [fileName, setFileName] = useState(initialName || 'notes');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFolder(normalizeRelPath(initialFolder || docsDir));
    setFileName(initialName || 'notes');
    setError(null);
    setBusy(false);
  }, [open, initialFolder, initialName, docsDir]);

  if (!open) return null;

  const finalPath =
    mode === 'rename' && currentPath
      ? (() => {
          const parent = normalizeRelPath(currentPath).split('/').slice(0, -1).join('/');
          const nameErr = validateDocumentFileName(fileName);
          if (nameErr) return '';
          return joinDocumentSavePath(parent, fileName);
        })()
      : (() => {
          const nameErr = validateDocumentFileName(fileName);
          if (nameErr) return '';
          return joinDocumentSavePath(folder, fileName);
        })();

  const title =
    mode === 'rename' ? '이름 변경' : mode === 'saveAs' ? '다른 이름으로 저장' : '프로젝트에 저장';

  const submit = async () => {
    const nameErr = validateDocumentFileName(fileName);
    if (nameErr) {
      setError(nameErr);
      return;
    }
    if (!finalPath) {
      setError('저장 경로를 확인하세요.');
      return;
    }
    if (finalPath.includes('..')) {
      setError('상위 폴더로 나가는 경로는 사용할 수 없습니다.');
      return;
    }
    if (mode !== 'rename' || finalPath.toLowerCase() !== normalizeRelPath(currentPath || '').toLowerCase()) {
      if (pathExistsAsFile(files, finalPath)) {
        const ok = await confirmDialog({
          title: '같은 이름 덮어쓰기',
          message: `"${finalPath}" 파일이 이미 있습니다. 덮어쓸까요?`,
          confirmLabel: '덮어쓰기',
          cancelLabel: '취소',
        });
        if (!ok) return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      await onConfirm(finalPath);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[220] flex items-start justify-center bg-ink/70 px-4 pt-[10vh] backdrop-blur-sm"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-line bg-panel shadow-[0_20px_60px_rgba(0,0,0,0.55)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-medium text-text">{title}</h2>
          <p className="mt-1 truncate text-[11px] text-muted" title={filesRoot || undefined}>
            작업 폴더: {filesRoot || '(연결 안 됨)'}
          </p>
          {mode !== 'rename' ? (
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
              연결된 <span className="font-medium text-text/80">작업 폴더</span>에 실제 파일로
              저장합니다. 대화 기록이나 세션 임시본(
              <span className="font-mono text-[10px]">{DOCUMENT_SCRATCH.scratchDir}</span>
              )이 아닙니다. 기본 위치는 <span className="font-mono text-[10px]">{docsDir}/</span>
              입니다.
            </p>
          ) : null}
        </header>
        <div className="space-y-3 px-4 py-3">
          {mode !== 'rename' ? (
            <label className="block text-[11px] text-muted">
              저장할 폴더
              <select
                className="mt-1 w-full rounded-lg border border-line bg-ink/60 px-2.5 py-2 font-mono text-xs text-text outline-none focus:border-accent"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
              >
                {folders.map((f) => (
                  <option key={f || '(root)'} value={f}>
                    {f || '(작업 폴더 루트)'}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="block text-[11px] text-muted">
            파일 이름
            <input
              className="mt-1 w-full rounded-lg border border-line bg-ink/60 px-2.5 py-2 text-sm text-text outline-none focus:border-accent"
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void submit();
                }
              }}
              autoFocus
            />
          </label>
          <p className="rounded-lg border border-line/70 bg-ink/40 px-2.5 py-2 font-mono text-[11px] text-text">
            최종 위치: {finalPath || '—'}
          </p>
          {error ? <p className="text-[11px] text-red-300">{error}</p> : null}
        </div>
        <footer className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <button
            type="button"
            className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-muted hover:text-text"
            onClick={onClose}
            disabled={busy}
          >
            취소
          </button>
          <button
            type="button"
            className="rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-ink disabled:opacity-40"
            onClick={() => void submit()}
            disabled={busy || !finalPath}
          >
            {busy ? '저장 중…' : '저장'}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
