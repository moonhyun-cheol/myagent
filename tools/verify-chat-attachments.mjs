import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { AttachmentService } from '../core/dist/attachments/attachment-service.js';
import {
  buildAttachmentContext,
  resolveAttachmentContextIds,
  historyReferenceOnlyIds,
  VISUAL_TURN_DOC_LOOKBACK_USER_TURNS,
} from '../core/dist/attachments/text-extract.js';
import { SessionStore } from '../core/dist/sessions/session-store.js';
import { collectLiveTempRefs, pruneSessionTemp } from '../core/dist/sessions/session-temp-gc.js';

const base = path.resolve('data/outputs/verify-chat-attachments');
mkdirSync(base, { recursive: true });
const root = mkdtempSync(path.join(base, 'run-'));
try {
  const sessionsDir = path.join(root, 'data/sessions');
  mkdirSync(sessionsDir, { recursive: true });
  const store = new SessionStore(sessionsDir, root);
  const service = new AttachmentService(path.join(root, 'data/attachments'), root, 1024);
  const session = store.ensure('attachment-regression');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9S8AAAAASUVORK5CYII=', 'base64');
  const file = service.saveFile(session.id, '한글 image.png', png);
  const refs = service.messageAttachments([file.id, file.id, 'missing'], session.id);
  assert.equal(refs.length, 1);
  assert.equal(service.messageAttachments([file.id], 'other-chat').length, 0);
  assert.equal(service.listSession('../').length, 0);
  store.append(session.id, { role: 'user', content: '이미지 확인', at: new Date().toISOString(), attachments: refs });
  const reloaded = new SessionStore(sessionsDir, root).load(session.id);
  assert.deepEqual(reloaded.messages[0].attachments, refs);
  const restarted = new AttachmentService(path.join(root, 'data/attachments'), root, 1024);
  assert.deepEqual(restarted.readBytes(file.id, session.id), png);
  assert.deepEqual(restarted.listSession(session.id), refs);
  assert(collectLiveTempRefs(reloaded.messages).attachments.has(file.id));
  pruneSessionTemp(root, session.id, [reloaded]);
  assert.deepEqual(restarted.readBytes(file.id, session.id), png);
  const legacy = service.saveFile(session.id, 'legacy.png', png);
  assert(restarted.listSession(session.id).some((item) => item.id === legacy.id));
  assert(!reloaded.messages[0].attachments.some((item) => item.id === legacy.id));

  const workbook = service.saveFile(session.id, 'design-dates.xlsx', Buffer.from('xlsx-placeholder'));
  const workbookRef = service.messageAttachments([workbook.id], session.id);
  const currentWins = resolveAttachmentContextIds(['new-upload', 'new-upload'], reloaded.messages);
  assert.deepEqual(currentWins, ['new-upload']);
  const restoredWorkbook = resolveAttachmentContextIds([], [
    ...reloaded.messages,
    { role: 'user', content: '엑셀 첨부', at: new Date().toISOString(), attachments: workbookRef },
  ]);
  assert.deepEqual(restoredWorkbook, [workbook.id]);
  // Visual-only turns never hide an earlier document (scan continues past them).
  const imageOnlyKeepsOlderDocs = resolveAttachmentContextIds([], [
    { role: 'user', content: '엑셀 첨부', at: new Date().toISOString(), attachments: workbookRef },
    { role: 'user', content: '이미지 첨부', at: new Date().toISOString(), attachments: refs },
  ]);
  assert.deepEqual(imageOnlyKeepsOlderDocs, [workbook.id]);
  const describe = (id) => {
    const rec = service.get(id, session.id);
    return rec ? { name: rec.original_name, mime: rec.mime } : null;
  };
  const docHistory = [{ role: 'user', content: '엑셀 첨부', at: new Date().toISOString(), attachments: workbookRef }];
  // Current upload is image-only: keep it first and add the latest earlier document.
  assert.deepEqual(resolveAttachmentContextIds([file.id], docHistory, 6, describe), [file.id, workbook.id]);
  // Current upload has a document: current stays authoritative.
  const fresh = service.saveFile(session.id, 'fresh.log', Buffer.from('ERR 1'));
  assert.deepEqual(resolveAttachmentContextIds([file.id, fresh.id], docHistory, 6, describe), [file.id, fresh.id]);
  // Without metadata lookup the legacy current-only rule holds.
  assert.deepEqual(resolveAttachmentContextIds([file.id], docHistory), [file.id]);

  const note = service.saveFile(session.id, 'design-dates.txt', Buffer.from('HKJ001,2026-09-12'));
  const context = await buildAttachmentContext([note.id], service, session.id);
  assert.match(context, /대화 첨부 원본/);
  assert.match(context, /작업 폴더 밖의 전용 첨부 저장소/);
  assert(context.includes(note.stored_path));
  assert.match(context, /HKJ001,2026-09-12/);

  // Visual-only upload: documents older than the lookback window stay out.
  const plain = (n) => Array.from({ length: n }, () => ({ role: 'user', content: '질문', at: new Date().toISOString() }));
  const withinWindow = [...docHistory, ...plain(VISUAL_TURN_DOC_LOOKBACK_USER_TURNS - 1)];
  assert.deepEqual(resolveAttachmentContextIds([file.id], withinWindow, 6, describe), [file.id, workbook.id]);
  const beyondWindow = [...docHistory, ...plain(VISUAL_TURN_DOC_LOOKBACK_USER_TURNS)];
  assert.deepEqual(resolveAttachmentContextIds([file.id], beyondWindow, 6, describe), [file.id]);
  // No-upload follow-up keeps the unlimited legacy restore.
  assert.deepEqual(resolveAttachmentContextIds([], beyondWindow, 6, describe), [workbook.id]);

  // History docs next to a current upload are reference-only; no-upload follow-up keeps bodies.
  assert.deepEqual(historyReferenceOnlyIds([file.id], [file.id, note.id]), [note.id]);
  assert.deepEqual(historyReferenceOnlyIds([], [note.id]), []);
  const refCtx = await buildAttachmentContext([file.id, note.id], service, session.id, 12000, { referenceOnlyIds: [note.id] });
  assert.match(refCtx, /이전 턴 문서 첨부 — 참조만, 본문 미포함/);
  assert(refCtx.includes(note.stored_path));
  assert(refCtx.includes(`attachment_id: ${note.id}`));
  assert(!refCtx.includes('HKJ001,2026-09-12'));
  assert.match(refCtx, /이미지 첨부: 한글 image\.png/);

  const source = readFileSync('core/src/chat/chat-orchestrator.ts', 'utf8');
  assert.equal(source.split('attachments: this.attachments.messageAttachments(req.attachments ?? [], sessionId)').length - 1, 5); // +1 video generation path (b2332f8)
  assert.equal(source.split('resolveAttachmentContextIds(').length - 1, 2);
  // Both tool-plane sites mark history docs reference-only (chat paths keep bodies).
  assert.equal(source.split('historyReferenceOnlyIds(req.attachments ?? [], attachmentContextIds)').length - 1, 2);
  console.log('PASS: scoped references, durable follow-up documents, current-upload priority, image exclusion, source-path context, GC retention');
} finally {
  rmSync(root, { recursive: true, force: true });
}
