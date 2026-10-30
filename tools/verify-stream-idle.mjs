// Stream stall detection: a model stream that stops sending bytes is cut and retried.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';

const m = await import('../core/dist/providers/stream-idle.js');
const helpers = await import('../core/dist/agent/agent-run-helpers.js');

assert.equal(m.STREAM_IDLE_TIMEOUT_MS, 120_000);
assert.equal(m.STREAM_FIRST_OUTPUT_IDLE_TIMEOUT_MS, 300_000);
assert.equal(m.resolveStreamIdleTimeoutMs(true, {}), 120_000);
assert.equal(m.resolveStreamIdleTimeoutMs(false, {}), 300_000);
assert.equal(m.resolveStreamIdleTimeoutMs(true, { MY_AGENT_STREAM_IDLE_TIMEOUT_MS: '0' }), 0, '0 disables');
assert.equal(m.resolveStreamIdleTimeoutMs(true, { MY_AGENT_STREAM_IDLE_TIMEOUT_MS: '1000' }), 15_000, 'clamped low');
assert.equal(m.resolveStreamIdleTimeoutMs(false, { MY_AGENT_STREAM_FIRST_OUTPUT_TIMEOUT_MS: '9999999' }), 900_000, 'clamped high');

// Bytes arriving within the window pass through; silence rejects and cancels the stream.
let cancelled = null;
const stream = new ReadableStream({
  start(controller) { controller.enqueue(new Uint8Array([1])); },
  cancel(reason) { cancelled = reason; },
});
const reader = stream.getReader();
const first = await m.readWithIdleTimeout(reader, 200);
assert.equal(first.done, false);
const t0 = Date.now();
await assert.rejects(m.readWithIdleTimeout(reader, 150), (e) => e instanceof m.StreamIdleTimeoutError && /STREAM_IDLE_TIMEOUT/.test(e.message));
assert.ok(Date.now() - t0 < 2_000);
await new Promise((r) => setTimeout(r, 20));
assert.ok(cancelled instanceof m.StreamIdleTimeoutError, 'stalled stream is cancelled');

// The agent step loop retries it like other infra timeouts.
assert.equal(helpers.isOwuiOrGatewayError(new m.StreamIdleTimeoutError(120_000)), true);

// End to end: a Responses stream that sends one event and then hangs is cut by the idle window.
process.env.MY_AGENT_STREAM_IDLE_TIMEOUT_MS = '15000';
process.env.MY_AGENT_STREAM_FIRST_OUTPUT_TIMEOUT_MS = '15000';
const server = http.createServer((req, res) => {
  req.resume();
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'hi' })}\n\n`);
  // never ends
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();
const rc = await import('../core/dist/providers/openai-compatible.js');
const started = Date.now();
await assert.rejects(
  rc.chatCompletionWithTools(`http://127.0.0.1:${port}/v1`, 'k', 'test-model', [{ role: 'user', content: 'x' }], [], {
    wireApi: 'responses', stream: true, timeoutMs: 120_000,
  }, { onContent: () => {}, onThought: () => {} }),
  /STREAM_IDLE_TIMEOUT/,
);
const took = Date.now() - started;
assert.ok(took >= 14_000 && took < 30_000, `cut near the idle window (took ${took}ms)`);
server.closeAllConnections?.();
server.close();

// Wiring: every SSE reader used for agent steps goes through the idle read.
const responses = readFileSync(new URL('../core/src/providers/responses-compatible.ts', import.meta.url), 'utf8');
assert.match(responses, /readWithIdleTimeout\(reader, resolveStreamIdleTimeoutMs\(sawOutput\)\)/);
const openai = readFileSync(new URL('../core/src/providers/openai-compatible.ts', import.meta.url), 'utf8');
assert.equal((openai.match(/readWithIdleTimeout\(reader,/g) ?? []).length, 2);

console.log('verify-stream-idle: ok');
