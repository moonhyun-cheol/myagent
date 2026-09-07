#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../core/dist/sessions/session-store.js';
import {
  beginChatRun,
  cancelChatRun,
  ChatRunConflict,
} from '../core/dist/chat/chat-runs.js';
import { initSse, sseDone, sseEvent } from '../core/dist/chat/sse.js';
import { dispatchApiRequest } from '../core/dist/routes/dispatch.js';

const temp = mkdtempSync(path.join(os.tmpdir(), 'myagent-chat-run-race-'));
const sessionsDir = path.join(temp, 'sessions');
mkdirSync(sessionsDir, { recursive: true });
const store = new SessionStore(sessionsDir, temp);
const sessionId = 'race-session';
store.ensure(sessionId);

let releaseA;
const aGate = new Promise((resolve) => { releaseA = resolve; });
let aSignal;
let aStartedResolve;
const aStarted = new Promise((resolve) => { aStartedResolve = resolve; });
let lateWriteBlocked = false;

const license = {
  assertWritable() {},
  assertFeature() {},
};
const orchestrator = {
  async handleStream(req, sid, res, signal) {
    initSse(res);
    store.append(sid, { role: 'user', content: req.message, at: new Date().toISOString() });
    if (req.message === 'A') {
      aSignal = signal;
      sseEvent(res, { type: 'token', text: 'A-partial' });
      aStartedResolve();
      await aGate;
      try {
        store.append(sid, { role: 'assistant', content: 'A-late', at: new Date().toISOString() });
      } catch (error) {
        lateWriteBlocked = error?.name === 'AbortError';
      }
      sseEvent(res, { type: 'token', text: 'A-late-event' });
      sseEvent(res, { type: 'done', model: 'mock-a', mode: 'chat' });
      sseDone(res);
      return;
    }
    store.append(sid, { role: 'assistant', content: 'B-answer', at: new Date().toISOString() });
    sseEvent(res, { type: 'token', text: 'B-answer' });
    sseEvent(res, { type: 'done', model: 'mock-b', mode: 'chat' });
    sseDone(res);
  },
};

const ctx = {
  cqrRoot: temp,
  paths: {},
  port: 0,
  appVersion: 'test',
  workspaceUiDir: null,
  workKitLauncherUiDir: null,
  userConfigPath: path.join(temp, 'user-overrides.json'),
  imageOut: path.join(temp, 'images'),
  getOverrides: () => ({}),
  license,
  orchestrator,
  sessionStore: store,
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    await dispatchApiRequest(ctx, req, res, url, req.method ?? 'GET');
  } catch (error) {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    if (!res.writableEnded) res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined }));
  }
});

const listen = () => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve());
});
const close = () => new Promise((resolve) => server.close(() => resolve()));
const post = (base, pathname, runId, message, signal) => fetch(`${base}${pathname}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-cqr-session': sessionId },
  body: JSON.stringify(message === undefined ? { runId } : { runId, message }),
  signal,
});

try {
  // Cancel-before-start is a permanent tombstone: a delayed request cannot revive it.
  assert.equal(cancelChatRun('overtake-session', 'run-overtaken'), 'stopped');
  assert.throws(
    () => beginChatRun('overtake-session', 'run-overtaken'),
    (error) => error instanceof ChatRunConflict && error.code === 'CHAT_RUN_ALREADY_USED',
  );

  await listen();
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  const abortA = new AbortController();
  const aResponsePromise = post(base, '/chat/stream', 'run-a', 'A', abortA.signal);
  const aResponse = await aResponsePromise;
  if (aResponse.status !== 200) {
    throw new Error(`A stream failed (${aResponse.status}): ${await aResponse.text()}`);
  }
  await aStarted;

  // Closing the response transport must reach the server's run signal.
  abortA.abort();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(aSignal?.aborted, true, 'response close did not abort server run');

  const cancelling = await post(base, '/chat/cancel', 'run-a');
  assert.equal(cancelling.status, 200);
  assert.equal((await cancelling.json()).state, 'cancelling');

  // A second run cannot enter while A is still unwinding/persisting its stopped record.
  const busy = await post(base, '/chat/stream', 'run-b-busy', 'B');
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).error, 'CHAT_RUN_BUSY');

  releaseA();
  for (let i = 0; i < 40; i += 1) {
    const status = await post(base, '/chat/cancel', 'run-a');
    const doc = await status.json();
    if (doc.state === 'stopped') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const stopped = await post(base, '/chat/cancel', 'run-a');
  assert.equal((await stopped.json()).state, 'stopped');
  assert.equal(lateWriteBlocked, true, 'late assistant persistence was not rejected');

  const bResponse = await post(base, '/chat/stream', 'run-b', 'B');
  assert.equal(bResponse.status, 200);
  const bBody = await bResponse.text();
  assert.match(bBody, /"runId":"run-b"/);
  assert.match(bBody, /B-answer/);

  const messages = store.load(sessionId)?.messages ?? [];
  assert.equal(messages.some((message) => message.content === 'A-late'), false);
  assert.equal(messages.some((message) => message.content === 'A-late-event'), false);
  const stoppedReply = messages.find((message) => message.role === 'assistant' && message.run_id === 'run-a');
  assert.ok(stoppedReply);
  assert.equal(stoppedReply.status, 'stopped');
  assert.equal(stoppedReply.model_exclude, true);
  const bReplies = messages.filter((message) => message.role === 'assistant' && message.run_id === 'run-b');
  assert.equal(bReplies.length, 1, 'follow-up run was persisted more than once');
  const bReply = bReplies[0];
  assert.equal(bReply?.content, 'B-answer');
  assert.equal(bReply?.status, 'completed');

  console.log('chat run race: PASS');
} finally {
  releaseA?.();
  if (server.listening) await close();
  rmSync(temp, { recursive: true, force: true });
}
