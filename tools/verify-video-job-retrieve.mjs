#!/usr/bin/env node
/**
 * Video job retrieve (P1): provider job id survives timeout/stop/failed download,
 * and 「결과 다시 받기」 checks + downloads WITHOUT submitting a new (paid) generation.
 * Mocked fetch — no credits spent. Requires a fresh core build (npx tsc -p tsconfig.json).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dist = new URL('../core/dist/', import.meta.url);
const { generateVideo, retrieveVideoJob, VideoJobError } = await import(new URL('video/video-generation.js', dist));
const { loadVideoModelCatalog } = await import(new URL('video/video-models.js', dist));
const { SessionStore } = await import(new URL('sessions/session-store.js', dist));

const model = loadVideoModelCatalog(true).models[0];
const base = 'https://openrouter.ai/api/v1';
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(12), Buffer.from('MP4DATA')]);
const json = (body) => new Response(JSON.stringify(body), { status: 200 });
const root = mkdtempSync(path.join(tmpdir(), 'video-job-'));
const output = (name) => ({ dir: path.join(root, 'out', name), urlPrefix: `/outputs/videos/${name}`, baseName: name, cqrRoot: root });

try {
  // 1. Timeout after submit -> retryable VideoJobError carrying the job id; onSubmitted fired first.
  let submitted = '';
  const err = await generateVideo({
    baseUrl: base, apiKey: 'k', model, prompt: 'p', output: output('t'), pollIntervalMs: 1, timeoutMs: -1,
    onSubmitted: (id) => { submitted = id; },
    fetchImpl: async (u, init = {}) => init.method === 'POST'
      ? json({ id: 'jobT', status: 'pending' })
      : json({ status: 'in_progress' }),
  }).catch((e) => e);
  assert.equal(submitted, 'jobT');
  assert.ok(err instanceof VideoJobError, 'timeout is a VideoJobError');
  assert.equal(err.jobId, 'jobT');
  assert.equal(err.retryable, true);
  assert.match(err.message, /VIDEO_TIMEOUT/);

  // 2. Provider terminal failure -> not retryable.
  const failed = await generateVideo({
    baseUrl: base, apiKey: 'k', model, prompt: 'p', output: output('f'), pollIntervalMs: 1,
    fetchImpl: async () => json({ id: 'jobF', status: 'failed', error: 'moderation' }),
  }).catch((e) => e);
  assert.ok(failed instanceof VideoJobError);
  assert.equal(failed.retryable, false);
  assert.match(failed.message, /VIDEO_JOB_FAILED moderation/);

  // 3. Failed download keeps the id as retryable.
  const dlFail = await generateVideo({
    baseUrl: base, apiKey: 'k', model, prompt: 'p', output: output('d'), pollIntervalMs: 1,
    fetchImpl: async (u, init = {}) => init.method === 'POST'
      ? json({ id: 'jobD', status: 'completed' })
      : new Response('gateway', { status: 502 }),
  }).catch((e) => e);
  assert.ok(dlFail instanceof VideoJobError);
  assert.equal(dlFail.jobId, 'jobD');
  assert.equal(dlFail.retryable, true);

  // 4. retrieveVideoJob: pending -> completed, never POSTs a new generation.
  const calls = [];
  let done = false;
  const retrieveFetch = async (u, init = {}) => {
    calls.push({ url: String(u), method: init.method ?? 'GET', auth: init.headers?.Authorization });
    if (String(u) === `${base}/videos/jobT`) {
      return json(done ? { status: 'completed', unsigned_urls: ['https://cdn.example.com/t.mp4'] } : { status: 'in_progress' });
    }
    if (String(u) === 'https://cdn.example.com/t.mp4') return new Response(MP4, { status: 200 });
    return new Response('unexpected', { status: 500 });
  };
  const pending = await retrieveVideoJob({ baseUrl: base, apiKey: 'k', jobId: 'jobT', output: output('r'), fetchImpl: retrieveFetch });
  assert.equal(pending.state, 'pending');
  assert.equal(pending.status, 'in_progress');
  done = true;
  const got = await retrieveVideoJob({ baseUrl: base, apiKey: 'k', jobId: 'jobT', output: output('r'), fetchImpl: retrieveFetch });
  assert.equal(got.state, 'completed');
  assert.equal(got.media.kind, 'video');
  assert.deepEqual(readFileSync(path.join(root, 'out', 'r', 'r.mp4')), MP4);
  assert.ok(calls.every((c) => c.method !== 'POST'), 'retrieve never submits a new job');
  assert.equal(calls.find((c) => c.url.startsWith('https://cdn.example.com')).auth, undefined, 'no key to CDN');
  const terminal = await retrieveVideoJob({
    baseUrl: base, apiKey: 'k', jobId: 'jobX', output: output('x'),
    fetchImpl: async () => json({ status: 'expired' }),
  }).catch((e) => e);
  assert.ok(terminal instanceof VideoJobError && terminal.retryable === false);

  // 5. Session store: a stop right after submit keeps the job on the stopped reply,
  //    and a later retrieve attaches the video and revives the reply.
  const store = new SessionStore(path.join(root, 'sessions'), root);
  const sid = 'video-job-session';
  store.ensure(sid);
  store.append(sid, { role: 'user', content: '영상', at: new Date().toISOString(), run_id: 'run-1' });
  const now = new Date().toISOString();
  store.notePendingVideoJob(sid, { job_id: 'jobT', provider_id: 'custom@x', model_id: model.id, status: 'pending', submitted_at: now, updated_at: now });
  store.finalizeStoppedRun({ sessionId: sid, runId: 'run-1', partial: '', state: 'stopped' });
  let rec = store.load(sid);
  const stopped = rec.messages.at(-1);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.video_job?.job_id, 'jobT');
  assert.equal(stopped.video_job?.status, 'pending');
  assert.match(stopped.content, /결과 다시 받기/);
  store.updateVideoJob(sid, 'jobT', {
    video_job: { ...stopped.video_job, status: 'completed' },
    content: '동영상 결과를 다시 받았습니다.',
    media: [got.media],
  });
  rec = store.load(sid);
  const revived = rec.messages.at(-1);
  assert.equal(revived.video_job.status, 'completed');
  assert.equal(revived.status, 'completed');
  assert.ok(!revived.model_exclude);
  assert.deepEqual(revived.image_urls, [got.media.url]);
  assert.equal(revived.media[0].kind, 'video');
  assert.equal(store.updateVideoJob(sid, 'nope', { video_job: revived.video_job }), null);

  // 6. Source wiring: route + SSE + UI button.
  const dispatch = readFileSync(new URL('../core/src/routes/dispatch.ts', import.meta.url), 'utf8');
  assert.ok(dispatch.includes('video-jobs') && dispatch.includes('orchestrator.retrieveVideoJob('));
  const orch = readFileSync(new URL('../core/src/chat/chat-orchestrator.ts', import.meta.url), 'utf8');
  assert.match(orch, /type: 'video_job'/);
  const pane = readFileSync(new URL('../ui/workspace/src/components/ChatPane.tsx', import.meta.url), 'utf8');
  assert.match(pane, /결과 다시 받기/);
  console.log('verify-video-job-retrieve: ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
