import { useEffect, useMemo, useRef, useState } from 'react';
import { Briefcase, Browser, ImageSquare, SquaresFour, TerminalWindow } from '@phosphor-icons/react';
import type { WorkspaceMode } from '../types';
import {
  readPreviewLayout,
  useWorkspaceStore,
  writePreviewLayout,
  type PreviewDisplayState,
} from '../store/workspaceStore';
import { BrowserPane } from './BrowserPane';
import {
  APP_PREFERENCES_CHANGED_EVENT,
  syncMinimizeToTrayOnClose,
} from '../lib/appPreferences';
import { ChatPane } from './ChatPane';
import { GeminiNavSidebar } from './GeminiNavSidebar';
import { ImagePreviewModal } from './ImagePreviewModal';
import { ConfirmModal } from './ConfirmModal';
import { MediaPane } from './MediaPane';
import { MultiModalCanvas } from './MultiModalCanvas';
import { ResizableSplit } from './ResizableSplit';
import { TerminalPane } from './TerminalPane';
import { WorkspaceObjectsPane, type TodoProgressItem } from './WorkspaceObjectsPane';

const PREVIEW_MODES: { id: WorkspaceMode; label: string; icon: typeof Browser }[] = [
  { id: 'objects', label: '작업', icon: Briefcase },
  { id: 'canvas', label: '캔버스', icon: SquaresFour },
  { id: 'media', label: '미디어', icon: ImageSquare },
  { id: 'browser', label: '웹', icon: Browser },
];

function cleanTodoLabel(value: string): string {
  return value
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s*[:：]\s*$/, '')
    .trim();
}

type ExtractedTodo = {
  label: string;
  checked?: boolean;
};

