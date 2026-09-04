import Editor, { DiffEditor, type OnMount } from '@monaco-editor/react';
import type { editor as MonacoEditor } from 'monaco-editor';
import { marked } from 'marked';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { setDevWorkspace, readWorkspaceFsFile } from '../api/myAgentClient';
import { promptDialog } from '../lib/confirmDialog';
import {
  DOCUMENT_SCRATCH,
  isAllowedDocumentPath,
  normalizeRelPath,
  projectDocRelPath,
  sanitizePreviewHref,
} from '../lib/documentFile';
import { DOCUMENT_MEMO_MARKER } from '../lib/documentMemo';
import type { DocumentMemo } from '../lib/documentFile';
import { useWorkspaceStore } from '../store/workspaceStore';
import { ContextMenuPortal, useContextMenu, type ContextMenuItem } from './ContextMenu';
import { FolderBrowserModal } from './FolderBrowserModal';

type MemoRange = {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
};

const NOTE_W = 320;
const NOTE_H = 300;
const EMPTY_MEMOS: DocumentMemo[] = [];

marked.setOptions({ gfm: true, breaks: true });

function renderPreviewHtml(markdown: string): string {
  const raw = marked.parse(markdown || '', { async: false }) as string;
  return raw.replace(/href="([^"]*)"/gi, (_m, href: string) => {
    const safe = sanitizePreviewHref(href);
    return safe ? `href="${safe.replace(/"/g, '&quot;')}"` : 'href="#"';
  });
}

/** Full viewport drag — can reach the workspace sidebar to dock. */
function clampNotePos(x: number, y: number, w = NOTE_W, h = NOTE_H): { left: number; top: number } {
  const left = Math.min(Math.max(8, x), Math.max(8, window.innerWidth - w - 8));
  const top = Math.min(Math.max(8, y), Math.max(8, window.innerHeight - h - 8));
  return { left, top };
}

/** If released over/near the left workspace sidebar, snap flush to that panel. */
function snapNoteToWorkspaceIfNear(x: number, y: number): { left: number; top: number } {
  const pos = clampNotePos(x, y);
  const sidebar = document.querySelector<HTMLElement>('[data-sidebar-collapsed]');
  if (!sidebar) return pos;
  const r = sidebar.getBoundingClientRect();
  if (r.width < 40) return pos;
  const cx = pos.left + NOTE_W / 2;
  const overPanel = cx >= r.left - 16 && cx <= r.right + 48;
  const nearSeam = Math.abs(pos.left - r.right) < 56 || Math.abs(pos.left + NOTE_W - r.right) < 56;
  if (!overPanel && !nearSeam) return pos;
  // Hug the workspace panel from the right so the note sits on/against the tree.
  const dockedLeft = Math.round(r.right - NOTE_W + 12);
  return clampNotePos(dockedLeft, pos.top);
}

function rangeFromEditor(editor: MonacoEditor.IStandaloneCodeEditor | null): MemoRange | null {
  const sel = editor?.getSelection();
  if (!sel || sel.isEmpty()) return null;
  return {
    startLineNumber: sel.startLineNumber,
    startColumn: sel.startColumn,
    endLineNumber: sel.endLineNumber,
    endColumn: sel.endColumn,
  };
}

