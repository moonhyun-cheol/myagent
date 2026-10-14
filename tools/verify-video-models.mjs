#!/usr/bin/env node
/**
 * Video models: core-owned catalog, organization-module gate, picker projection,
 * OpenRouter async job client (mocked fetch — no credits spent).
 * Requires a fresh core build (npx tsc -p tsconfig.json).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dist = new URL('../core/dist/', import.meta.url);
const { loadVideoModelCatalog, findVideoModel, availableVideoModels, hasOrganizationVideoAccess } =
  await import(new URL('video/video-models.js', dist));
const { generateVideo } = await import(new URL('video/video-generation.js', dist));
const { buildModelPicker } = await import(new URL('models/model-picker.js', dist));

// 1. Catalog is core-owned and contains veo + seedance.
const catalog = loadVideoModelCatalog(true);
const ids = catalog.models.map((m) => m.id);
assert.ok(ids.some((id) => id.startsWith('google/veo-')), 'catalog has veo');
assert.ok(ids.some((id) => id.startsWith('bytedance/seedance-')), 'catalog has seedance');
assert.equal(findVideoModel('openai/gpt-5.6-sol'), null);
assert.ok(findVideoModel(ids[0]));

// 2. Gate: no organization module → hidden; installed module.json → visible.
const root = mkdtempSync(path.join(tmpdir(), 'video-gate-'));
try {
  assert.equal(hasOrganizationVideoAccess(root), false);
  assert.deepEqual(availableVideoModels(root), []);
  const orgDir = path.join(root, 'modules', 'organization');
  mkdirSync(orgDir, { recursive: true });
  writeFileSync(path.join(orgDir, 'module.json'), JSON.stringify({
    id: 'test-org', kind: 'organization-module', version: '1.0.0', update_sequence: 1,
    install_root: 'modules/organization', required_core_api: '1.0.0', capabilities: [],
  }));
  assert.equal(hasOrganizationVideoAccess(root), true);
  assert.equal(availableVideoModels(root).length, catalog.models.length);
} finally {
  rmSync(root, { recursive: true, force: true });
}

// 3. Picker: video models are search-only. They never auto-list; they join the searchable
//    catalog (org-filtered) and reach the picker only once selected in MY Models.
const fakeStore = {
  listDefinitions: () => [{ id: 'custom', name: 'OpenRouter', custom: true, base_url: 'https://openrouter.ai/api/v1' }],
  getConfiguredIds: () => ['custom'],
  getDefaultId: () => 'custom',
  getSecret: () => ({ api_key: 'k', base_url: 'https://openrouter.ai/api/v1' }),
  getDefinition: () => ({ id: 'custom', name: 'OpenRouter', custom: true, base_url: 'https://openrouter.ai/api/v1' }),
};
const registry = { load: () => ({ models: [], default_llm_id: null }) };
const without = await buildModelPicker(registry, {}, fakeStore, {});
assert.ok(!without.options.some((o) => o.category === 'video'), 'no video without org');
assert.equal(without.company_models?.video, undefined, 'no video ids without org');
const withVideo = await buildModelPicker(registry, {}, fakeStore, { videoModels: catalog.models });
assert.ok(!withVideo.options.some((o) => o.category === 'video'), 'video not auto-listed in picker');
assert.deepEqual(withVideo.company_models?.video, catalog.models.map((m) => m.id), 'video ids exposed for search');
const picked = await buildModelPicker(
  registry,
  { company_model_ids: ['openai/gpt-5.6-sol', catalog.models[0].id] },
  fakeStore,
  { videoModels: catalog.models },
);
const videoOpts = picked.options.filter((o) => o.category === 'video');
assert.equal(videoOpts.length, 1, 'selected video model appears in picker');
assert.equal(videoOpts[0].label, catalog.models[0].label);
assert.ok(videoOpts[0].value.startsWith('provider:custom@'));

// 4. Job client: submit → poll → download; key never sent to a foreign host.
const outRoot = mkdtempSync(path.join(tmpdir(), 'video-out-'));
const output = { dir: path.join(outRoot, 's1'), urlPrefix: '/outputs/videos/s1', baseName: 'v', cqrRoot: outRoot };
// Minimal ISO-BMFF head (`ftyp isom`) so the signature check accepts it as MP4.
const MP4_BYTES = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(12), Buffer.from('MP4DATA')]);
const calls = [];
let polls = 0;
const fakeFetch = async (url, init = {}) => {
  const u = String(url);
  calls.push({ url: u, auth: init.headers?.Authorization });
  const json = (body) => new Response(JSON.stringify(body), { status: 200 });
  if (u.endsWith('/videos') && init.method === 'POST') {
    const body = JSON.parse(init.body);
    assert.equal(body.model, catalog.models[0].id);
    assert.equal(body.duration, catalog.models[0].duration);
    return json({ id: 'job1', status: 'pending', polling_url: '/api/v1/videos/job1' });
  }
  if (u === 'https://openrouter.ai/api/v1/videos/job1') {
    polls += 1;
    return json(polls < 2
      ? { status: 'in_progress' }
      : { status: 'completed', unsigned_urls: ['https://cdn.example.com/job1.mp4'] });
  }
  if (u === 'https://cdn.example.com/job1.mp4') return new Response(MP4_BYTES, { status: 200 });
  return new Response('unexpected', { status: 500 });
};
const statuses = [];
const result = await generateVideo({
  baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'secret', model: catalog.models[0], prompt: 'test',
  output, pollIntervalMs: 1, fetchImpl: fakeFetch, onStatus: (t) => statuses.push(t),
});
assert.equal(result.jobId, 'job1');
assert.equal(result.media.kind, 'video');
assert.equal(result.media.mime, 'video/mp4');
assert.equal(result.media.url, '/outputs/videos/s1/v.mp4');
assert.equal(result.media.bytes, MP4_BYTES.length);
assert.match(result.media.sha256, /^[0-9a-f]{64}$/);
assert.deepEqual(readFileSync(path.join(outRoot, 's1', 'v.mp4')), MP4_BYTES);
assert.equal(calls.find((c) => c.url.startsWith('https://cdn.example.com')).auth, undefined, 'no key to CDN');
assert.ok(calls.filter((c) => c.url.startsWith('https://openrouter.ai')).every((c) => c.auth === 'Bearer secret'));
assert.ok(statuses.length >= 2);

// 4b. Download validation: HTML error page / oversize body are rejected and leave no file behind.
const completedJob = (body, headers) => async (u, init = {}) => {
  if (init.method === 'POST') return new Response(JSON.stringify({ id: 'j2', status: 'completed' }), { status: 200 });
  return new Response(body, { status: 200, headers });
};
const badOutput = { ...output, dir: path.join(outRoot, 'bad'), urlPrefix: '/outputs/videos/bad' };
await assert.rejects(
  generateVideo({
    baseUrl: 'https://openrouter.ai/api/v1', apiKey: 's', model: catalog.models[0], prompt: 'x',
    output: badOutput, pollIntervalMs: 1, fetchImpl: completedJob('<html>expired</html>'),
  }),
  /VIDEO_DOWNLOAD_FAILED MEDIA_UNSUPPORTED_FORMAT/,
);
await assert.rejects(
  generateVideo({
    baseUrl: 'https://openrouter.ai/api/v1', apiKey: 's', model: catalog.models[0], prompt: 'x',
    output: { ...badOutput, maxBytes: 10 }, pollIntervalMs: 1, fetchImpl: completedJob(MP4_BYTES),
  }),
  /VIDEO_DOWNLOAD_FAILED MEDIA_TOO_LARGE/,
);
await assert.rejects(
  generateVideo({
    baseUrl: 'https://openrouter.ai/api/v1', apiKey: 's', model: catalog.models[0], prompt: 'x',
    output: badOutput, pollIntervalMs: 1, fetchImpl: completedJob(new Uint8Array(0)),
  }),
  /VIDEO_DOWNLOAD_FAILED MEDIA_EMPTY/,
);
assert.deepEqual(existsSync(badOutput.dir) ? readdirSync(badOutput.dir) : [], [], 'no partial files left');

// 5. Failed job surfaces an error (no silent fallback).
await assert.rejects(
  generateVideo({
    baseUrl: 'https://openrouter.ai/api/v1', apiKey: 's', model: catalog.models[0], prompt: 'x',
    output, pollIntervalMs: 1,
    fetchImpl: async (u, init = {}) => init.method === 'POST'
      ? new Response(JSON.stringify({ id: 'j', status: 'failed', error: 'moderation' }), { status: 200 })
      : new Response('', { status: 500 }),
  }),
  /VIDEO_JOB_FAILED moderation/,
);

// 6. Source wiring: server gate + stream branch + served route.
const orch = readFileSync(new URL('../core/src/chat/chat-orchestrator.ts', import.meta.url), 'utf8');
assert.match(orch, /requestedVideoModel\(req, sessionId\)/);
assert.match(orch, /findVideoModel\(resolved\.route\.modelId\)/);
const mode = readFileSync(new URL('../core/src/chat/modes/video-gen.ts', import.meta.url), 'utf8');
assert.match(mode, /if \(!hasOrganizationVideoAccess\(cqrRoot\)\)/);
const dispatch = readFileSync(new URL('../core/src/routes/dispatch.ts', import.meta.url), 'utf8');
assert.match(dispatch, /videoModels: availableVideoModels\(cqrRoot\)/);
assert.match(dispatch, /\\\/outputs\\\/videos\\\//);
assert.ok(existsSync(new URL('../core/config/defaults/video-models.json', import.meta.url)));

console.log('verify-video-models: ok');
