import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { EditorContent, useEditor } from '@tiptap/react';
import { documentExtensions } from '../lib/documentMarkdown';
import { ContextMenuPortal, useContextMenu, type ContextMenuItem } from './ContextMenu';
import './DocumentPane.css';

export interface RenderedMarkdownSelection {
  from: number;
  to: number;
  quote: string;
}

/** WYSIWYG Markdown editor used inside the single Document surface. */
export function RenderedMarkdownEditor({
  content,
  readOnly,
  onChange,
  onSelectionChange,
  onAsk,
  onRequestEdit,
}: {
  content: string;
  readOnly: boolean;
  onChange: (markdown: string) => void;
  onSelectionChange: (selection: RenderedMarkdownSelection | null) => void;
  onAsk: (selection: RenderedMarkdownSelection, point: { x: number; y: number }) => void;
  onRequestEdit: (selection: RenderedMarkdownSelection) => void;
}) {
  const syncing = useRef(false);
  const [selectionPoint, setSelectionPoint] = useState<{ x: number; y: number } | null>(null);
  const latestContent = useRef(content);
  latestContent.current = content;
  const { menu, openAt, close } = useContextMenu();
  const editor = useEditor({
    extensions: documentExtensions(),
    content,
    contentType: 'markdown',
    immediatelyRender: false,
    editorProps: {
      attributes: {
        'aria-label': '렌더링 문서 편집',
        role: 'textbox',
      },
    },
    onUpdate: ({ editor: current }) => {
      if (syncing.current) return;
      const markdown = current.getMarkdown();
      if (markdown !== latestContent.current) onChange(markdown);
    },
    onSelectionUpdate: ({ editor: current }) => {
      if (current.state.selection.empty) {
        setSelectionPoint(null);
        onSelectionChange(null);
        return;
      }
      const { from, to } = current.state.selection;
      const coords = current.view.coordsAtPos(from);
      const viewport = window.visualViewport;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportRight = viewportLeft + (viewport?.width ?? window.innerWidth);
      setSelectionPoint({
        x: Math.max(viewportLeft + 8, Math.min(coords.left, viewportRight - 260)),
        y: Math.max(viewportTop + 8, coords.top - 38),
      });
      onSelectionChange({ from, to, quote: current.state.doc.textBetween(from, to, '\n') });
    },
  });

  useEffect(() => {
    if (!editor || editor.isDestroyed || editor.getMarkdown() === content) return;
    syncing.current = true;
    editor.commands.setContent(content, { contentType: 'markdown', emitUpdate: false });
    syncing.current = false;
  }, [content, editor]);

  useEffect(() => {
    editor?.setEditable(!readOnly, false);
    if (editor && !readOnly && !content.trim()) {
      requestAnimationFrame(() => {
        if (!editor.isDestroyed) editor.commands.focus('end');
      });
    }
  }, [editor, readOnly]);

  const selection = (): RenderedMarkdownSelection | null => {
    if (!editor || editor.isDestroyed || editor.state.selection.empty) return null;
    const { from, to } = editor.state.selection;
    return { from, to, quote: editor.state.doc.textBetween(from, to, '\n') };
  };

  const openRenderedContextMenu = (event: React.MouseEvent) => {
    const selected = selection();
    const items: ContextMenuItem[] = [
      {
        id: 'copy',
        label: '복사',
        disabled: !selected?.quote,
        onSelect: () => selected ? navigator.clipboard.writeText(selected.quote) : undefined,
      },
      {
        id: 'cut',
        label: '잘라내기',
        disabled: readOnly || !selected?.quote,
        onSelect: async () => {
          if (!selected || !editor) return;
          await navigator.clipboard.writeText(selected.quote);
          editor.chain().focus().deleteSelection().run();
        },
      },
      {
        id: 'paste',
        label: '붙여넣기',
        disabled: readOnly,
        onSelect: async () => {
          if (!editor) return;
          const text = await navigator.clipboard.readText();
          editor.chain().focus().insertContent(text).run();
        },
      },
      {
        id: 'edit-with-ai',
        label: 'AI에게 수정 요청',
        disabled: readOnly || !selected?.quote.trim(),
        onSelect: () => { if (selected) onRequestEdit(selected); },
      },
      {
        id: 'ask-ai',
        label: 'AI에게 묻기',
        disabled: !selected?.quote.trim(),
        onSelect: () => {
          if (selected) onAsk(selected, { x: event.clientX, y: event.clientY });
        },
      },
    ];
    openAt(event, items);
  };

  const isEmpty = !content.trim() && (!editor || editor.isEmpty);
  const currentSelection = selection();

  return (
    <div className="document-pane rendered-document-editor relative flex h-full min-h-0 flex-col overflow-hidden p-0" onContextMenu={openRenderedContextMenu}>
      {!readOnly && editor ? (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line bg-panel px-2.5 py-1 text-[11px]" role="toolbar" aria-label="렌더링 편집 서식 도구">
          <button type="button" title="제목 1" className="rounded px-1.5 py-0.5 text-muted hover:bg-panel-2 hover:text-text" onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>H1</button>
          <button type="button" title="제목 2" className="rounded px-1.5 py-0.5 text-muted hover:bg-panel-2 hover:text-text" onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>H2</button>
          <button type="button" title="제목 3" className="rounded px-1.5 py-0.5 text-muted hover:bg-panel-2 hover:text-text" onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>H3</button>
          <span className="mx-0.5 h-3.5 w-px bg-line/70" aria-hidden="true" />
          <button type="button" title="굵게 (Ctrl+B)" className="rounded px-1.5 py-0.5 font-bold text-muted hover:bg-panel-2 hover:text-text" onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleBold().run()}>B</button>
          <button type="button" title="기울임 (Ctrl+I)" className="rounded px-1.5 py-0.5 italic text-muted hover:bg-panel-2 hover:text-text" onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleItalic().run()}>I</button>
          <button type="button" title="취소선" className="rounded px-1.5 py-0.5 line-through text-muted hover:bg-panel-2 hover:text-text" onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleStrike().run()}>S</button>
          <span className="mx-0.5 h-3.5 w-px bg-line/70" aria-hidden="true" />
          <button type="button" title="글머리 기호 목록" className="rounded px-1.5 py-0.5 text-muted hover:bg-panel-2 hover:text-text" onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleBulletList().run()}>• 목록</button>
          <button type="button" title="번호 매기기 목록" className="rounded px-1.5 py-0.5 text-muted hover:bg-panel-2 hover:text-text" onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleOrderedList().run()}>1. 목록</button>
          <button type="button" title="인용문" className="rounded px-1.5 py-0.5 text-muted hover:bg-panel-2 hover:text-text" onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleBlockquote().run()}>인용</button>
          <button type="button" title="코드 블록" className="rounded px-1.5 py-0.5 font-mono text-muted hover:bg-panel-2 hover:text-text" onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleCodeBlock().run()}>{'{ }'}</button>
        </div>
      ) : null}
      {selectionPoint && currentSelection?.quote.trim() ? createPortal(
        <div
          className="fixed z-[430] flex items-center gap-1 rounded-md border border-line bg-panel px-1 py-1 text-[11px] shadow-lg"
          style={{ left: selectionPoint.x, top: selectionPoint.y }}
          role="toolbar"
          aria-label="문서 선택 작업"
          data-testid="document-selection-toolbar"
        >
          <button type="button" className="rounded px-2 py-1 text-text hover:bg-ink" disabled={readOnly} onMouseDown={(event) => event.preventDefault()} onClick={() => { const selected = selection(); if (selected) onRequestEdit(selected); }}>AI에게 수정 요청</button>
          <button type="button" className="rounded px-2 py-1 text-text hover:bg-ink" onMouseDown={(event) => event.preventDefault()} onClick={() => { const selected = selection(); if (selected) onAsk(selected, selectionPoint); }}>AI에게 묻기</button>
        </div>,
        document.body,
      ) : null}
      <div
        className="document-editor-shell relative min-h-0 flex-1 overflow-auto cursor-text"
        onClick={(e) => {
          if (e.target === e.currentTarget && editor && !editor.isDestroyed) {
            editor.commands.focus('end');
          }
        }}
      >
        {isEmpty && !readOnly ? (
          <p className="pointer-events-none absolute left-5 top-5 select-none text-sm text-muted/70">
            여기에 내용을 입력하거나 마크다운을 붙여넣으세요…
          </p>
        ) : null}
        <EditorContent editor={editor} />
      </div>
      {menu ? <ContextMenuPortal menu={menu} onClose={close} footer="렌더링 편집" /> : null}
    </div>
  );
}
