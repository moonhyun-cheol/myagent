import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { AttachmentService } from '../core/dist/attachments/attachment-service.js';
import {
  buildAttachmentContext,
  resolveAttachmentContextIds,
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
  const imageOnlySupersedesOlderDocs = resolveAttachmentContextIds([], [
    { role: 'user', content: '엑셀 첨부', at: new Date().toISOString(), attachments: workbookRef },
    { role: 'user', content: '이미지 첨부', at: new Date().toISOString(), attachments: refs },
  ]);
  assert.deepEqual(imageOnlySupersedesOlderDocs, []);

  const note = service.saveFile(session.id, 'design-dates.txt', Buffer.from('HKJ001,2026-09-12'));
  const context = await buildAttachmentContext([note.id], service, session.id);
  assert.match(context, /대화 첨부 원본/);
  assert.match(context, /작업 폴더 밖의 전용 첨부 저장소/);
  assert(context.includes(note.stored_path));
  assert.match(context, /HKJ001,2026-09-12/);

  const source = readFileSync('core/src/chat/chat-orchestrator.ts', 'utf8');
  assert.equal(source.split('attachments: this.attachments.messageAttachments(req.attachments ?? [], sessionId)').length - 1, 4);
  assert.equal(source.split('resolveAttachmentContextIds(').length - 1, 2);
  console.log('PASS: scoped references, durable follow-up documents, current-upload priority, image exclusion, source-path context, GC retention');
} finally {
  rmSync(root, { recursive: true, force: true });
}
