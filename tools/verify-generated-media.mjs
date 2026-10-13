#!/usr/bin/env node
/**
 * Generated media persistence (docs/media-output-persistence-plan.md P0):
 * signature sniffing, buffer/stream save, Responses/Chat image extraction,
 * persist + "확인 안 됨" notice. Requires `npx tsc -p tsconfig.json` (core/dist).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dist = new URL('../core/dist/', import.meta.url);
const store = await import(new URL('media/media-store.js', dist));
const extract = await import(new URL('media/generated-media-extract.js', dist));
const persist = await import(new URL('media/generated-media-persist.js', dist));

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('IHDR-fake-png-body')]);
const PNG2 = Buffer.concat([PNG, Buffer.from('second')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-body')]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(12)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('....B\x82\x84webm')]);
const MKV = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('....B\x82\x88matroska')]);
const MOV = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  '), Buffer.alloc(8)]);

// 1. Signature sniffing
assert.equal(store.sniffMedia(PNG)?.mime, 'image/png');
assert.equal(store.sniffMedia(JPEG)?.mime, 'image/jpeg');
assert.equal(store.sniffMedia(Buffer.from('GIF89a......'))?.mime, 'image/gif');
assert.equal(store.sniffMedia(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))?.mime, 'image/webp');
assert.equal(store.sniffMedia(MP4)?.mime, 'video/mp4');
assert.equal(store.sniffMedia(WEBM)?.mime, 'video/webm');
assert.equal(store.sniffMedia(MKV), null, 'generic Matroska rejected');
assert.equal(store.sniffMedia(MOV), null, 'QuickTime rejected');
assert.equal(store.sniffMedia(Buffer.from('<!doctype html><html>')), null);

// 2. Buffer save: atomic, sha-named, kind enforced
const root = mkdtempSync(path.join(tmpdir(), 'gen-media-'));
const target = { expectKind: 'image', dir: path.join(root, 'images', 's1'), urlPrefix: '/outputs/images/s1', cqrRoot: root };
const rec = store.saveMediaBuffer(PNG, target);
assert.equal(rec.kind, 'image');
assert.equal(rec.mime, 'image/png');
assert.equal(rec.bytes, PNG.length);
assert.match(rec.url, /^\/outputs\/images\/s1\/[0-9a-f]{32}\.png$/);
assert.deepEqual(readFileSync(path.join(target.dir, path.basename(rec.url))), PNG);
assert.throws(() => store.saveMediaBuffer(MP4, target), /MEDIA_KIND_MISMATCH/);
assert.throws(() => store.saveMediaBuffer(Buffer.from('<html>err</html>'), target), /MEDIA_UNSUPPORTED_FORMAT/);
assert.throws(() => store.saveMediaBuffer(Buffer.alloc(0), target), /MEDIA_EMPTY/);
assert.throws(() => store.saveMediaBuffer(PNG, { ...target, maxBytes: 4 }), /MEDIA_TOO_LARGE/);
assert.throws(
  () => store.saveMediaBuffer(PNG, { ...target, dir: path.join(root, '..', 'escape') }),
  (e) => e.code === 'OUTSIDE_MY_AGENT_ROOT',
  'path guard applies',
);
assert.equal(existsSync(path.join(root, '..', 'escape')), false, 'guard runs before mkdir');
assert.ok(readdirSync(target.dir).every((f) => !f.endsWith('.tmp')), 'no temp files');

// 3. Stream save (chunked), cap mid-stream, no partial left
const chunked = (buf, size = 7) => new ReadableStream({
  start(c) { for (let i = 0; i < buf.length; i += size) c.enqueue(new Uint8Array(buf.subarray(i, i + size))); c.close(); },
});
const vTarget = { expectKind: 'video', dir: path.join(root, 'videos', 's1'), urlPrefix: '/outputs/videos/s1', cqrRoot: root };
const vRec = await store.saveMediaStream(chunked(MP4, 3), { ...vTarget, baseName: 'clip' });
assert.equal(vRec.url, '/outputs/videos/s1/clip.mp4');
assert.deepEqual(readFileSync(path.join(vTarget.dir, 'clip.mp4')), MP4);
const wRec = await store.saveMediaStream(chunked(WEBM), { ...vTarget, baseName: 'clip2' });
assert.equal(wRec.url, '/outputs/videos/s1/clip2.webm');
await assert.rejects(store.saveMediaStream(chunked(MP4, 4), { ...vTarget, baseName: 'big', maxBytes: 10 }), /MEDIA_TOO_LARGE/);
await assert.rejects(store.saveMediaStream(chunked(MP4), { ...vTarget, baseName: 'cl', contentLength: 10, maxBytes: 5 }), /MEDIA_TOO_LARGE/);
await assert.rejects(store.saveMediaStream(chunked(Buffer.from('{"error":"expired"}')), { ...vTarget, baseName: 'json' }), /MEDIA_UNSUPPORTED_FORMAT/);
await assert.rejects(store.saveMediaStream(null, vTarget), /MEDIA_NO_BODY/);
assert.deepEqual(readdirSync(vTarget.dir).sort(), ['clip.mp4', 'clip2.webm'], 'failed streams leave nothing');

// 4. Responses output extraction
const b64 = PNG.toString('base64');
const b64b = PNG2.toString('base64');
const r1 = extract.collectFromResponsesOutput([
  { type: 'reasoning', summary: [] },
  { type: 'image_generation_call', status: 'completed', output_format: 'png', result: b64 },
  { type: 'image_generation_call', status: 'completed', result: b64 }, // duplicate
  { type: 'message', content: [
    { type: 'output_text', text: 'here' },
    { type: 'output_image', image_url: `data:image/png;base64,${b64b}` },
    { type: 'output_image', image_url: 'https://cdn.example.com/x.png' }, // remote → unsupported
  ] },
  { type: 'image_generation_call', status: 'failed' }, // no result → unsupported
  { type: 'video_generation_call', status: 'completed' }, // video inline → unsupported
]);
assert.equal(r1.images.length, 2, 'dedupe + mixed text/image');
assert.equal(r1.images[0].mime, 'image/png');
assert.equal(r1.unsupported, 3);
assert.deepEqual(extract.collectFromResponsesOutput([{ type: 'message', content: [{ type: 'output_text', text: 'only text' }] }]), { images: [], unsupported: 0 });
assert.equal(extract.collectFromResponsesOutput([{ type: 'image_generation_call', status: 'in_progress' }]).unsupported, 0, 'partial not counted');

// stream items + terminal doc merge without double counting
const merged = extract.mergeGeneratedMedia(
  extract.collectFromResponsesOutput([{ type: 'image_generation_call', status: 'completed', result: b64 }]),
  extract.collectFromResponsesOutput([{ type: 'image_generation_call', status: 'completed', result: b64 }]),
);
assert.equal(merged.images.length, 1);

// 5. Chat Completions (OpenRouter message.images / delta.images)
const c1 = extract.collectFromChatMessage({
  role: 'assistant',
  content: 'drawn',
  images: [
    { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
    { type: 'image_url', image_url: { url: 'https://x.example/remote.png' } },
  ],
});
assert.equal(c1.images.length, 1);
assert.equal(c1.unsupported, 1);
assert.equal(extract.hasGeneratedMedia(extract.collectFromChatMessage({ content: 'plain' })), false);
assert.equal(extract.parseImageDataUrl('data:text/html;base64,PGh0bWw+'), null);

// 6. Persist + notice
const bogus = { mime: 'image/png', base64: Buffer.from('<html>not an image</html>').toString('base64') };
const p = persist.persistGeneratedImages(
  { images: [{ base64: b64 }, { base64: b64b }, bogus], unsupported: 1 },
  { imageOutDir: path.join(root, 'images'), sessionId: 's2', cqrRoot: root },
);
assert.equal(p.media.length, 2);
assert.ok(p.media.every((m) => m.url.startsWith('/outputs/images/s2/') && existsSync(path.join(root, 'images', 's2', path.basename(m.url)))));
assert.equal(p.failed, 1);
assert.equal(p.unsupported, 1);
// P1-4: failed payload kept in the bounded recovery area, not next to outputs.
assert.equal(p.recovered, 1);
const recDir = path.join(root, 'data', 'media-recovery', 's2');
const recFiles = readdirSync(recDir).filter((n) => n.endsWith('.json'));
assert.equal(recFiles.length, 1);
const recovery = JSON.parse(readFileSync(path.join(recDir, recFiles[0]), 'utf8'));
assert.equal(recovery.base64, bogus.base64);
assert.equal(recovery.declared_mime, 'image/png');
assert.match(recovery.reason, /MEDIA_UNSUPPORTED_FORMAT/);
assert.equal(readdirSync(path.join(root, 'images', 's2')).filter((n) => n.endsWith('.json')).length, 0);
const notice = persist.unverifiedMediaNotice(p, 'm/x');
assert.equal(notice.kind, 'failure');
assert.equal(notice.title, '생성 결과 확인 안 됨');
assert.match(notice.message, /2개를 파일로 저장하지 못했습니다/);
assert.match(notice.message, /원본 1개는 복구용 기록/);
assert.equal(persist.unverifiedMediaNotice({ failed: 0, unsupported: 0 }), undefined);
const cap = persist.MEDIA_RECOVERY_LIMITS.maxPerSession;
const many = persist.persistGeneratedImages({ images: Array.from({ length: cap + 2 }, () => bogus), unsupported: 0 }, {
  imageOutDir: path.join(root, 'images'), sessionId: 's4', cqrRoot: root,
});
assert.equal(many.failed, cap + 2);
assert.equal(many.recovered, cap, 'recovery records are capped per session');

// P1-6: history carries a file-info line, never the media itself.
const filters = await import(new URL('chat/chat-filters.js', dist));
const hist = filters.sanitizeHistoryForModel([
  { role: 'assistant', content: '동영상을 생성했습니다.', media: [{ kind: 'video', url: '/outputs/videos/s1/abc.mp4', mime: 'video/mp4', bytes: 3 * 1024 * 1024, sha256: 'x' }], image_urls: ['/outputs/videos/s1/abc.mp4'] },
  { role: 'assistant', content: '', image_urls: ['/outputs/images/s1/old.png', 'https://evil.example/x.png'] },
  { role: 'user', content: 'plain' },
]);
assert.match(hist[0].content, /^동영상을 생성했습니다\.\n\n\[저장된 생성 결과 · 파일 내용은 보내지 않음: 동영상 video\/mp4 3\.0MB \(abc\.mp4\)\]$/);
assert.equal(hist[1].content, '[저장된 생성 결과 · 파일 내용은 보내지 않음: 이미지 (old.png)]');
assert.equal(hist[2].content, 'plain');
assert.ok(!JSON.stringify(hist).includes('base64'));
const known = persist.persistGeneratedImages({ images: [{ base64: b64 }], unsupported: 0 }, {
  imageOutDir: path.join(root, 'images'), sessionId: 's2', cqrRoot: root, knownSha256: [p.media[0].sha256],
});
assert.equal(known.media.length, 0, 'already stored via OWUI ref is not duplicated');
const capped = persist.persistGeneratedImages({ images: [{ base64: b64 }, { base64: b64b }], unsupported: 0 }, {
  imageOutDir: path.join(root, 'images'), sessionId: 's3', cqrRoot: root, maxImages: 1,
});
assert.equal(capped.media.length, 1);

// 7. Source wiring
const src = (p) => readFileSync(new URL(`../core/src/${p}`, import.meta.url), 'utf8');
assert.match(src('providers/responses-compatible.ts'), /collectFromResponsesOutput\(acc\.mediaItems\)/);
assert.match(src('providers/responses-compatible.ts'), /!content && !hasGeneratedMedia\(generated\)/);
assert.match(src('providers/openai-compatible.ts'), /collectFromChatMessage\(\{ images: streamedImages \}\)/);
assert.match(src('chat/chat-orchestrator.ts'), /generated: out\.generated_media/);
assert.match(src('chat/chat-orchestrator.ts'), /generated: chatResult\.generated_media/);
assert.match(src('video/video-generation.ts'), /saveMediaStream\(dl\.body/);
assert.match(src('image/owui-media.ts'), /saveMediaBuffer\(buffer/);
// P1-5: no automatic paid second image request; canvas 재생성 asks first.
const imageGen = src('chat/modes/image-gen.ts');
assert.equal((imageGen.match(/await requestOwuiImage\(|return requestOwuiImage\(/g) ?? []).length, 1);
const workspaceStoreSrc = readFileSync(new URL('../ui/workspace/src/store/workspaceStore.ts', import.meta.url), 'utf8');
assert.match(workspaceStoreSrc, /regenerateAsset:[\s\S]{0,400}confirmDialog\(\{[\s\S]{0,200}title: '이미지 다시 생성'/);

console.log('verify-generated-media: ok');