function extractTodoItems(text: string): ExtractedTodo[] {
  const taskListItems = [...text.matchAll(/^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/gm)]
    .map((match) => ({
      label: cleanTodoLabel(match[2] ?? ''),
      checked: (match[1] ?? '').toLowerCase() === 'x',
    }))
    .filter((item) => Boolean(item.label));
  const numberedHeadings = [...text.matchAll(/^\s{0,3}#{1,6}\s+(?:\*\*)?\d+[.)]\s+(.+?)(?:\*\*)?\s*$/gm)]
    .map((match) => ({ label: cleanTodoLabel(match[1] ?? '') }))
    .filter((item) => Boolean(item.label));
  const boldListItems = [...text.matchAll(/^\s*[-*]\s+\*\*(.+?)\*\*\s*(?::|：|$)/gm)]
    .map((match) => ({ label: cleanTodoLabel(match[1] ?? '') }))
    .filter((item) => Boolean(item.label));
  const candidates = taskListItems.length > 0
    ? taskListItems
    : numberedHeadings.length >= 2
      ? numberedHeadings
      : boldListItems;
  return candidates
    .filter((item, index) => candidates.findIndex((candidate) => candidate.label === item.label) === index)
    .slice(0, 12);
}

const PIP_MIN_WIDTH = 360;
const PIP_MAX_WIDTH = 960;
const PIP_MIN_HEIGHT = 240;
const PIP_MAX_HEIGHT = 720;

function clampPipSize(
  size: { width: number; height: number },
  pos: { x: number; y: number },
): { width: number; height: number } {
  const maxW = Math.min(PIP_MAX_WIDTH, Math.max(PIP_MIN_WIDTH, window.innerWidth - pos.x));
  const maxH = Math.min(PIP_MAX_HEIGHT, Math.max(PIP_MIN_HEIGHT, window.innerHeight - pos.y));
  return {
    width: Math.min(maxW, Math.max(PIP_MIN_WIDTH, size.width)),
    height: Math.min(maxH, Math.max(PIP_MIN_HEIGHT, size.height)),
  };
}

function clampPipPosition(
  pos: { x: number; y: number },
  size: { width: number; height: number },
): { x: number; y: number } {
  const maxX = Math.max(0, window.innerWidth - size.width);
  const maxY = Math.max(0, window.innerHeight - size.height);
  return {
    x: Math.min(maxX, Math.max(0, pos.x)),
    y: Math.min(maxY, Math.max(0, pos.y)),
  };
}

function PreviewBody() {
  const saved = useMemo(() => readPreviewLayout(), []);
  const [displayState, setDisplayState] = useState<PreviewDisplayState>(saved.displayState);
  const [pipPosition, setPipPosition] = useState(() =>
    typeof window === 'undefined'
      ? saved.position
      : clampPipPosition(saved.position, clampPipSize(saved.size, saved.position)),
  );
  const [pipSize, setPipSize] = useState(() =>
    typeof window === 'undefined' ? saved.size : clampPipSize(saved.size, saved.position),
  );
  const pipDragRef = useRef<{ offsetX: number; offsetY: number } | null>(null);
  const pipResizeRef = useRef<{ startX: number; startY: number; width: number; height: number } | null>(null);
  const mode = useWorkspaceStore((s) => s.mode);
  const chat = useWorkspaceStore((s) => s.chat);
  const busy = useWorkspaceStore((s) => s.busy);
  const todoItems = useMemo<TodoProgressItem[]>(() => {
    // To-do는 도구 호출 기록이 아니라 모델이 답변에서 구분한 과제·목표를 보여준다.
    const sourceTurn = [...chat]
      .reverse()
      .find((turn) => turn.role === 'assistant' && turn.text.trim());
    const checklistItems = extractTodoItems(sourceTurn?.text ?? '');
    return checklistItems.map((item, index) => ({
      id: `${sourceTurn?.id ?? 'todo'}-${index}-${item.label}`,
      label: item.label,
      status: item.checked === true
        ? 'done'
        : busy
          ? (index === checklistItems.findIndex((candidate) => candidate.checked !== true) ? 'active' : 'pending')
          : 'done',
    }));
  }, [busy, chat]);

  const detachPreview = () => {
    const bridge = (window as typeof window & {
      chrome?: { webview?: { postMessage: (message: unknown) => void } };
    }).chrome?.webview;
    if (bridge) {
      bridge.postMessage({ type: 'preview.detach', mode });
      return;
    }
    window.open(`${window.location.origin}/?preview=${encodeURIComponent(mode)}`, '_blank', 'popup,width=960,height=720');
  };

  const pipPositionRef = useRef(pipPosition);
  const pipSizeRef = useRef(pipSize);
  pipPositionRef.current = pipPosition;
  pipSizeRef.current = pipSize;

  useEffect(() => {
    writePreviewLayout({ displayState, position: pipPosition, size: pipSize });
  }, [displayState, pipPosition, pipSize]);

  useEffect(() => {
    if (displayState !== 'pip') return;

    const onMove = (e: PointerEvent) => {
      if (pipDragRef.current) {
        const size = pipSizeRef.current;
        setPipPosition(
          clampPipPosition(
            {
              x: e.clientX - pipDragRef.current.offsetX,
              y: e.clientY - pipDragRef.current.offsetY,
            },
            size,
          ),
        );
      }
      if (pipResizeRef.current) {
        const pos = pipPositionRef.current;
        const dx = e.clientX - pipResizeRef.current.startX;
        const dy = e.clientY - pipResizeRef.current.startY;
        setPipSize(
          clampPipSize(
            {
              width: pipResizeRef.current.width + dx,
              height: pipResizeRef.current.height + dy,
            },
            pos,
          ),
        );
      }
    };
    const onUp = () => {
      pipDragRef.current = null;
      pipResizeRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [displayState]);

  const enterPip = () => {
    const size = clampPipSize(pipSize, pipPosition);
    const position = clampPipPosition(
      {
        x: Math.max(24, window.innerWidth - size.width - 24),
        y: Math.max(24, window.innerHeight - size.height - 24),
      },
      size,
    );
    setPipSize(size);
    setPipPosition(position);
    setDisplayState('pip');
  };

  const previewDisplayActions = (
    <div className="flex items-center gap-1" aria-label="Preview 표시 제어">
      {displayState !== 'pip' && (
        <button
          type="button"
          className="rounded px-2 py-1 text-[11px] text-muted transition hover:bg-hover hover:text-primary"
          onClick={enterPip}
          aria-label="PiP로 분리"
          title="Preview를 PiP로 분리"
        >
          PiP
        </button>
      )}
      {displayState === 'pip' && (
        <button
          type="button"
          className="rounded px-2 py-1 text-[11px] text-muted transition hover:bg-hover hover:text-primary"
          onClick={() => setDisplayState('docked')}
          aria-label="원래 위치로"
        >
          고정
        </button>
      )}
      <button
        type="button"
        className="rounded px-2 py-1 text-[11px] text-muted transition hover:bg-hover hover:text-primary"
        onClick={detachPreview}
        aria-label="현재 프리뷰를 새 창으로 열기"
        title="다른 디스플레이로 옮길 수 있는 별도 창"
      >
        새 창
      </button>
      <button
        type="button"
        className="rounded px-2 py-1 text-[11px] text-muted transition hover:bg-hover hover:text-primary"
        onClick={() => setDisplayState('closed')}
        aria-label="닫기"
      >
        닫기
      </button>
    </div>
  );

  if (displayState === 'closed') {
    return (
      <div className="flex h-full min-h-16 items-center justify-center border border-line bg-panel px-4">
        <button
          type="button"
          className="rounded-md border border-line px-3 py-1.5 text-xs text-muted transition hover:border-accent hover:text-primary"
          onClick={() => setDisplayState('docked')}
        >
          Preview 다시 열기
        </button>
      </div>
    );
  }

  const isPip = displayState === 'pip';

  const floatingOrDocked = (
    <div
      className={
        isPip
          ? 'fixed z-40 flex flex-col overflow-hidden rounded-lg border border-line bg-panel shadow-2xl'
          : 'relative flex h-full min-h-0 w-full flex-col'
      }
      style={
        isPip
          ? {
              left: pipPosition.x,
              top: pipPosition.y,
              width: pipSize.width,
              height: pipSize.height,
            }
          : undefined
      }
      data-preview-display={displayState}
    >
      <div
        className={`flex h-9 shrink-0 items-center justify-between border-b border-line px-3 ${
          isPip ? 'cursor-grab active:cursor-grabbing' : ''
        }`}
        onPointerDown={
          isPip
            ? (e) => {
                if ((e.target as HTMLElement).closest('button')) return;
                pipDragRef.current = {
                  offsetX: e.clientX - pipPosition.x,
                  offsetY: e.clientY - pipPosition.y,
                };
                (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
              }
            : undefined
        }
      >
        <span className="text-xs font-medium text-primary">Preview</span>
        {previewDisplayActions}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {mode === 'objects' ? <WorkspaceObjectsPane showDownloadActions todoItems={todoItems} /> : null}
        {mode === 'canvas' ? <MultiModalCanvas /> : null}
        {mode === 'media' ? <MediaPane /> : null}
        {mode === 'browser' ? <BrowserPane /> : null}
      </div>
      {isPip ? (
        <button
          type="button"
          aria-label="Preview 크기 조절"
          className="absolute bottom-0 right-0 h-4 w-4 cursor-se-resize border-0 bg-transparent"
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            pipResizeRef.current = {
              startX: e.clientX,
              startY: e.clientY,
              width: pipSize.width,
              height: pipSize.height,
            };
            (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
          }}
        />
      ) : null}
    </div>
  );

  if (!isPip) return floatingOrDocked;

  return (
    <>
      <div className="flex h-full min-h-16 flex-col items-center justify-center gap-2 border border-dashed border-line bg-panel/60 px-4">
        <p className="text-xs text-muted">PiP로 분리됨</p>
        <button
          type="button"
          className="rounded-md border border-line px-3 py-1.5 text-xs text-muted transition hover:border-accent hover:text-primary"
          onClick={() => setDisplayState('docked')}
          aria-label="원래 위치로"
        >
          고정으로 복귀
        </button>
      </div>
      {floatingOrDocked}
    </>
  );
}

const EDITING_ONLY_CTRL_KEYS = new Set(['a', 'v', 'x', 'y', 'z']);
const BLOCKED_BROWSER_CTRL_KEYS = new Set(['d', 'h', 'j', 'l', 'n', 'o', 'r', 't', 'u', 'w', '+', '-', '0']);

function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]') !== null;
}

function PreviewPane() {
  const mode = useWorkspaceStore((s) => s.mode);
  const setMode = useWorkspaceStore((s) => s.setMode);
  const terminalOpen = useWorkspaceStore((s) => s.terminalOpen);
  const terminalAttention = useWorkspaceStore((s) => s.terminalAttention);
  const setTerminalOpen = useWorkspaceStore((s) => s.setTerminalOpen);
  const refreshExplorer = useWorkspaceStore((s) => s.refreshExplorer);

  useEffect(() => {
    void refreshExplorer();
  }, [refreshExplorer]);

  useEffect(() => {
    if (mode === 'editor') setMode('browser');
  }, [mode, setMode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      const editing = isTextEditingTarget(e.target);

      if ((e.ctrlKey || e.metaKey) && EDITING_ONLY_CTRL_KEYS.has(key) && !editing) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }

      if (
        ((e.ctrlKey || e.metaKey) && BLOCKED_BROWSER_CTRL_KEYS.has(key))
        || (!editing && (e.key === 'BrowserBack' || e.key === 'BrowserForward' || e.key === 'Backspace'))
        || (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight'))
        || e.key === 'F5'
        || e.key === 'F12'
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }

      if (!(e.ctrlKey || e.metaKey)) return;
      // 터미널 토글은 Edge 다운로드와 충돌하는 Ctrl+J 없이 Ctrl+`만 사용한다.
      if (e.key === '`') {
        e.preventDefault();
        setTerminalOpen(!useWorkspaceStore.getState().terminalOpen);
        return;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [setTerminalOpen]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel" data-preview-pane tabIndex={-1}>
      <div className="flex shrink-0 items-center justify-end gap-1.5 border-b border-line px-2 py-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <div className="flex gap-0.5 rounded-lg border border-line bg-ink p-0.5">
            {PREVIEW_MODES.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setMode(id)}
                className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium ${
                  mode === id ? 'bg-accent text-ink' : 'text-muted hover:text-text'
                }`}
              >
                <Icon size={13} weight="bold" />
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setTerminalOpen(!terminalOpen)}
            aria-pressed={terminalOpen}
            title={terminalOpen ? '터미널 닫기 (Ctrl+`)' : '터미널 열기 (Ctrl+`)'}
            className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-[11px] font-medium ${
              terminalAttention
                ? 'animate-terminal-attention border-accent/70 bg-accent/20 text-accent'
                : terminalOpen
                  ? 'border-accent/50 bg-accent/15 text-accent'
                  : 'border-line bg-ink text-muted hover:text-text'
            }`}
          >
            <TerminalWindow size={14} weight="bold" />
            Terminal
            {terminalAttention ? <span className="text-[10px]">완료</span> : null}
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {terminalOpen ? (
          <ResizableSplit
            className="h-full"
            axis="vertical"
            reverse
            initial={200}
            min={120}
            max={520}
            first={
              <div className="h-full min-h-0">
                <PreviewBody />
              </div>
            }
            second={<TerminalPane />}
          />
        ) : (
          <>
            <div className="min-h-0 flex-1">
              <PreviewBody />
            </div>
            <TerminalPane />
          </>
        )}
      </div>
    </div>
  );
}

export function MainWorkspaceContainer() {
  useEffect(() => {
    const syncPreference = () => syncMinimizeToTrayOnClose();
    syncPreference();
    window.addEventListener(APP_PREFERENCES_CHANGED_EVENT, syncPreference);
    return () => window.removeEventListener(APP_PREFERENCES_CHANGED_EVENT, syncPreference);
  }, []);
  const previewPaneOpen = useWorkspaceStore((s) => s.previewPaneOpen);
  const setMode = useWorkspaceStore((s) => s.setMode);
  const detachedMode = new URLSearchParams(window.location.search).get('preview') as WorkspaceMode | null;

  useEffect(() => {
    if (detachedMode && PREVIEW_MODES.some((item) => item.id === detachedMode)) setMode(detachedMode);
  }, [detachedMode, setMode]);

  if (detachedMode && PREVIEW_MODES.some((item) => item.id === detachedMode)) {
    return (
      <div className="h-full min-h-0 bg-ink text-text">
        <PreviewPane />
        <ImagePreviewModal />
        <ConfirmModal />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-ink text-text">
      <div className="flex min-h-0 flex-1">
        <GeminiNavSidebar />
        <div className="min-h-0 min-w-0 flex-1">
          {previewPaneOpen ? (
            <ResizableSplit
              className="h-full"
              axis="horizontal"
              initial={420}
              min={280}
              max={900}
              reverse
              first={<ChatPane />}
              second={<PreviewPane />}
            />
          ) : (
            <div className="h-full min-w-0">
              <ChatPane />
            </div>
          )}
        </div>
      </div>

      <ImagePreviewModal />
      <ConfirmModal />
    </div>
  );
}
