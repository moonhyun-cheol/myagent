import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FileNode } from '../types';

export interface QuickOpenFile {
  path: string;
  name: string;
}

interface QuickOpenModalProps {
  files: QuickOpenFile[];
  onClose: () => void;
  onOpen: (path: string) => void;
  /** Custom dialog chrome (e.g. @ context vs Ctrl+P). */
  title?: string;
  placeholder?: string;
  /** Paths already picked — shown disabled / labeled. */
  selectedPaths?: string[];
  /** Keep dialog open after pick (multi @ chips). */
  keepOpenOnSelect?: boolean;
}

/** Flatten workspace FileNode tree into file paths (folders omitted by default). */
export function flattenWorkspaceFiles(
  nodes: FileNode[],
  opts?: { includeFolders?: boolean },
): QuickOpenFile[] {
  const out: QuickOpenFile[] = [];
  const walk = (list: FileNode[]) => {
    for (const node of list) {
      if (node.kind === 'folder') {
        if (opts?.includeFolders) {
          out.push({ path: node.id, name: node.name });
        }
        if (node.children?.length) walk(node.children);
        continue;
      }
      out.push({ path: node.id, name: node.name });
    }
  };
  walk(nodes);
  return out;
}

function score(path: string, query: string): number | null {
  if (!query) return 0;

  const value = path.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  let cursor = 0;
  let points = 0;

  for (const char of needle) {
    const index = value.indexOf(char, cursor);
    if (index < 0) return null;
    points += index === cursor ? 0 : index - cursor + 1;
    cursor = index + 1;
  }

  return points + path.length / 1000;
}

export function QuickOpenModal({
  files,
  onClose,
  onOpen,
  title = '빠른 열기',
  placeholder = '파일 이름 또는 경로 입력… (Esc 닫기)',
  selectedPaths,
  keepOpenOnSelect = false,
}: QuickOpenModalProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const selected = useMemo(
    () => new Set((selectedPaths ?? []).map((p) => p.replace(/\\/g, '/'))),
    [selectedPaths],
  );

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const matches = useMemo(
    () =>
      files
        .map((file) => ({ file, score: score(file.path, query) }))
        .filter((item): item is { file: QuickOpenFile; score: number } => item.score !== null)
        .sort((a, b) => a.score - b.score || a.file.path.localeCompare(b.file.path))
        .slice(0, 100),
    [files, query],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const choose = (index: number) => {
    const match = matches[index];
    if (!match) return;
    onOpen(match.file.path);
    if (!keepOpenOnSelect) onClose();
    else {
      setQuery('');
      setActiveIndex(0);
      inputRef.current?.focus();
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[210] flex items-start justify-center bg-ink/70 px-4 pt-[12vh] backdrop-blur-sm"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        aria-label={title}
        aria-modal="true"
        className="w-full max-w-xl overflow-hidden rounded-2xl border border-line/90 bg-panel shadow-[0_20px_60px_rgba(0,0,0,0.55)]"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActiveIndex((index) => Math.min(index + 1, Math.max(matches.length - 1, 0)));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActiveIndex((index) => Math.max(index - 1, 0));
          } else if (event.key === 'Enter') {
            event.preventDefault();
            choose(activeIndex);
          }
        }}
      >
        <div className="border-b border-line px-3 py-2.5">
          <p className="mb-1.5 px-0.5 text-[11px] font-medium tracking-wide text-muted">{title}</p>
          <label className="sr-only" htmlFor="my-agent-quick-open-input">
            {placeholder}
          </label>
          <input
            ref={inputRef}
            id="my-agent-quick-open-input"
            aria-activedescendant={matches[activeIndex] ? `quick-open-${activeIndex}` : undefined}
            aria-controls="quick-open-results"
            aria-autocomplete="list"
            autoComplete="off"
            className="w-full rounded-lg border border-line/80 bg-ink/50 px-3 py-2.5 text-sm text-text outline-none placeholder:text-muted/50 focus:border-accent/50"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={placeholder}
            value={query}
          />
          {keepOpenOnSelect ? (
            <p className="mt-1.5 px-0.5 text-[10px] text-muted">선택 후 계속 검색 · Esc로 닫기</p>
          ) : null}
        </div>
        <div id="quick-open-results" className="max-h-[50vh] overflow-y-auto py-1" role="listbox">
          {matches.length === 0 ? (
            <p className="px-4 py-6 text-center text-[13px] text-muted">결과 없음</p>
          ) : (
            matches.map(({ file }, index) => {
              const already = selected.has(file.path.replace(/\\/g, '/'));
              return (
                <button
                  aria-selected={index === activeIndex}
                  className={`flex w-full flex-col gap-0.5 px-4 py-2 text-left transition-colors ${
                    index === activeIndex ? 'bg-accent/15 text-text' : 'text-text/90 hover:bg-panel-2'
                  } ${already ? 'opacity-60' : ''}`}
                  id={`quick-open-${index}`}
                  key={file.path}
                  onClick={() => choose(index)}
                  onMouseEnter={() => setActiveIndex(index)}
                  role="option"
                  type="button"
                >
                  <strong className="truncate text-[13px] font-medium">
                    {file.name}
                    {already ? (
                      <span className="ml-1.5 text-[10px] font-normal text-accent">추가됨</span>
                    ) : null}
                  </strong>
                  <span className="truncate text-[11px] text-muted">{file.path}</span>
                </button>
              );
            })
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}
