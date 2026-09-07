import { useEffect, useState, type MouseEvent } from 'react';

type Attachment = { id: string; name: string; mime: string; url: string };

/** Legacy uploads are shown at chat level, never guessed onto a historical turn. */
export function SessionAttachmentGallery({ sessionId, onOpen, onMenu }: {
  sessionId: string | null;
  onOpen: (url: string, name: string) => void;
  onMenu: (event: MouseEvent, url: string, name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Attachment[]>([]);
  const [status, setStatus] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!open || !sessionId) return;
    const controller = new AbortController();
    setItems([]);
    setStatus('불러오는 중…');
    void fetch(`/attachments?session=${encodeURIComponent(sessionId)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('첨부 목록을 불러오지 못했습니다.');
        const body = await response.json() as { attachments: Attachment[] };
        if (controller.signal.aborted) return;
        setItems(body.attachments.filter((item) => item.mime.startsWith('image/')));
        setStatus('');
      }).catch(() => {
        if (!controller.signal.aborted) setStatus('첨부 목록을 불러오지 못했습니다. 새로고침으로 재시도하세요.');
      });
    return () => controller.abort();
  }, [open, sessionId, revision]);
  if (!sessionId) return null;
  return <div className="shrink-0 border-b border-line px-3 py-1 text-xs text-muted">
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>대화 첨부 이미지 {open ? '접기' : '보기'}</button>
    {open && <div>
      <p>이 챗에 보관된 이미지입니다. 이전 첨부·전송 대기 파일도 포함될 수 있습니다.</p>
      <button type="button" onClick={() => setRevision((n) => n + 1)}>새로고침</button>
      <p role="status">{status || (!items.length ? '보관된 이미지가 없습니다.' : `${items.length}개`)}</p>
      <div className="flex max-h-48 flex-wrap gap-2 overflow-auto py-2">
        {items.map((item) => <button key={item.id} type="button" title={item.name}
          aria-label={`${item.name} 크게 보기`} onClick={() => onOpen(item.url, item.name)}
          onContextMenu={(event) => onMenu(event, item.url, item.name)} className="w-24 rounded border border-line p-1">
          <img loading="lazy" src={item.url} alt={item.name} className="h-16 w-full object-contain" />
          <span className="block truncate">{item.name}</span>
        </button>)}
      </div>
    </div>}
  </div>;
}
