import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { AttachmentService } from '../core/dist/attachments/attachment-service.js';
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
  const source = readFileSync('core/src/chat/chat-orchestrator.ts', 'utf8');
  assert.equal(source.split('attachments: this.attachments.messageAttachments(req.attachments ?? [], sessionId)').length - 1, 4);
  console.log('PASS: scoped references, dedupe, missing ID, disk/session restart, bytes, GC retention, legacy listing, four request paths');
} finally {
  rmSync(root, { recursive: true, force: true });
}