function uidMemo(): string {
  return `memo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function MarkdownDocument() {
  const filesRoot = useWorkspaceStore((s) => s.filesRoot);
  const documentTabs = useWorkspaceStore((s) => s.documentTabs);
  const activeDocumentTabId = useWorkspaceStore((s) => s.activeDocumentTabId);
  const activeDocument = documentTabs.find((tab) => tab.id === activeDocumentTabId) ?? documentTabs[0] ?? null;
  const documentRelPath = activeDocument?.path ?? null;
  const documentContent = activeDocument?.content ?? '';
  const documentDirty = activeDocument?.dirty ?? false;
  const documentStatus = activeDocument?.status ?? null;
  const lastDumpPath = activeDocument?.lastDumpPath ?? null;
  const lastDumpContent = activeDocument?.lastDumpContent ?? null;
  const documentSelection = activeDocument?.selection ?? '';
  const view = activeDocument?.view ?? 'source';
  const memos = activeDocument?.memos ?? EMPTY_MEMOS;
  const setDocumentContent = useWorkspaceStore((s) => s.setDocumentContent);
  const setDocumentSelection = useWorkspaceStore((s) => s.setDocumentSelection);
  const setDocumentView = useWorkspaceStore((s) => s.setDocumentView);
  const setDocumentMemos = useWorkspaceStore((s) => s.setDocumentMemos);
  const setActiveDocumentTab = useWorkspaceStore((s) => s.setActiveDocumentTab);
  const closeDocumentTab = useWorkspaceStore((s) => s.closeDocumentTab);
  const openDocumentPath = useWorkspaceStore((s) => s.openDocumentPath);
  const saveDocument = useWorkspaceStore((s) => s.saveDocument);
  const saveDocumentRecovery = useWorkspaceStore((s) => s.saveDocumentRecovery);
  const newDocument = useWorkspaceStore((s) => s.newDocument);
  const saveDocumentToProject = useWorkspaceStore((s) => s.saveDocumentToProject);
  const openLastDump = useWorkspaceStore((s) => s.openLastDump);
  const refreshExplorer = useWorkspaceStore((s) => s.refreshExplorer);
  const flushDocumentAfterWorkspaceConnect = useWorkspaceStore((s) => s.flushDocumentAfterWorkspaceConnect);
  const sendAiMessage = useWorkspaceStore((s) => s.sendAiMessage);

  const busy = useWorkspaceStore((s) => s.busy);
  const chat = useWorkspaceStore((s) => s.chat);

  const [browseOpen, setBrowseOpen] = useState(false);
  const [dumpPreview, setDumpPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<number | null>(null);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const memosRef = useRef<DocumentMemo[]>([]);
  memosRef.current = memos;
  const setMemos = useCallback((updater: (previous: DocumentMemo[]) => DocumentMemo[]) => {
    setDocumentMemos(updater(memosRef.current));
  }, [setDocumentMemos]);
  const dragRef = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null);
  const decoIdsRef = useRef<string[]>([]);
  const { menu, openAt, close } = useContextMenu();

  const hasWorkspace = Boolean(filesRoot?.trim());
  const previewHtml = useMemo(() => renderPreviewHtml(documentContent), [documentContent]);
  const openMemos = memos.filter((m) => m.open);
  const closedMemoCount = memos.filter((m) => !m.open).length;

  useEffect(() => {
    if (!hasWorkspace || !documentDirty) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void saveDocumentRecovery();
    }, 800);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [documentContent, documentDirty, hasWorkspace, saveDocumentRecovery, activeDocument?.id]);

  useEffect(() => {
    if (view !== 'diff') return;
    if (lastDumpContent != null) {
      setDumpPreview(lastDumpContent);
      return;
    }
    if (!lastDumpPath || !hasWorkspace) {
      setDumpPreview(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const { content } = await readWorkspaceFsFile(lastDumpPath);
        if (!cancelled) setDumpPreview(content);
      } catch {
        if (!cancelled) setDumpPreview(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view, lastDumpPath, lastDumpContent, hasWorkspace]);

  // Pull assistant replies into the matching sticky note (not the chat pane).
  useEffect(() => {
    const pending = memos.filter((m) => m.pending && m.turnId);
    if (!pending.length) return;
    for (const note of pending) {
      const turn = chat.find((t) => t.id === note.turnId);
      if (busy) {
        if (turn?.text?.trim()) {
          setMemos((prev) =>
            prev.map((m) => (m.id === note.id ? { ...m, answer: turn.text } : m)),
          );
        }
        continue;
      }
      setMemos((prev) =>
        prev.map((m) =>
          m.id === note.id
            ? {
                ...m,
                pending: false,
                answer: turn?.text?.trim() || m.answer || '(응답 없음)',
              }
            : m,
        ),
      );
    }
  }, [memos, busy, chat, setMemos]);

  // Excel-style red-corner decorations for collapsed (and open) memos.
  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;

    const next = memos
      .filter((m) => m.range)
      .map((m) => {
        const range = m.range!;
        return {
          range: {
            startLineNumber: range.startLineNumber,
            startColumn: range.startColumn,
            endLineNumber: range.endLineNumber,
            endColumn: range.endColumn,
          },
          options: {
            className: m.open ? 'ai-memo-range-open' : 'ai-memo-range',
            after: {
              content: '◥',
              inlineClassName: m.open ? 'ai-memo-corner-open' : 'ai-memo-corner',
            },
            stickiness: 1,
            hoverMessage: { value: m.open ? 'AI 메모 (열림)' : 'AI 메모 — 클릭하여 다시 열기' },
          },
        };
      });

    decoIdsRef.current = editor.deltaDecorations(decoIdsRef.current, next);
  }, [memos]);

  // Drag floating notes across the viewport (portal → body); snap to workspace sidebar on release.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const pos = clampNotePos(e.clientX - drag.offsetX, e.clientY - drag.offsetY);
      setMemos((prev) =>
        prev.map((m) => (m.id === drag.id ? { ...m, x: pos.left, y: pos.top } : m)),
      );
    };
    const onUp = () => {
      const drag = dragRef.current;
      if (drag) {
        setMemos((prev) =>
          prev.map((m) => {
            if (m.id !== drag.id) return m;
            const snapped = snapNoteToWorkspaceIfNear(m.x, m.y);
            return { ...m, x: snapped.left, y: snapped.top };
          }),
        );
      }
      dragRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [setMemos]);
 = useCallback(async (): Promise<boolean> => {
    if (hasWorkspace) return true;
    setBrowseOpen(true);
    return false;
  }, [hasWorkspace]);

  const readLiveSelection = (): string => {
    const editor = editorRef.current;
    const sel = editor?.getSelection();
    const model = editor?.getModel();
    if (sel && model && !sel.isEmpty()) {
      return model.getValueInRange(sel);
    }
    return documentSelection.trim();
  };

  const openEditorContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const selection = readLiveSelection();
    setDocumentSelection(selection);
    const editor = editorRef.current;
    const items: ContextMenuItem[] = [
      {
        id: 'cut',
        label: '잘라내기',
        disabled: !selection,
        onSelect: () => editor?.trigger('doc-menu', 'editor.action.clipboardCutAction', null),
      },
      {
        id: 'copy',
        label: '복사',
        disabled: !selection,
        onSelect: () => editor?.trigger('doc-menu', 'editor.action.clipboardCopyAction', null),
      },
      {
        id: 'paste',
        label: '붙여넣기',
        onSelect: () => editor?.trigger('doc-menu', 'editor.action.clipboardPasteAction', null),
      },
      {
        id: 'ask-ai',
        label: 'AI에게 묻기',
        disabled: !selection.trim(),
        onSelect: () => {
          const text = selection.trim() || readLiveSelection();
          if (!text) {
            const state = useWorkspaceStore.getState();
            const active = state.documentTabs.find((tab) => tab.id === state.activeDocumentTabId);
            if (active) {
              useWorkspaceStore.setState({
                documentTabs: state.documentTabs.map((tab) =>
                  tab.id === active.id
                    ? { ...tab, status: '텍스트를 선택한 뒤 AI에게 물어보세요.' }
                    : tab,
                ),
              });
            }
            return;
          }
          const pos = clampNotePos(e.clientX + 8, e.clientY + 8);
          setMemos((prev) => [
            ...prev,
            {
              id: uidMemo(),
              x: pos.left,
              y: pos.top,
              selection: text,
              range: rangeFromEditor(editorRef.current),
              question: '이 부분 짧게 설명해 줘.',
              answer: '',
              pending: false,
              turnId: null,
              open: true,
            },
          ]);
        },
      },
    ];
    openAt(e, items);
  };

  const submitAskNote = async (memoId: string) => {
    const note = memosRef.current.find((m) => m.id === memoId);
    if (!note || note.pending) return;
    const q = note.question.trim() || '이 부분 짧게 설명해 줘.';
    const message =
      `${DOCUMENT_MEMO_MARKER}` +
      `다음 문서 선택 구간에 대해 답해 줘. 짧고 메모처럼 설명해.\n\n"""\n${note.selection}\n"""\n\n질문: ${q}`;
    setDocumentSelection(note.selection);
    useWorkspaceStore.setState({ mode: 'document' });
    const beforeIds = new Set(useWorkspaceStore.getState().chat.map((t) => t.id));
    setMemos((prev) =>
      prev.map((m) =>
        m.id === memoId ? { ...m, pending: true, open: true, answer: m.answer || '답변 작성 중…' } : m,
      ),
    );
    await sendAiMessage(message, undefined, { uiSurface: 'document-memo' });
    const assistant = useWorkspaceStore
      .getState()
      .chat.filter((t) => t.role === 'assistant' && !beforeIds.has(t.id))
      .at(-1);
    setMemos((prev) =>
      prev.map((m) =>
        m.id === memoId
          ? {
              ...m,
              pending: true,
              turnId: assistant?.id ?? null,
              answer: assistant?.text || m.answer || '답변 작성 중…',
            }
          : m,
      ),
    );
  };

  const collapseMemo = (id: string) => {
    setMemos((prev) => prev.map((m) => (m.id === id ? { ...m, open: false } : m)));
  };

  const reopenMemo = (id: string, at?: { x: number; y: number }) => {
    setMemos((prev) =>
      prev.map((m) => {
        if (m.id !== id) return m;
        const pos = at ? clampNotePos(at.x, at.y) : clampNotePos(m.x, m.y);
        return { ...m, open: true, x: pos.left, y: pos.top };
      }),
    );
  };

  const removeMemo = (id: string) => {
    setMemos((prev) => prev.filter((m) => m.id !== id));
  };

  const onPickFile = async (file: File | null) => {
    if (!file) return;
    const name = file.name.toLowerCase();
    if (!DOCUMENT_SCRATCH.allowedExtensions.some((ext) => name.endsWith(ext))) {
      return;
    }
    const text = await file.text();
    const rel = normalizeRelPath(file.name);
    await openDocumentPath(rel, text);
  };

  const onOpenWorkspaceDoc = async () => {
    if (!(await ensureWorkspace())) return;
    const path = await promptDialog({
      title: '문서 열기',
      message: `작업 폴더 상대 경로 (${DOCUMENT_SCRATCH.allowedExtensions.join(', ')})`,
      defaultValue: documentRelPath || 'docs/notes.md',
      confirmLabel: '열기',
    });
    if (!path) return;
    if (!isAllowedDocumentPath(path)) {
      return;
    }
    await openDocumentPath(normalizeRelPath(path));
  };

  const onSaveProject = async () => {
    if (!(await ensureWorkspace())) return;
    const title = await promptDialog({
      title: '프로젝트에 저장',
      message: `${DOCUMENT_SCRATCH.projectDocsDir}/ 아래 파일 이름`,
      defaultValue: 'notes',
      confirmLabel: '저장',
    });
    if (!title) return;
    await saveDocumentToProject(projectDocRelPath(title));
  };

  const onConnectFolder = async (root: string) => {
    setBrowseOpen(false);
    await setDevWorkspace(root);
    await refreshExplorer();
    await flushDocumentAfterWorkspaceConnect();
  };

  const onEditorMount: OnMount = (editor) => {
    editorRef.current = editor;
    editor.onDidChangeCursorSelection(() => {
      const sel = editor.getModel()?.getValueInRange(editor.getSelection()!);
      setDocumentSelection(sel || '');
    });

    const mouseDisp = editor.onMouseDown((e) => {
      if (e.event.rightButton) return;
      const pos = e.target.position;
      if (!pos) return;
      const hit = memosRef.current.find((m) => {
        if (!m.range || m.open) return false;
        const r = m.range;
        if (pos.lineNumber < r.startLineNumber || pos.lineNumber > r.endLineNumber) return false;
        if (pos.lineNumber === r.startLineNumber && pos.column < r.startColumn) return false;
        if (pos.lineNumber === r.endLineNumber && pos.column > r.endColumn + 2) return false;
        return true;
      });
      if (!hit) return;
      e.event.preventDefault();
      e.event.stopPropagation();
      reopenMemo(hit.id, { x: e.event.posx + 8, y: e.event.posy + 8 });
    });

    editor.onDidDispose(() => {
      mouseDisp.dispose();
      editorRef.current = null;
    });
  };

  const pathLabel = documentRelPath || (hasWorkspace ? '(새 문서)' : '메모리 초안');

  const memoWindows =
    openMemos.length > 0
      ? createPortal(
          <>
            {openMemos.map((askNote) => {
              const notePos = clampNotePos(askNote.x, askNote.y);
              return (
                <div
                  key={askNote.id}
                  className="fixed z-[420] flex w-[320px] max-h-[360px] flex-col overflow-hidden rounded-md border border-line bg-panel shadow-[0_12px_40px_rgba(0,0,0,0.45)]"
                  style={{ left: notePos.left, top: notePos.top }}
                  data-testid="document-ask-note"
                >
                  <div
                    className="flex cursor-grab items-center justify-between border-b border-line bg-panel-2 px-2.5 py-1.5 active:cursor-grabbing"
                    title="드래그하여 이동 · 왼쪽 워크스페이스에 가까이 놓으면 붙습니다"
                    onPointerDown={(e) => {
                      if ((e.target as HTMLElement).closest('button')) return;
                      dragRef.current = {
                        id: askNote.id,
                        offsetX: e.clientX - notePos.left,
                        offsetY: e.clientY - notePos.top,
                      };
                      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                    }}
                  >
                    <span className="text-[11px] font-medium text-accent">AI 메모</span>
                    <button
                      type="button"
                      className="rounded px-1.5 text-[12px] text-muted hover:bg-ink hover:text-text"
                      aria-label="메모 접기"
                      title="접기 — 빨간 모서리로 다시 열 수 있습니다"
                      onClick={() => collapseMemo(askNote.id)}
                    >
                      ×
                    </button>
                  </div>
                  <div className="min-h-0 flex-1 space-y-2 overflow-auto px-2.5 py-2">
                    <blockquote className="max-h-16 overflow-auto border-l-2 border-accent/50 pl-2 text-[11px] leading-relaxed text-muted">
                      {askNote.selection}
                    </blockquote>
                    <textarea
                      value={askNote.question}
                      onChange={(e) =>
                        setMemos((prev) =>
                          prev.map((m) =>
                            m.id === askNote.id ? { ...m, question: e.target.value } : m,
                          ),
                        )
                      }
                      rows={2}
                      className="w-full resize-none rounded border border-line bg-ink px-2 py-1.5 text-[12px] text-text outline-none focus:border-accent"
                      placeholder="무엇을 물어볼까요?"
                      disabled={askNote.pending}
                    />
                    {askNote.answer ? (
                      <div className="rounded border border-line/80 bg-ink/60 px-2 py-1.5 text-[12px] leading-relaxed text-text whitespace-pre-wrap">
                        {askNote.answer}
                      </div>
                    ) : (
                      <p className="text-[10px] text-muted">
                        선택 구간에 대한 짧은 설명이 여기 메모처럼 표시됩니다. 채팅에는 남지 않습니다.
                      </p>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-1.5 border-t border-line px-2.5 py-1.5">
                    <button
                      type="button"
                      className="rounded px-1.5 py-1 text-[10px] text-muted hover:text-red-600"
                      onClick={() => removeMemo(askNote.id)}
                      title="메모와 빨간 모서리를 삭제합니다"
                    >
                      삭제
                    </button>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        className="rounded border border-line px-2 py-1 text-[11px] text-muted hover:text-text"
                        onClick={() => collapseMemo(askNote.id)}
                      >
                        접기
                      </button>
                      <button
                        type="button"
                        disabled={askNote.pending || !askNote.selection.trim()}
                        className="rounded bg-accent px-2.5 py-1 text-[11px] font-medium text-ink disabled:opacity-40"
                        onClick={() => void submitAskNote(askNote.id)}
                      >
                        {askNote.pending ? '답변 중…' : '물어보기'}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </>,
          document.body,
        )
      : null;

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-ink" data-testid="markdown-document">
      {!hasWorkspace ? (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-100">
          <p>
            메모리 초안입니다. 질문·후속 대화는 폴더 없이 가능합니다. 저장·파일 수정에는 작업 폴더가
            필요합니다.
          </p>
          <button
            type="button"
            className="shrink-0 rounded-md border border-amber-500/40 px-2 py-1 text-amber-50 hover:bg-amber-500/20"
            onClick={() => setBrowseOpen(true)}
          >
            폴더 연결
          </button>
        </div>
      ) : null}

      <div
        className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-2 py-1.5"
        data-testid="document-tabs"
      >
        <button
          type="button"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-line text-sm text-muted hover:bg-panel-2 hover:text-text"
          aria-label="새 문서"
          data-testid="new-document-tab"
          onClick={() => void newDocument()}
        >
          +
        </button>
        {documentTabs.map((tab) => (
          <div
            key={tab.id}
            className={`flex shrink-0 items-center rounded border ${
              tab.id === activeDocumentTabId ? 'border-accent bg-accent/10' : 'border-line'
            }`}
          >
            <button
              type="button"
              className="max-w-40 truncate px-2 py-1 text-[10px] text-text hover:bg-panel-2"
              title={tab.path ?? tab.title}
              onClick={() => setActiveDocumentTab(tab.id)}
            >
              {tab.title}{tab.dirty ? ' ●' : ''}
            </button>
            <button
              type="button"
              className="px-1.5 py-1 text-[11px] text-muted hover:text-text"
              aria-label={`${tab.title} 닫기`}
              onClick={() => void closeDocumentTab(tab.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-2 py-1.5">
        <span className="mr-1 max-w-[40%] truncate text-[10px] text-muted" title={pathLabel}>
          {pathLabel}
        </span>
        <button
          type="button"
          className="rounded border border-line px-2 py-0.5 text-[10px] text-muted hover:text-text"
          onClick={() => void onOpenWorkspaceDoc()}
        >
          경로로 열기
        </button>
        <button
          type="button"
          className="rounded border border-line px-2 py-0.5 text-[10px] text-muted hover:text-text"
          onClick={() => fileInputRef.current?.click()}
        >
          파일 선택
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={DOCUMENT_SCRATCH.allowedExtensions.join(',')}
          className="hidden"
          onChange={(e) => void onPickFile(e.target.files?.[0] ?? null)}
        />
        <button
          type="button"
          className="rounded border border-line px-2 py-0.5 text-[10px] text-muted hover:text-text"
          onClick={() => void (async () => {
            if (activeDocument?.source === 'workspace' && activeDocument.path) {
              await saveDocument();
            } else {
              await onSaveProject();
            }
          })()}
        >
          {activeDocument?.source === 'workspace' && activeDocument.path ? '저장' : '프로젝트에 저장…'}
        </button>
        <button
          type="button"
          disabled={!lastDumpPath && lastDumpContent == null}
          className="rounded border border-line px-2 py-0.5 text-[10px] text-muted hover:text-text disabled:opacity-40"
          onClick={() => void openLastDump()}
        >
          최근 덤프
        </button>
        {closedMemoCount > 0 ? (
          <button
            type="button"
            className="rounded border border-rose-400/50 bg-rose-500/10 px-2 py-0.5 text-[10px] text-rose-700 hover:bg-rose-500/20"
            title="접힌 AI 메모를 다시 엽니다"
            onClick={() => {
              const closed = memosRef.current.filter((m) => !m.open);
              const first = closed[0];
              if (!first) return;
              reopenMemo(first.id, {
                x: Math.max(8, window.innerWidth - NOTE_W - 24),
                y: 96,
              });
            }}
          >
            접힌 메모 {closedMemoCount}
          </button>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {(['source', 'preview', 'diff'] as const).map((id) => (
            <button
              key={id}
              type="button"
              disabled={id === 'diff' && !lastDumpPath && lastDumpContent == null}
              className={`rounded px-2 py-0.5 text-[10px] ${
                view === id ? 'bg-accent text-ink' : 'text-muted hover:text-text'
              } disabled:opacity-40`}
              onClick={() => setDocumentView(id)}
              title={id === 'diff' ? '덤프 ↔ 현재' : undefined}
            >
              {id === 'source' ? '원문' : id === 'preview' ? '미리보기' : '변경 보기'}
            </button>
          ))}
        </div>
      </div>

      {documentStatus ? (
        <p className="shrink-0 border-b border-line px-3 py-1 text-[10px] text-muted">{documentStatus}</p>
      ) : null}
      {documentDirty ? (
        <p className="shrink-0 px-3 py-0.5 text-[10px] text-amber-200/80">저장되지 않은 변경</p>
      ) : null}

      <div className="relative min-h-0 flex-1" onContextMenu={view === 'source' ? openEditorContextMenu : undefined}>
        {view === 'source' ? (
          <Editor
            height="100%"
            language="markdown"
            theme="vs-dark"
            value={documentContent}
            onChange={(value) => setDocumentContent(value ?? '')}
            onMount={onEditorMount}
            options={{
              minimap: { enabled: false },
              wordWrap: 'on',
              fontSize: 13,
              automaticLayout: true,
              contextmenu: false,
            }}
          />
        ) : null}
        {view === 'preview' ? (
          <div
            className="prose prose-invert max-w-none h-full overflow-auto px-4 py-3 text-sm text-text"
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        ) : null}
        {view === 'diff' ? (
          dumpPreview != null ? (
            <DiffEditor
              height="100%"
              language="markdown"
              theme="vs-dark"
              original={dumpPreview}
              modified={documentContent}
              options={{
                readOnly: true,
                renderSideBySide: true,
                minimap: { enabled: false },
                automaticLayout: true,
              }}
            />
          ) : (
            <p className="p-4 text-xs text-muted">비교할 덤프가 없습니다. 에이전트 덮어쓰기 후 사용할 수 있습니다.</p>
          )
        ) : null}
      </div>

      {menu ? <ContextMenuPortal menu={menu} onClose={close} /> : null}
      {memoWindows}

      <FolderBrowserModal open={browseOpen} onClose={() => setBrowseOpen(false)} onSelect={(root) => void onConnectFolder(root)} />
    </div>
  );
}
