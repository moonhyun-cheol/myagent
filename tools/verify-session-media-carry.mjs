#!/usr/bin/env node
// 세션 가져오기·요약 후 새 대화에서 생성 이미지/동영상 주소가 유지되는지 검증
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = (p) => pathToFileURL(path.join(root, 'core/dist', p)).href;
const media = await import(dist('sessions/session-media-urls.js'));
const { SessionStore } = await import(dist('sessions/session-store.js'));

const VID = '/outputs/videos/sess_1/3f2a-c1.mp4';
const IMG = '/outputs/images/sess_1/a1.png';

// 1) 허용 형식만 통과 (원격·상위 경로·다른 종류 차단, 중복 제거)
assert.deepEqual(
  media.sanitizeLocalMediaUrls([
    VID, VID, IMG,
    'https://evil.example/x.mp4',
    '/outputs/videos/../../vault/provider-keys.json',
    '/outputs/research/sess_1/r.md',
    '/attachments/abc',
    42,
  ]),
  [VID, IMG],
);
assert.deepEqual(media.sanitizeLocalMediaUrls('nope'), []);

// 2) 세션 메시지에서 수집 + 안내 문구
const msgs = [
  { role: 'user', content: 'a', at: 'x' },
  { role: 'assistant', content: 'b', at: 'x', image_urls: [VID] },
  { role: 'assistant', content: 'c', at: 'x', image_urls: [IMG, VID] },
];
assert.deepEqual(media.collectSessionMediaUrls(msgs), [VID, IMG]);
assert.equal(media.formatCarriedMediaNote([VID, IMG]), '(이전 대화에서 만든 동영상 1개, 이미지 1개를 아래에 함께 표시합니다.)');
assert.equal(media.formatCarriedMediaNote([]), '');

// 3) SessionStore: importPortable 유지 / replaceWithSummary 첨부
const tmp = mkdtempSync(path.join(os.tmpdir(), 'media-carry-'));
try {
  const store = new SessionStore(path.join(tmp, 'sessions'), tmp);
  const imported = store.importPortable({
    conversation: {
      title: 't',
      messages: [
        { role: 'user', content: '영상 만들어줘' },
        { role: 'assistant', content: '동영상을 생성했습니다.', image_urls: [VID, 'https://evil.example/x.mp4'] },
        { role: 'assistant', content: '', image_urls: [IMG] },
      ],
    },
  });
  const reloaded = store.load(imported.id);
  assert.deepEqual(reloaded.messages[1].image_urls, [VID]);
  assert.equal(reloaded.messages.length, 3, 'media-only message must survive import');
  assert.deepEqual(reloaded.messages[2].image_urls, [IMG]);

  const target = 'summary-target';
  store.ensure(target, {});
  store.replaceWithSummary(target, '요약 본문', '원본', media.collectSessionMediaUrls(reloaded.messages));
  const sum = store.load(target);
  assert.equal(sum.messages.length, 1);
  assert.deepEqual(sum.messages[0].image_urls, [VID, IMG]);
  assert.match(sum.messages[0].content, /요약 본문\n\n\(이전 대화에서 만든 동영상 1개, 이미지 1개/);

  const plain = 'summary-plain';
  store.ensure(plain, {});
  store.replaceWithSummary(plain, '요약', '원본');
  const p = store.load(plain);
  assert.equal(p.messages[0].image_urls, undefined);
  assert.equal(p.messages[0].content, '이전 대화 요약\n\n요약');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log('verify-session-media-carry OK');
