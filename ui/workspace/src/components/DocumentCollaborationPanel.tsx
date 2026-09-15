import { useCallback, useEffect, useMemo, useState } from 'react';
import { documentApi, type DocumentListResponse, type DocumentNote, type DocumentRecord } from '../api/documentClient';
import type { DocumentTab } from '../lib/documentFile';
import { useWorkspaceStore } from '../store/workspaceStore';
import { DocumentPortability } from './DocumentPortability';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Bridges file-backed Markdown tabs to the document collaboration API without creating a second editor surface. */
export function DocumentCollaborationPanel({ active, dirty, selection, onNotesChange, visible }: {
  active: DocumentTab | null;
  dirty: boolean;
  selection: { from: number; to: number; quote: string } | null;
  onNotesChange: (notes: DocumentNote[]) => void;
  visible: boolean;
}) {
  const session = useWorkspaceStore((state) => state.activeSessionId);
  const [options, setOptions] = useState<DocumentListResponse | null>(null);
  const [record, setRecord] = useState<DocumentRecord | null>(null);
  const [noteText, setNoteText] = useState('');
  const [status, setStatus] = useState('');
  const [opening, setOpening] = useState(false);

  const refresh = useCallback(async () => {
    if (!session) {
      setOptions(null);
      return;
    }
    try {
      setOptions(await documentApi<DocumentListResponse>(session));
      setStatus('');
    } catch (error) {
      setStatus(errorText(error));
    }
  }, [session]);

  useEffect(() => { void refresh(); }, [refresh, active?.path, active?.content, active?.dirty]);

  const metadata = useMemo(() => {
    if (!active || !options) return null;
    if (active.documentId) return options.documents.find((item) => item.id === active.documentId) ?? null;
    if (active.source !== 'workspace' || !active.path) return null;
    return options.documents.find((item) => item.source === 'project' && item.path?.toLowerCase() === active.path?.toLowerCase()) ?? null;
  }, [active, options]);
  const shared = options?.documents.filter((item) => item.readOnly) ?? [];
  const stored = options?.documents.filter((item) => item.source !== 'project' && !item.readOnly) ?? [];

  useEffect(() => {
    if (!session || !metadata) {
      setRecord(null);
      onNotesChange([]);
      return;
    }
    let live = true;
    void documentApi<DocumentRecord>(session, `/${metadata.id}`).then((document) => {
      if (!live) return;
      setRecord(document);
      onNotesChange(document.notes ?? []);
    }).catch((error) => { if (live) setStatus(errorText(error)); });
    return () => { live = false; };
  }, [session, metadata?.id, metadata?.revision, onNotesChange]);

  const saveNotes = async (notes: DocumentNote[]) => {
    if (!session || !record || !active || dirty || active.readOnly) return;
    try {
      const saved = await documentApi<DocumentRecord>(session, `/${record.id}`, 'PUT', {
        title: record.path ?? record.title,
        markdown: active.content,
        revision: record.revision,
        notes,
      });
      setRecord(saved);
      onNotesChange(saved.notes);
      setNoteText('');
      setStatus('강조·참조를 저장했습니다.');
      await refresh();
    } catch (error) {
      setStatus(errorText(error));
    }
  };

  const addNote = (kind: DocumentNote['kind']) => {
    if (!selection || !record) return;
    void saveNotes([...record.notes, {
      id: crypto.randomUUID(),
      quote: selection.quote,
      note: noteText,
      from: selection.from,
      to: selection.to,
      revision: record.revision + 1,
      kind,
    }]);
  };

  const openApiDocument = async (id: string) => {
    if (!session || !id) return;
    setOpening(true);
    try {
      const document = await documentApi<DocumentRecord>(session, `/${id}`);
      const state = useWorkspaceStore.getState();
      const existing = state.documentTabs.find((tab) => tab.documentId === document.id);
      if (existing) {
        state.setActiveDocumentTab(existing.id);
        return;
      }
      const tab: DocumentTab = {
        id: `shared:${document.id}`,
        title: document.path ?? document.title,
        path: document.path ?? null,
        source: document.readOnly ? 'shared' : 'collaboration',
        documentId: document.id,
        revision: document.revision,
        readOnly: Boolean(document.readOnly),
        content: document.markdown,
        dirty: false,
        selection: '',
        view: 'preview',
        status: document.readOnly ? `공유 문서 · 읽기 전용 · v${document.revision}` : `협업 저장소 문서 · v${document.revision}`,
        lastDumpPath: null,
        lastDumpContent: null,
        memos: [],
        recoveryPath: null,
      };
      useWorkspaceStore.setState({
        documentTabs: [...state.documentTabs, tab],
        activeDocumentTabId: tab.id,
        mode: 'document',
      });
      setStatus(document.readOnly ? '공유 문서를 읽기 전용으로 열었습니다.' : '협업 저장소 문서를 열었습니다.');
    } catch (error) {
      setStatus(errorText(error));
    } finally {
      setOpening(false);
    }
  };

  if (!session || !visible) return null;
  return (
    <div className="shrink-0 border-b border-line bg-panel-2/40 px-3 py-2 text-[11px] text-muted" data-testid="document-support-panel">
      <div className="mb-1 flex items-center justify-between gap-2">
        <strong className="text-text">문서 공유·가져오기</strong>
        <span>AI 공동편집과 별개의 문서 이식·주석 기능입니다.</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1">
          다른 채팅에서 공유된 문서
          <select
            aria-label="다른 채팅에서 공유된 문서"
            className="rounded border border-line bg-panel px-2 py-1 text-text"
            defaultValue=""
            disabled={opening || shared.length === 0}
            onChange={(event) => { const id = event.target.value; event.target.value = ''; void openApiDocument(id); }}
          >
            <option value="">{shared.length ? '선택…' : '없음'}</option>
            {shared.map((item) => <option key={item.id} value={item.id}>{item.path ?? item.title}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1">
          이전 문서 가져오기
          <select
            aria-label="이전 문서 가져오기"
            className="rounded border border-line bg-panel px-2 py-1 text-text"
            defaultValue=""
            disabled={opening || stored.length === 0}
            onChange={(event) => { const id = event.target.value; event.target.value = ''; void openApiDocument(id); }}
          >
            <option value="">{stored.length ? '선택…' : '없음'}</option>
            {stored.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>
        </label>
        {metadata ? (
          <DocumentPortability
            session={session}
            id={metadata.id}
            revision={metadata.revision}
            disabled={dirty}
            readOnly={Boolean(active?.readOnly || metadata.readOnly)}
            projectRoot={Boolean(options?.projectRoot)}
            onChanged={() => void refresh()}
          />
        ) : active?.source === 'workspace' ? (
          <span>문서 이식 정보를 연결하는 중…</span>
        ) : (
          <span>공유·첨부·묶음은 프로젝트에 저장한 문서에서 사용할 수 있습니다.</span>
        )}
      </div>
      {record && metadata ? (
        <details>
          <summary>강조·참조 {record.notes.length}개</summary>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <input aria-label="참조 내용" className="rounded border border-line bg-panel px-2 py-1 text-text" placeholder="선택 구간 메모" value={noteText} onChange={(event) => setNoteText(event.target.value)} />
            <button type="button" className="rounded border border-line px-2 py-1" disabled={!selection || dirty || Boolean(active?.readOnly)} onClick={() => addNote('highlight')}>선택 강조</button>
            <button type="button" className="rounded border border-line px-2 py-1" disabled={!selection || dirty || Boolean(active?.readOnly)} onClick={() => addNote('reference')}>참조 추가</button>
          </div>
          {record.notes.map((note) => (
            <div key={note.id} className="mt-1 flex items-center gap-1">
              <span className={note.detached ? 'line-through opacity-60' : ''}>{note.quote} — {note.note || '강조'}</span>
              <button type="button" className="rounded border border-line px-1.5 py-0.5" disabled={dirty || Boolean(active?.readOnly)} onClick={() => void saveNotes(record.notes.filter((item) => item.id !== note.id))}>제거</button>
            </div>
          ))}
        </details>
      ) : null}
      {status ? <p role="status" className="mt-1">{status}</p> : null}
    </div>
  );
}
