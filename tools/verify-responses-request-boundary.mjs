import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Entirely local HTTP fixtures; never calls a paid provider or installed app.
const root = path.resolve(import.meta.dirname, '..');
const temp = mkdtempSync(path.join(root, 'data', 'verify-responses-boundary-'));
const oldLog = process.env.MY_AGENT_LLM_LOG;
const oldDir = process.env.MY_AGENT_LLM_LOG_DIR;
const oldUsageDir = process.env.MY_AGENT_LLM_USAGE_LOG_DIR;
process.env.MY_AGENT_LLM_USAGE_LOG_DIR = path.join(temp, 'usage');
process.env.MY_AGENT_LLM_LOG = 'full'; // Even full must not expose Responses content.
process.env.MY_AGENT_LLM_LOG_DIR = path.join(temp, 'logs');
let server;
let passed = 0;
try {
  const build = spawnSync(process.execPath, [
    path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(root, 'tsconfig.json'),
    '--outDir', path.join(temp, 'compiled'), '--declaration', 'false',
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  console.log('PASS core TypeScript (isolated output)');
  const r = await import(pathToFileURL(path.join(temp, 'compiled/providers/responses-compatible.js')));
  const { SessionStore } = await import(pathToFileURL(path.join(temp, 'compiled/sessions/session-store.js')));
  const received = [];
  let status = 200;
  let frames;
  let raw;
  let doc;
  let seq = 0;
  const ok = (text = 'answer') => ({
    id: `resp_${++seq}`, status: 'completed', model: 'model',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
    usage: { input_tokens: 10, output_tokens: 2 },
  });
  const resetReply = () => { status = 200; frames = undefined; raw = undefined; doc = ok(); };
  resetReply();
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const serialized = Buffer.concat(chunks).toString();
    received.push({ path: req.url, body: JSON.parse(serialized), bytes: Buffer.byteLength(serialized) });
    res.writeHead(status, { 'content-type': frames ? 'text/event-stream' : 'application/json', 'x-request-id': 'req_safe_123' });
    res.end(frames ?? raw ?? JSON.stringify(doc));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const key = 'sk-test-super-secret-123456';
  const initial = [{ role: 'system', content: 'stable' }, { role: 'user', content: 'USER_CODE_SENTINEL' }];
  const follow = [...initial, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'next' }];
  const state = mode => ({ version: 1, mode, provider_id: 'test', model_id: 'model', next_message_index: 0, updated_at: new Date(0).toISOString() });
  const invoke = (s, messages = initial, options = {}, tools = [], endpoint = base, apiKey = key, model = 'model') =>
    r.responsesCompletionWithTools(endpoint, apiKey, model, messages, tools, { stream: false, responsesState: s, ...options });
  const test = async (label, fn) => { resetReply(); await fn(); passed++; console.log(`PASS ${label}`); };
  const seed = async mode => { const s = state(mode); await invoke(s); return s; };

  for (const mode of ['provider_state', 'client_replay']) {
    await test(`${mode}: exact prefix, reloadable contract, no duplicate assistant`, async () => {
      const s = await seed(mode);
      const prev = s.previous_response_id;
      const copy = structuredClone(s);
      await invoke(copy, follow);
      const body = received.at(-1).body;
      if (mode === 'provider_state') {
        assert.equal(body.previous_response_id, prev);
        assert.deepEqual(body.input, [{ role: 'user', content: 'next' }]);
      } else {
        assert.equal(body.previous_response_id, undefined);
        assert.equal(body.input.filter(item => item.role === 'assistant').length, 1);
        assert.deepEqual(body.input.at(-1), { role: 'user', content: 'next' });
      }
      assert.equal(copy.request_contract.version, 1);
    });
    const changes = [
      ['same count/different input', { messages: [{ ...initial[0] }, { ...initial[1], content: 'changed' }, ...follow.slice(2)] }],
      ['instructions', { messages: [{ ...initial[0], content: 'new instructions' }, ...follow.slice(1)] }],
      ['ephemeral guidance', { messages: [...follow, { role: 'user', content: 'phase note', ephemeral: true }] }],
      ['model', { model: 'other-model' }],
      ['reasoning', { options: { reasoningEffort: 'high' } }],
      ['tools', { tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }] }],
      ['tool choice', { options: { extraBody: { tool_choice: 'none' } } }],
      ['parallel calls', { options: { extraBody: { parallel_tool_calls: false } } }],
      ['text format', { options: { extraBody: { text: { format: { type: 'json_object' } } } } }],
      ['account', { apiKey: 'different-test-key' }],
      ['endpoint', { endpoint: base + '/other' }],
      ['legacy state', { mutate: s => { delete s.request_contract; } }],
      ['out of range prefix', { mutate: s => { s.request_contract.prefix_items = 999; } }],
    ];
    for (const [label, change] of changes) await test(`${mode}: ${label} rebuilds whole input`, async () => {
      const s = await seed(mode);
      change.mutate?.(s);
      const invalidations = [];
      await invoke(s, change.messages ?? follow, {
        ...change.options,
        onResponsesState: value => invalidations.push(value),
      }, change.tools, change.endpoint, change.apiKey, change.model);
      const body = received.at(-1).body;
      assert.equal(body.previous_response_id, undefined);
      assert.deepEqual(body.input, r.buildResponsesInput((change.messages ?? follow).filter(m => m.role !== 'system' && !m.ephemeral)));
      assert.equal(invalidations[0].request_contract, undefined);
      assert.equal(invalidations[0].previous_response_id, undefined);
    });
    await test(`${mode}: internal metadata does not break reuse`, async () => {
      const s = await seed(mode);
      await invoke(s, follow.map(m => ({ ...m, internal_annotation: 'ignored' })));
      assert.equal(received.at(-1).body.input.length, mode === 'provider_state' ? 1 : 3);
    });
  }

  await test('canonical settings ignore object-key order', async () => {
    const s = state('provider_state');
    await invoke(s, initial, { extraBody: { text: { format: { type: 'text', name: 'x' } } } });
    const prev = s.previous_response_id;
    await invoke(s, follow, { extraBody: { text: { format: { name: 'x', type: 'text' } } } });
    assert.equal(received.at(-1).body.previous_response_id, prev);
  });
  await test('extraBody cannot inject input/previous id/store/stream', async () => {
    const s = state('client_replay');
    await invoke(s, initial, { extraBody: { input: ['injected'], previous_response_id: 'injected', store: true, stream: true } });
    const b = received.at(-1).body;
    assert.deepEqual(b.input, [{ role: 'user', content: 'USER_CODE_SENTINEL' }]);
    assert.equal(b.previous_response_id, undefined);
    assert.equal(b.store, false);
    assert.equal(b.stream, false);
  });
  await test('encrypted replay preserved; corruption invalidates', async () => {
    const s = state('client_replay');
    doc.output.unshift({ type: 'reasoning', encrypted_content: 'ENCRYPTED_SENTINEL' });
    await invoke(s);
    await invoke(s, follow);
    assert.equal(received.at(-1).body.input[1].encrypted_content, 'ENCRYPTED_SENTINEL');
    s.replay_items[0] = { role: 'user', content: 'tampered' };
    const messages = [...follow, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'third' }];
    await invoke(s, messages);
    assert.deepEqual(received.at(-1).body.input, r.buildResponsesInput(messages.filter(m => m.role !== 'system')));
  });

  const call = { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } };
  const assistant = { role: 'assistant', content: null, tool_calls: [call] };
  const result = { role: 'tool', tool_call_id: 'call_1', content: 'REAL_TOOL_RESULT_SENTINEL' };
  for (const mode of ['provider_state', 'client_replay']) await test(`${mode}: pending tool call resume keeps real output`, async () => {
    const s = state(mode);
    doc = { id: `tool_${mode}`, status: 'completed', output: [{ type: 'function_call', call_id: call.id, ...call.function }] };
    await invoke(s);
    doc = ok();
    await invoke(s, [...initial, assistant, result, { role: 'user', content: 'resume after step limit' }]);
    const body = received.at(-1).body;
    assert.equal(body.input.filter(item => item.type === 'function_call_output').length, 1);
    assert.equal(body.input.find(item => item.type === 'function_call_output').output, result.content);
    assert.equal(body.input.filter(item => item.type === 'function_call').length, mode === 'provider_state' ? 0 : 1);
  });
  for (const [label, messages] of [
    ['missing result', [...initial, assistant]],
    ['orphan output', [...initial, result]],
    ['duplicate output', [...initial, assistant, result, result]],
    ['duplicate call', [...initial, assistant, assistant, result]],
  ]) await test(`pair check: ${label} blocks before HTTP; no synthetic result`, async () => {
    const before = received.length;
    await assert.rejects(invoke(state('provider_state'), messages), /RESPONSES_TOOL_PAIR_INVALID/);
    assert.equal(received.length, before);
    assert.equal(result.content, 'REAL_TOOL_RESULT_SENTINEL');
  });

  await test('400 details retained, raw message/metadata omitted, no retry; invalidation reloads', async () => {
    const sessions = new SessionStore(path.join(temp, 'sessions'), root);
    const s = await seed('provider_state');
    sessions.saveResponsesState('fixture', s);
    status = 400;
    doc = { error: { message: `${key} USER_CODE_SENTINEL`, code: 'previous_response_not_found', type: 'invalid_request_error', metadata: { raw: 'ENCRYPTED_SENTINEL' } } };
    const before = received.length;
    await assert.rejects(invoke(s, follow, { onResponsesState: value => sessions.saveResponsesState('fixture', value) }), error => {
      assert.match(error.message, /RESPONSES_HTTP_400/);
      assert.match(error.message, /previous_response_not_found/);
      assert.match(error.message, /req_safe_123/);
      assert.equal(error.message.includes(key), false);
      assert.equal(error.message.includes('USER_CODE_SENTINEL'), false);
      return true;
    });
    assert.equal(received.length, before + 1);
    const reloaded = new SessionStore(path.join(temp, 'sessions'), root).responsesState('fixture', 'test', 'model', 'provider_state');
    assert.equal(reloaded.previous_response_id, undefined);
    assert.equal(reloaded.request_contract, undefined);
    resetReply();
    await invoke(reloaded, follow);
    assert.equal(received.at(-1).body.previous_response_id, undefined);
    assert.equal(received.at(-1).body.input.length, 3);
  });
  await test('invalidation persisted before incompatible request reaches network', async () => {
    const s = await seed('provider_state');
    let saved;
    status = 400;
    doc = { error: { code: 'invalid_request_error' } };
    await assert.rejects(invoke(s, [initial[0], { role: 'user', content: 'new history' }, ...follow.slice(2)], {
      onResponsesState: value => { if (!saved) saved = value; },
    }));
    assert.equal(saved.previous_response_id, undefined);
    assert.equal(saved.invalidation_reason, 'prefix_changed');
  });
  for (const [label, payload] of [['non-JSON', '<html>USER_CODE_SENTINEL</html>'], ['empty body', ''], ['JSON null', 'null']]) {
    await test(`400 ${label}: safe error without body`, async () => {
      status = 400; raw = payload;
      await assert.rejects(invoke(state('provider_state')), error => {
        assert.match(error.message, /RESPONSES_(INVALID_JSON|HTTP_400)/);
        assert.equal(error.message.includes('USER_CODE_SENTINEL'), false);
        return true;
      });
    });
  }
  await test('HTTP 200 incomplete output is not success state', async () => {
    doc.status = 'incomplete';
    const s = state('provider_state');
    await assert.rejects(invoke(s), /RESPONSES_FAILED/);
    assert.equal(s.request_contract, undefined);
  });
  const sse = events => events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  for (const end of ['EOF', 'response.incomplete', 'response.failed', 'error']) await test(`SSE ${end}: partial tool calls never returned for execution`, async () => {
    const s = state('provider_state');
    frames = sse([
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: call.id, ...call.function } },
      ...(end === 'EOF' ? [] : [{ type: end, response: { status: 'incomplete', error: { code: 'rate_limit_exceeded' } } }]),
    ]);
    await assert.rejects(r.responsesCompletionWithTools(base, key, 'model', initial, [], { responsesState: s }, { onContent: () => {} }), /RESPONSES_(FAILED|INCOMPLETE_STREAM)/);
    assert.equal(s.previous_response_id, undefined);
  });
  await test('SSE completed output supports normal continuation', async () => {
    const s = state('provider_state');
    frames = sse([{ type: 'response.output_text.delta', delta: 'answer' }, { type: 'response.completed', response: doc }]);
    const opts = { responsesState: s };
    const answer = await r.responsesCompletionStream(base, key, 'model', initial, () => {}, opts);
    assert.equal(answer.content, 'answer');
    const prev = s.previous_response_id;
    await r.responsesCompletionStream(base, key, 'model', follow, () => {}, opts);
    assert.equal(received.at(-1).body.previous_response_id, prev);
  });
  await test('nested gateway error identifiers retained without raw metadata', async () => {
    status = 400;
    doc = { error: { code: 400, message: 'temporarily rate-limited upstream', metadata: {
      raw: JSON.stringify({ error: { code: 'context_length_exceeded', type: 'invalid_request_error', message: 'USER_CODE_SENTINEL' } }),
    } } };
    await assert.rejects(invoke(state('provider_state')), error => {
      assert.match(error.message, /context_length_exceeded/);
      assert.match(error.message, /rate_limit/);
      assert.equal(error.message.includes('USER_CODE_SENTINEL'), false);
      return true;
    });
  });
  await test('SSE completed without terminal tool output never executes partial calls', async () => {
    frames = sse([
      { type: 'response.output_item.done', item: { type: 'function_call', call_id: call.id, ...call.function } },
      { type: 'response.completed', response: { id: 'no_terminal_output', status: 'completed' } },
    ]);
    await assert.rejects(r.responsesCompletionWithTools(base, key, 'model', initial, [], {}, { onContent: () => {} }), /RESPONSES_INCONSISTENT_STREAM/);
  });
  await test('non-stream plain completion shares boundary and failure protection', async () => {
    const s = state('provider_state');
    await r.responsesCompletionAt(base, key, 'model', initial, { responsesState: s });
    const prev = s.previous_response_id;
    await r.responsesCompletionAt(base, key, 'model', follow, { responsesState: s });
    assert.equal(received.at(-1).body.previous_response_id, prev);
    status = 400;
    doc = { error: { code: 'invalid_request_error' } };
    await assert.rejects(r.responsesCompletionAt(base, key, 'model', initial, { responsesState: s }));
    assert.equal(s.previous_response_id, undefined);
  });
  await test('abort/network failure invalidates persisted chain', async () => {
    const s = await seed('provider_state');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(invoke(s, follow, { signal: controller.signal }));
    assert.equal(s.previous_response_id, undefined);
    assert.equal(s.request_contract, undefined);
  });
  await test('actual serialized bytes/item counts match safe diagnostics; no secrets/content', async () => {
    const entries = readFileSync(path.join(temp, 'logs/llm-wire.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const requests = entries.filter(e => e.phase === 'request');
    // The last request was aborted before reaching the server.
    assert.equal(requests.length, received.length + 1);
    received.forEach((actual, i) => {
      assert.equal(requests[i].serialized_bytes, actual.bytes);
      assert.equal(requests[i].input_items, actual.body.input.length);
    });
    const log = JSON.stringify(entries);
    for (const forbidden of [key, 'USER_CODE_SENTINEL', 'ENCRYPTED_SENTINEL', 'REAL_TOOL_RESULT_SENTINEL', 'Authorization', 'api_key', 'encrypted_content']) assert.equal(log.includes(forbidden), false, forbidden);
    assert.ok(entries.some(e => e.phase === 'failure' && e.code === 'previous_response_not_found' && e.status === 400));
    assert.ok(entries.some(e => e.transport === 'delta'));
    assert.ok(entries.some(e => e.transport === 'replay'));
  });
  // Re-run the existing reasoning-summary regression against this isolated build.
  // Rebase only its module paths in memory; do not write core/dist or edit the test.
  const reasoningSource = readFileSync(path.join(root, 'tools/verify-openai-reasoning-summary.mjs'), 'utf8')
    .replace("const root = path.resolve(import.meta.dirname, '..');", `const root = ${JSON.stringify(temp)};`)
    .replaceAll("'core', 'dist'", "'compiled'");
  const regression = spawnSync(process.execPath, ['--input-type=module', '-e', reasoningSource], {
    cwd: root, encoding: 'utf8', env: { ...process.env, MY_AGENT_LLM_LOG: 'off' },
  });
  assert.equal(regression.status, 0, regression.stdout + regression.stderr);
  assert.match(regression.stdout, /VERIFY_OPENAI_REASONING_SUMMARY_OK/);
  console.log('PASS existing reasoning-summary regression (isolated build)');
  console.log(`VERIFY_RESPONSES_REQUEST_BOUNDARY_OK (${passed} cases + core TypeScript + reasoning regression; local HTTP only)`);
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  if (oldLog === undefined) delete process.env.MY_AGENT_LLM_LOG; else process.env.MY_AGENT_LLM_LOG = oldLog;
  if (oldDir === undefined) delete process.env.MY_AGENT_LLM_LOG_DIR; else process.env.MY_AGENT_LLM_LOG_DIR = oldDir;
  if (oldUsageDir === undefined) delete process.env.MY_AGENT_LLM_USAGE_LOG_DIR; else process.env.MY_AGENT_LLM_USAGE_LOG_DIR = oldUsageDir;
  rmSync(temp, { recursive: true, force: true });
}
