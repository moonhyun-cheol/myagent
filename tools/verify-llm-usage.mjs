import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const temp = mkdtempSync(path.join(root, 'data', 'verify-llm-usage-'));
const env = { ...process.env };
let server;
let passed = 0;
try {
  process.env.MY_AGENT_LLM_LOG = 'off';
  process.env.MY_AGENT_LLM_USAGE_LOG_DIR = path.join(temp, 'usage');
  delete process.env.MY_AGENT_LLM_USAGE_LOG;
  const build = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(root, 'tsconfig.json'), '--outDir', path.join(temp, 'compiled'), '--declaration', 'false'], { cwd: root, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  console.log('PASS core TypeScript (isolated output)');
  const load = name => import(pathToFileURL(path.join(temp, 'compiled/providers', name + '.js')));
  const { fetchWithUsage, withLlmUsageContext } = await load('llm-usage-log');
  const chat = await load('openai-compatible');
  const responses = await load('responses-compatible');
  const messages = await load('anthropic-messages');
  let reply = {};
  const received = [];
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(reply.status ?? 200, { 'content-type': reply.frames ? 'text/event-stream' : 'application/json', ...reply.headers });
    const data = reply.frames ?? reply.raw ?? JSON.stringify(reply.doc ?? {});
    if (reply.cut) { res.write(data); setTimeout(() => res.destroy(), 20); }
    else if (reply.split) { for (const byte of Buffer.from(data)) res.write(Buffer.from([byte])); res.end(); }
    else res.end(data);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const key = 'sk-secret-PRIVATE_KEY_SENTINEL';
  const input = [{ role: 'user', content: 'PRIVATE_PROMPT_SENTINEL' }];
  const rows = () => readdirSync(process.env.MY_AGENT_LLM_USAGE_LOG_DIR).flatMap(file => readFileSync(path.join(process.env.MY_AGENT_LLM_USAGE_LOG_DIR, file), 'utf8').trim().split('\n').map(JSON.parse));
  const finished = () => rows().filter(row => row.event === 'finish');
  const last = () => finished().at(-1);
  const test = async (name, work) => { reply = {}; await work(); passed++; console.log('PASS ' + name); };
  const frame = doc => 'data: ' + JSON.stringify(doc) + '\r\n\r\n';
  const direct = async (doc, wire = 'chat/completions', opts = {}) => {
    reply.doc = doc;
    const res = await fetchWithUsage(`${base}/${wire}`, { method: 'POST', body: JSON.stringify({ model: 'model', ...opts }), headers: { authorization: key } });
    await res.text();
  };
  await test('Chat JSON real provider entry; raw nested usage', async () => {
    reply.doc = { model: 'model', choices: [{ message: { content: 'PRIVATE_REPLY_SENTINEL' } }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 5 } } };
    await chat.chatCompletion(base, key, 'model', input);
    assert.equal(last().input_tokens, 100); assert.equal(last().cached_tokens, 60); assert.equal(last().reasoning_tokens, 5);
  });
  await test('Responses JSON real entry and no state mutation by logger', async () => {
    reply.doc = { id: 'resp_1', status: 'completed', output_text: 'answer', usage: { input_tokens: 80, output_tokens: 12, input_tokens_details: { cached_tokens: 30 }, output_tokens_details: { reasoning_tokens: 3 } } };
    await responses.responsesCompletion(base, key, 'model', input);
    assert.equal(last().wire_api, 'responses'); assert.equal(last().input_tokens, 80); assert.equal(last().reasoning_tokens, 3);
  });
  await test('OpenRouter session pin: hashed, host-scoped, opt-out; upstream provider + billed cost logged', async () => {
    const pin = responses.resolveResponsesSessionPin('https://openrouter.ai/api/v1', 'session_PRIVATE');
    assert.match(pin, /^myagent-[0-9a-f]{32}$/); assert.ok(!pin.includes('session_PRIVATE'));
    assert.equal(responses.resolveResponsesSessionPin('https://openrouter.ai/api/v1', 'session_PRIVATE'), pin);
    assert.equal(responses.resolveResponsesSessionPin(base, 'session_PRIVATE'), undefined);
    assert.equal(responses.resolveResponsesSessionPin('https://openrouter.ai/api/v1', ''), undefined);
    process.env.MY_AGENT_RESPONSES_SESSION_PIN = '0';
    assert.equal(responses.resolveResponsesSessionPin('https://openrouter.ai/api/v1', 'session_PRIVATE'), undefined);
    delete process.env.MY_AGENT_RESPONSES_SESSION_PIN;
    reply.doc = { provider: 'Google Vertex', usage: { input_tokens: 100, output_tokens: 2, cost: 0.0012, input_tokens_details: { cached_tokens: 90, cache_discount: 0.0003 } } };
    const res = await fetchWithUsage(`${base}/responses`, { method: 'POST', body: '{"model":"model"}', headers: { 'x-session-id': pin } });
    await res.text();
    assert.equal(last().session_pinned, true); assert.equal(last().upstream_provider, 'Google Vertex');
    assert.equal(last().provider_cost_usd, 0.0012); assert.equal(last().cache_discount_usd, 0.0003);
    assert.ok(!JSON.stringify(last()).includes(pin));
    await direct({ usage: { input_tokens: 1, output_tokens: 1 } });
    assert.equal(last().session_pinned, false); assert.equal(last().upstream_provider, null);
  });
  await test('Anthropic real entry; cache-inclusive total and raw semantics', async () => {
    reply.doc = { model: 'model', content: [{ type: 'text', text: 'answer' }], usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 50, cache_creation_input_tokens: 20 } };
    await messages.messagesCompletion(base, key, 'model', input);
    assert.equal(last().input_tokens, 10); assert.equal(last().total_input_tokens, 80); assert.equal(last().input_semantics, 'excludes_cache');
  });
  await test('Chat SSE usage-only frame after content; exact byte pass-through', async () => {
    reply.frames = frame({ choices: [{ delta: { content: '한글' } }] }) + frame({ usage: { prompt_tokens: 100, completion_tokens: 7 }, choices: [] }) + 'data: [DONE]\n\n';
    reply.split = true;
    let text = '';
    await chat.chatCompletionStream(base, key, 'model', input, chunk => { text += chunk; });
    assert.equal(text, '한글'); assert.equal(last().output_tokens, 7); assert.equal(last().outcome, 'completed');
    assert.deepEqual(received.at(-1).stream_options, { include_usage: true });
  });
  await test('Responses SSE terminal usage through real adapter', async () => {
    reply.frames = frame({ type: 'response.output_text.delta', delta: 'answer' }) + frame({ type: 'response.completed', response: { id: 'resp_2', status: 'completed', output_text: 'answer', usage: { input_tokens: 42, output_tokens: 8 } } });
    await responses.responsesCompletionStream(base, key, 'model', input, () => {});
    assert.equal(last().input_tokens, 42); assert.equal(last().outcome, 'completed');
  });
  await test('Anthropic SSE snapshot merge, never double-add', async () => {
    reply.frames = frame({ type: 'message_start', message: { model: 'model', usage: { input_tokens: 11, output_tokens: 0, cache_read_input_tokens: 20, cache_creation_input_tokens: 0 } } }) + frame({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } }) + frame({ type: 'message_delta', usage: { output_tokens: 9 } }) + frame({ type: 'message_delta', usage: { output_tokens: 9 } }) + frame({ type: 'message_stop' });
    await messages.messagesCompletionStream(base, key, 'model', input, () => {});
    assert.equal(last().output_tokens, 9); assert.equal(last().total_input_tokens, 31);
  });
  await test('zero tokens distinct from unavailable', async () => {
    await direct({ usage: { input_tokens: 0, output_tokens: 0 } });
    assert.equal(last().usage_status, 'reported'); assert.equal(last().input_tokens, 0);
    await direct({}); assert.equal(last().usage_status, 'unavailable'); assert.equal(last().input_tokens, null);
  });
  await test('partial and invalid counters are not fabricated', async () => {
    await direct({ usage: { input_tokens: 10, output_tokens: -1, cached_tokens: 3.5, reasoning_tokens: '7' } });
    assert.equal(last().usage_status, 'partial'); assert.equal(last().output_tokens, null); assert.equal(last().reasoning_tokens, null);
    await direct({ usage: { input_tokens: 10, output_tokens: 2 } }, 'messages'); assert.equal(last().total_input_tokens, null);
  });
  await test('HTTP 400 recorded even before error body is consumed', async () => {
    reply.status = 400; reply.doc = { error: { message: 'PRIVATE_ERROR_SENTINEL' } };
    const res = await fetchWithUsage(`${base}/responses`, { method: 'POST', body: JSON.stringify({ model: 'model' }) });
    assert.equal(last().http_status, 400); assert.equal(last().usage_status, 'unavailable'); await res.text();
  });
  await test('every Chat retry gets separate start/finish UUID and attempt', async () => {
    reply.status = 503; reply.doc = { error: { message: 'failed' } };
    const before = finished().length;
    await assert.rejects(chat.chatCompletion(base, key, 'model', input));
    const calls = finished().slice(before);
    assert.equal(calls.length, 3); assert.deepEqual(calls.map(row => row.attempt), [1, 2, 3]); assert.equal(new Set(calls.map(row => row.call_id)).size, 3);
  });
  await test('402 retains request limits and safe nested reason; bytes and single finish preserved', async () => {
    reply.status = 402;
    reply.headers = { 'x-request-id': 'req_402' };
    reply.doc = { error: { code: 402, message: 'Provider returned error PRIVATE_ERROR_SENTINEL', metadata: {
      provider_name: 'Anthropic', raw: JSON.stringify({ error: { code: 'insufficient_credits', message: key + ' PRIVATE_PROMPT_SENTINEL' } }),
    } } };
    const request = { model: 'model', stream: true, max_output_tokens: 16000, max_tokens: -1, max_completion_tokens: 'bad' };
    const before = finished().length;
    const res = await fetchWithUsage(`${base}/responses?api_key=PRIVATE_URL_SENTINEL`, { method: 'POST', body: JSON.stringify(request) });
    const finish = last();
    assert.equal(finish.error_diagnostics.reason, 'payment_required_unspecified');
    assert.equal(finish.error_diagnostics.request_id, 'req_402');
    assert.equal(finish.max_output_tokens, 16000); assert.equal(finish.max_tokens, null); assert.equal(finish.max_completion_tokens, null);
    assert.equal(finish.endpoint_host, new URL(base).host);
    assert.equal(await res.text(), JSON.stringify(reply.doc));
    assert.deepEqual(received.at(-1), request);
    const detail = rows().filter(row => row.event === 'http_error_detail').at(-1);
    assert.equal(detail.call_id, finish.call_id); assert.equal(detail.error_observation, 'parsed');
    assert.equal(detail.error_diagnostics.reason, 'insufficient_credits');
    assert.equal(detail.error_diagnostics.upstream_provider, 'Anthropic');
    assert.equal(detail.error_diagnostics.upstream_code, 'insufficient_credits');
    assert.equal(finished().length, before + 1);
  });
  await test('real Responses 402 exposes safe reason without automatic retry', async () => {
    reply.status = 402;
    reply.doc = { error: { code: 402, message: 'This request requires more credits or fewer max_tokens. You can only afford 100 tokens. PRIVATE_ERROR_SENTINEL ' + key } };
    const before = received.length;
    await assert.rejects(responses.responsesCompletion(base, key, 'model', input), error => {
      assert.match(error.message, /RESPONSES_HTTP_402/);
      assert.match(error.message, /request_cost_exceeds_balance/);
      assert.ok(!error.message.includes(key)); assert.ok(!error.message.includes('PRIVATE_ERROR_SENTINEL'));
      return true;
    });
    assert.equal(received.length, before + 1);
    assert.equal(rows().filter(row => row.event === 'http_error_detail').at(-1).error_diagnostics.reason, 'request_cost_exceeds_balance');
  });
  await test('billing classifications do not guess missing facts; nested object and malformed data safe', async () => {
    const { providerErrorDiagnostics: diagnose } = await load('provider-error-diagnostics');
    const http = { status: 402, headers: new Headers() };
    for (const [message, expected] of [
      ['Insufficient credits', 'insufficient_credits'], ['Key spending limit exceeded', 'spending_limit'],
      ['Monthly budget limit reached', 'spending_limit'], ['Payment required', 'payment_required'],
      ['Provider returned error', 'payment_required_unspecified'],
    ]) assert.equal(diagnose({ error: { message } }, http).reason, expected);
    assert.equal(diagnose({ error: { metadata: { raw: { error: { code: 'credit_limit_reached' } } } } }, http).reason, 'spending_limit');
    assert.equal(diagnose({ error: { metadata: { raw: 'Insufficient credits PRIVATE_ERROR_SENTINEL' } } }, http).reason, 'insufficient_credits');
    assert.equal(diagnose({ error: 'Insufficient credits' }, http).reason, 'insufficient_credits');
    for (const raw of [null, [], 'not-json', 'x'.repeat(32769)])
      assert.equal(diagnose({ error: { metadata: { raw } } }, http).reason, 'payment_required_unspecified');
    assert.equal(diagnose(null, http).reason, 'payment_required_unspecified');
    assert.equal(diagnose({ error: { code: 402 } }).reason, 'payment_required_unspecified');
    assert.equal(diagnose({ error: { message: 'maximum context length exceeded' } }).reason, 'context_length');
    assert.equal(diagnose({ error: { code: key, metadata: { provider_name: 'Bearer secret' } } }, http).code, undefined);
    assert.equal(diagnose({ error: { metadata: { provider_name: 'Bearer secret' } } }, http).upstream_provider, undefined);
  });
  await test('bounded non-JSON and oversized HTTP error detail never changes body delivery', async () => {
    reply.status = 402; reply.raw = '<html>PRIVATE_HTML_SENTINEL</html>';
    const res = await fetchWithUsage(`${base}/responses`, { method: 'POST', body: '{}' });
    assert.equal(await res.text(), reply.raw);
    assert.equal(rows().at(-1).error_observation, 'invalid_json');
    reply.raw = 'x'.repeat(32769);
    const large = await fetchWithUsage(`${base}/responses`, { method: 'POST', body: '{}' });
    assert.equal(await large.text(), reply.raw);
    assert.equal(rows().at(-1).error_observation, 'truncated'); assert.equal(rows().at(-1).observation_truncated, true);
  });
  await test('unconsumed HTTP error still settles; cancellation produces bounded detail', async () => {
    reply.status = 402; reply.doc = { error: { message: 'insufficient credits' } };
    const res = await fetchWithUsage(`${base}/responses`, { method: 'POST', body: '{}' });
    const callId = last().call_id;
    assert.equal(rows().filter(row => row.call_id === callId && row.event === 'http_error_detail').length, 0);
    await res.body.cancel();
    assert.equal(rows().at(-1).error_observation, 'cancelled');
    assert.equal(finished().filter(row => row.call_id === callId).length, 1);
  });
  await test('HTTP 200 SSE nested provider failure retains billing reason', async () => {
    reply.frames = frame({ type: 'response.failed', response: { error: { code: 402, message: 'Insufficient credits PRIVATE_ERROR_SENTINEL' } } });
    await assert.rejects(responses.responsesCompletionStream(base, key, 'model', input, () => {}));
    assert.equal(last().outcome, 'provider_error');
    assert.equal(last().error_diagnostics.reason, 'insufficient_credits');
  });
  await test('SSE provider failure preserves reported partial usage', async () => {
    reply.frames = frame({ type: 'response.incomplete', response: { status: 'incomplete', usage: { input_tokens: 40, output_tokens: 5 } } });
    await assert.rejects(responses.responsesCompletionStream(base, key, 'model', input, () => {}));
    assert.equal(last().outcome, 'provider_error'); assert.equal(last().output_tokens, 5);
  });
  await test('SSE missing terminal and malformed JSON are distinct', async () => {
    reply.frames = frame({ usage: { prompt_tokens: 3 }, choices: [] });
    const res = await fetchWithUsage(`${base}/chat/completions`, { method: 'POST', body: '{"stream":true}' }); await res.text();
    assert.equal(last().outcome, 'incomplete');
    reply.frames = undefined; reply.raw = '<html>PRIVATE_HTML_SENTINEL</html>';
    const bad = await fetchWithUsage(`${base}/responses`, { method: 'POST', body: '{}' }); await bad.text(); assert.equal(last().outcome, 'invalid_response');
  });
  await test('read failure and caller cancellation produce one finish', async () => {
    reply.frames = frame({ usage: { input_tokens: 5 }, type: 'response.created' }); reply.cut = true;
    const before = finished().length;
    const res = await fetchWithUsage(`${base}/responses`, { method: 'POST', body: '{"stream":true}' }); await assert.rejects(res.text());
    assert.equal(last().outcome, 'read_error'); assert.equal(finished().length, before + 1);
    reply.cut = false;
    const canceled = await fetchWithUsage(`${base}/responses`, { method: 'POST', body: '{"stream":true}' }); await canceled.body.cancel(); assert.equal(last().outcome, 'cancelled');
  });
  await test('aborted and network failure do not vanish', async () => {
    const abort = new AbortController(); abort.abort();
    await assert.rejects(fetchWithUsage(`${base}/responses`, { method: 'POST', body: '{}', signal: abort.signal })); assert.equal(last().outcome, 'aborted');
    await assert.rejects(fetchWithUsage('http://127.0.0.1:1/responses', { method: 'POST', body: '{}' })); assert.equal(last().outcome, 'network_error');
  });
  await test('concurrent context isolation + linkage to session/run/step', async () => {
    reply.doc = { usage: { input_tokens: 1, output_tokens: 1 } };
    const before = finished().length;
    await Promise.all(['session_A', 'session_B'].map((sessionId, i) => withLlmUsageContext({ sessionId, runId: 'run_' + i, providerId: 'provider', step: () => i + 1 }, async () => { await new Promise(resolve => setTimeout(resolve, i * 5)); await direct(reply.doc); })));
    const calls = finished().slice(before).sort((a, b) => a.step - b.step);
    assert.deepEqual(calls.map(row => [row.session_id, row.run_id, row.step]), [['session_A', 'run_0', 1], ['session_B', 'run_1', 2]]);
  });
  await test('bounded oversized observation preserves output bytes', async () => {
    reply.raw = JSON.stringify({ text: 'x'.repeat(8_388_609), usage: { input_tokens: 1, output_tokens: 1 } });
    const res = await fetchWithUsage(`${base}/responses`, { method: 'POST', body: '{}' }); assert.equal((await res.text()).length, reply.raw.length);
    assert.equal(last().observation_truncated, true); assert.equal(last().usage_status, 'unavailable');
  });
  await test('multiline SSE, EOF frame, UTF8, and oversized SSE observation', async () => {
    reply.frames = 'data: {"usage":\r\ndata: {"prompt_tokens":12,"completion_tokens":3}}\r\n\r\ndata: [DONE]';
    reply.split = true;
    const res = await fetchWithUsage(`${base}/chat/completions`, { method: 'POST', body: '{"stream":true}' });
    assert.equal(await res.text(), reply.frames); assert.equal(last().input_tokens, 12); assert.equal(last().outcome, 'completed');
    reply.split = false;
    reply.frames = frame({ content: 'x'.repeat(1_048_577) }) + frame({ usage: { prompt_tokens: 9, completion_tokens: 2 } }) + 'data: [DONE]\n\n';
    const large = await fetchWithUsage(`${base}/chat/completions`, { method: 'POST', body: '{"stream":true}' });
    assert.equal(await large.text(), reply.frames); assert.equal(last().observation_truncated, true); assert.equal(last().input_tokens, 9);
    assert.equal(last().outcome, 'completed');
  });
  await test('summary filters, unknown coverage, duplicates, and crash-start detection', async () => {
    const { summarizeUsage } = await import(pathToFileURL(path.join(root, 'tools/summarize-llm-usage.mjs')));
    const file = path.join(temp, 'summary-fixture.jsonl');
    const start = { version: 1, call_id: 'one', event: 'start', session_id: 'session' };
    const end = { ...start, event: 'finish', outcome: 'completed', model: 'model', wire_api: 'responses', input_semantics: 'includes_cache', usage_status: 'reported', input_tokens: 10, total_input_tokens: 10, output_tokens: 3, cached_tokens: 5 };
    writeFileSync(file, [start, end, end, { ...start, call_id: 'crashed' }, { ...end, call_id: 'failed', input_tokens: null, total_input_tokens: null, output_tokens: null, cached_tokens: null, outcome: 'http_error', usage_status: 'unavailable' }, { ...end, call_id: 'other', session_id: 'other' }].map(JSON.stringify).join('\n') + '\n{broken');
    const result = await summarizeUsage([file], { session: 'session' });
    assert.equal(result.completed_attempt_records, 2); assert.equal(result.starts_without_finish, 1); assert.equal(result.invalid_lines, 1);
    const group = result.groups[0]; assert.equal(group.calls, 2); assert.equal(group.counters.input_tokens.known_sum, 10); assert.equal(group.counters.input_tokens.unknown_calls, 1); assert.equal(group.cache_read_ratio, 0.5); assert.equal(group.cache_ratio_calls, 1);
    const cli = spawnSync(process.execPath, [path.join(root, 'tools/summarize-llm-usage.mjs'), '--dir', process.env.MY_AGENT_LLM_USAGE_LOG_DIR, '--session', 'session_A'], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).completed_attempt_records, 1);
  });
  await test('exact one start + finish for every settled attempt; privacy allowlist', async () => {
    const all = rows(); const starts = all.filter(row => row.event === 'start'); const ends = finished();
    assert.equal(starts.length, ends.length);
    for (const row of starts) assert.equal(ends.filter(end => end.call_id === row.call_id).length, 1);
    const text = JSON.stringify(all);
    for (const sentinel of ['PRIVATE_KEY_SENTINEL', 'PRIVATE_PROMPT_SENTINEL', 'PRIVATE_REPLY_SENTINEL', 'PRIVATE_ERROR_SENTINEL', 'PRIVATE_HTML_SENTINEL', 'PRIVATE_URL_SENTINEL', base]) assert.ok(!text.includes(sentinel), sentinel);
  });
  await test('logging I/O failure never changes completion', async () => {
    const blocker = path.join(temp, 'file-not-directory'); writeFileSync(blocker, 'x'); process.env.MY_AGENT_LLM_USAGE_LOG_DIR = blocker;
    reply.doc = { choices: [{ message: { content: 'answer' } }], usage: { prompt_tokens: 2, completion_tokens: 1 } };
    assert.equal((await chat.chatCompletion(base, key, 'model', input)).content, 'answer');
    process.env.MY_AGENT_LLM_USAGE_LOG_DIR = path.join(temp, 'usage');
  });
  await test('opt-out does not create usage records or change response', async () => {
    const before = rows().length; process.env.MY_AGENT_LLM_USAGE_LOG = 'off'; await direct({ usage: { input_tokens: 2, output_tokens: 1 } }); assert.equal(rows().length, before);
  });
  console.log(`PASS ${passed} per-call usage scenarios; local-only, no paid calls`);
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  for (const name of ['MY_AGENT_LLM_LOG', 'MY_AGENT_LLM_USAGE_LOG', 'MY_AGENT_LLM_USAGE_LOG_DIR']) { if (env[name] === undefined) delete process.env[name]; else process.env[name] = env[name]; }
  rmSync(temp, { recursive: true, force: true });
}
