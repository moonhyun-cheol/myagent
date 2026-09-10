/**
 * CQR_PA port #5 — model-driven historical image context.
 * Verifies: catalog generation, session isolation, tool registration,
 * retrieval, and absence of local selection heuristics.
 *
 * Run: node node_modules/typescript/bin/tsc -p tsconfig.json && node tools/verify-conversation-image-catalog.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildConversationImageCatalog,
  formatConversationImageCatalogNote,
  validateConversationImage,
  isCatalogEligibleImageMime,
  CONVERSATION_IMAGE_CATALOG_MAX,
} from '../core/dist/agent/conversation-image-catalog.js';
import { CODE_AGENT_TOOL_NAMES } from '../core/dist/agent/agent-tool-definitions.js';
import { getCodeAgentToolsByPack } from '../core/dist/agent/agent-tool-registry.js';
import { executeAgentTool } from '../core/dist/agent/agent-tool-execute.js';
import { AttachmentService } from '../core/dist/attachments/attachment-service.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const check = (name, fn) => {
  fn();
  pass += 1;
  console.log(`ok - ${name}`);
};

// 1. Catalog generation from durable messages (excludes svg + non-image).
check('catalog generation excludes svg/non-image and keeps metadata', () => {
  const messages = [
    { role: 'user', content: 'first with shot', at: '2026-01-01T00:00:00.000Z',
      attachments: [{ id: 'img-1', name: 'shot.png', mime: 'image/png', url: '/a/img-1' }] },
    { role: 'assistant', content: 'reply', at: '2026-01-01T00:01:00.000Z' },
    { role: 'user', content: 'a diagram and a log', at: '2026-01-01T00:02:00.000Z',
      attachments: [
        { id: 'svg-1', name: 'd.svg', mime: 'image/svg+xml', url: '/a/svg-1' },
        { id: 'img-2', name: 'photo.jpg', mime: 'image/jpeg', url: '/a/img-2' },
        { id: 'txt-1', name: 'server.log', mime: 'text/plain', url: '/a/txt-1' },
      ] },
  ];
  const catalog = buildConversationImageCatalog(messages);
  const ids = catalog.map((e) => e.attachment_id);
  assert.deepEqual(ids, ['img-1', 'img-2'], 'only real raster images kept, in order');
  assert.equal(catalog[0].message_index, 0);
  assert.equal(catalog[1].message_index, 2);
  assert.equal(catalog[0].filename, 'shot.png');
  assert.ok(catalog[1].excerpt.includes('diagram'), 'excerpt from originating message');
  assert.equal(isCatalogEligibleImageMime('image/svg+xml'), false);
  assert.equal(isCatalogEligibleImageMime('image/webp'), true);
  assert.equal(isCatalogEligibleImageMime('text/plain'), false);
});

// 1b. Catalog is bounded to the newest N.
check('catalog is bounded to newest N', () => {
  const many = [];
  for (let i = 0; i < CONVERSATION_IMAGE_CATALOG_MAX + 5; i += 1) {
    many.push({ role: 'user', content: `m${i}`, at: `2026-01-01T00:${String(i).padStart(2, '0')}:00.000Z`,
      attachments: [{ id: `img-${i}`, name: `n${i}.png`, mime: 'image/png', url: `/a/${i}` }] });
  }
  const catalog = buildConversationImageCatalog(many);
  assert.equal(catalog.length, CONVERSATION_IMAGE_CATALOG_MAX);
  assert.equal(catalog[catalog.length - 1].attachment_id, `img-${CONVERSATION_IMAGE_CATALOG_MAX + 4}`, 'keeps newest');
  assert.equal(buildConversationImageCatalog([]).length, 0);
  assert.equal(formatConversationImageCatalogNote([]), '', 'empty catalog → no note');
});

// 2. Note states metadata-not-pixels contract and no heuristic language.
check('catalog note states metadata contract', () => {
  const note = formatConversationImageCatalogNote(buildConversationImageCatalog([
    { role: 'user', content: 'x', at: '2026-01-01T00:00:00.000Z',
      attachments: [{ id: 'img-1', name: 'a.png', mime: 'image/png', url: '/a/1' }] },
  ]));
  assert.ok(note.includes('metadata only'), 'declares metadata-only');
  assert.ok(note.includes('conversation_image_get'), 'names the retrieval tool');
  assert.ok(note.includes('No automatic reattachment'), 'declares no auto reattachment');
  assert.ok(note.includes('keyword matching'), 'declares no keyword matching');
  assert.ok(note.includes('id=img-1'), 'lists the id');
});

// 3. Validation rejects svg, missing, non-image, oversized.
check('validation rejects svg/missing/non-image/oversized', () => {
  assert.equal(validateConversationImage(null).reason, 'missing');
  assert.equal(validateConversationImage({ mime: 'image/svg+xml', size_bytes: 10 }).reason, 'svg_rejected');
  assert.equal(validateConversationImage({ mime: 'text/plain', size_bytes: 10 }).reason, 'not_image');
  assert.equal(validateConversationImage({ mime: 'image/png', size_bytes: 999 }, 100).reason, 'too_large');
  assert.equal(validateConversationImage({ mime: 'image/png', size_bytes: 50 }, 100).ok, true);
});

// 4. Tool registration in catalog + read_only pack + runtime facts.
check('tool registered in definitions, read_only pack, runtime facts', () => {
  assert.ok(CODE_AGENT_TOOL_NAMES.includes('conversation_image_get'), 'in tool definitions');
  const readOnly = getCodeAgentToolsByPack(root, 'read_only').map((t) => t.function.name);
  assert.ok(readOnly.includes('conversation_image_get'), 'in read_only pack');
  const facts = JSON.parse(readFileSync(path.join(root, 'core/config/defaults/agent-runtime-facts.json'), 'utf8'));
  assert.ok(facts.tool_packs.read_only.include.includes('conversation_image_get'), 'in runtime facts read_only');
  assert.ok(!facts.mutating_tools.includes('conversation_image_get'), 'not mutating');
});

// 5. Retrieval + session isolation via executeAgentTool.
await (async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'cqr-image-catalog-'));
  try {
    const svc = new AttachmentService(path.join(tmp, 'data', 'attachments'), tmp, 20 * 1024 * 1024);
    // 1x1 png
    const pngBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    const imgRec = svc.saveFile('sessA', 'shot.png', pngBytes, 'image/png');
    const svgRec = svc.saveFile('sessA', 'diagram.svg', Buffer.from('<svg/>'), 'image/svg+xml');

    const callTool = (attachmentId, sessionId) => executeAgentTool(
      tmp,
      { id: 'call-1', type: 'function', function: { name: 'conversation_image_get', arguments: JSON.stringify({ attachment_id: attachmentId }) } },
      {},
      { cqrRoot: tmp, sessionId },
    );

    const okRes = await callTool(imgRec.id, 'sessA');
    const okOut = JSON.parse(okRes.output);
    assert.equal(okOut.ok, true, 'valid image in same session retrieved');
    assert.equal(okOut.mime, 'image/png');
    assert.ok(typeof okRes.followUpImage === 'string' && okRes.followUpImage.startsWith('data:image/png;base64,'),
      'returns multimodal data URL for the next model step');

    const foreignRes = await callTool(imgRec.id, 'sessB');
    assert.equal(JSON.parse(foreignRes.output).ok, false, 'foreign session cannot retrieve');
    assert.equal(JSON.parse(foreignRes.output).reason, 'missing', 'session isolation enforced');
    assert.equal(foreignRes.followUpImage, undefined, 'no image leaked cross-session');

    const svgRes = await callTool(svgRec.id, 'sessA');
    assert.equal(JSON.parse(svgRes.output).reason, 'svg_rejected', 'svg rejected on retrieval');

    const missingRes = await callTool('does-not-exist', 'sessA');
    assert.equal(JSON.parse(missingRes.output).reason, 'missing', 'missing id rejected');
    pass += 1;
    console.log('ok - retrieval + session isolation via executeAgentTool');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
})();

// 6. Absence of local selection heuristics in the module source.
check('no local selection heuristics in source', () => {
  const src = readFileSync(path.join(root, 'core/src/agent/conversation-image-catalog.ts'), 'utf8');
  for (const banned of ['cosine', 'similarity(', 'searchEmbedding', 'scoreImage', 'relevanceScore']) {
    assert.ok(!src.includes(banned), `source must not implement heuristic: ${banned}`);
  }
});

console.log(JSON.stringify({ ok: true, checks: pass }));
