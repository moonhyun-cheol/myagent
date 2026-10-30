#!/usr/bin/env node
// Decision image gate: Jev accepts only 280–1568 px per side. Out-of-range PNGs are rescaled, others dropped.
// Optional live check: DECISION_IMAGE_LIVE_ROOT=<app root with provider keys> sends one fitted image to Jev.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import zlib from 'node:zlib';

const root = process.cwd();
const fit = await import(pathToFileURL(path.join(root, 'core/dist/agent/decision-image-fit.js')).href);
let passed = 0;
const pass = (name) => { passed += 1; console.log(`PASS ${name}`); };

function crc32(buf) { let c = 0xffffffff; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
/** RGB PNG with filter type `filter` on every row (exercises the unfilter path). */
function png(w, h, filter = 0, colorType = 2) {
  const ch = colorType === 6 ? 4 : 3;
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = colorType;
  const px = (x, y) => [(x * 7) & 255, (y * 5) & 255, 128, 200].slice(0, ch);
  const raw = Buffer.alloc((w * ch + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * ch + 1)] = filter;
    for (let x = 0; x < w; x++) {
      const cur = px(x, y);
      const left = x ? px(x - 1, y) : [0, 0, 0, 0];
      for (let k = 0; k < ch; k++) raw[y * (w * ch + 1) + 1 + x * ch + k] = filter === 1 ? (cur[k] - left[k]) & 255 : cur[k];
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const url = (buf, mime = 'image/png') => `data:${mime};base64,${buf.toString('base64')}`;
const sizeOf = (u) => fit.readImageSize(Buffer.from(u.split(',')[1], 'base64'));

assert.deepEqual(fit.readImageSize(png(210, 126)), { width: 210, height: 126 });
const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x7e, 0x00, 0xd2, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
assert.deepEqual(fit.readImageSize(jpegHeader), { width: 210, height: 126 });
pass('reads PNG/JPEG header size');

assert.equal(fit.fitsDecisionImage({ width: 280, height: 1568 }), true);
assert.equal(fit.fitsDecisionImage({ width: 279, height: 600 }), false);
assert.equal(fit.fitsDecisionImage({ width: 1569, height: 600 }), false);
pass('280–1568 per-side bounds (live-probed)');

const inRange = url(png(512, 300));
const same = fit.fitDecisionImages([inRange, 'data:image/png;base64,AAAA']);
assert.deepEqual(same, { images: [inRange, 'data:image/png;base64,AAAA'], resized: 0, dropped: 0 });
pass('in-range and unreadable images pass through unchanged');

for (const [w, h, filter, color] of [[210, 126, 0, 2], [1920, 1080, 1, 2], [64, 64, 1, 6], [4000, 200, 0, 2]]) {
  const r = fit.fitDecisionImages([url(png(w, h, filter, color))]);
  assert.equal(r.resized, 1, `${w}x${h} resized`);
  const s = sizeOf(r.images[0]);
  assert.ok(fit.fitsDecisionImage(s), `${w}x${h} -> ${s.width}x${s.height} in range`);
}
const small = fit.decisionImageTarget(210, 126);
assert.deepEqual([small.canvasWidth, small.canvasHeight], [467, 280]);
const wide = fit.decisionImageTarget(4000, 200);
assert.deepEqual([wide.width, wide.canvasWidth, wide.canvasHeight], [1568, 1568, 280], 'extreme ratio padded');
pass('out-of-range PNGs rescaled (up, down, RGBA, extreme ratio padded)');

const decoded = fit.decodePng(png(3, 2, 1));
assert.deepEqual([...decoded.data.slice(4, 8)], [7, 0, 128, 255], 'sub filter decoded');
pass('PNG unfilter correct');

const jpegSmall = fit.fitDecisionImages([url(jpegHeader, 'image/jpeg')]);
assert.deepEqual([jpegSmall.images.length, jpegSmall.dropped], [0, 1]);
pass('out-of-range non-PNG dropped (decision runs text-only)');

if (process.env.DECISION_IMAGE_LIVE_ROOT) {
  const liveRoot = path.resolve(process.env.DECISION_IMAGE_LIVE_ROOT);
  const { ProviderStore } = await import(pathToFileURL(path.join(root, 'core/dist/providers/provider-store.js')).href);
  const key = new ProviderStore(path.join(liveRoot, 'data', 'vault', 'provider-keys.json'), liveRoot).getSecret('custom')?.api_key;
  assert.ok(key, 'live key');
  const { images } = fit.fitDecisionImages([url(png(210, 126))]);
  const res = await fetch('https://openrouter.ai/api/alpha/decisions', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: '~typesafe/jev-latest', state: [{ type: 'text', text: '{"user_request":"check"}' }, { type: 'image_url', image_url: { url: images[0] } }], questions: { ok: { type: 'choice', instructions: 'Is an image attached?', criteria: { yes: 'yes', no: 'no' } } } }),
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(res.status, 200, await res.text());
  pass('live: fitted 210x126 accepted by ~typesafe/jev-latest');
}
console.log(`verify-decision-image-fit: ${passed} passed`);
