import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');

function run(label, command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', shell: false });
  if (result.status !== 0) {
    process.stderr.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    throw new Error(`${label} failed (${result.status})`);
  }
  console.log(`PASS ${label}`);
}

run('core TypeScript', process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(root, 'tsconfig.json')]);
run('workspace TypeScript', process.execPath, [path.join(root, 'ui', 'workspace', 'node_modules', 'typescript', 'bin', 'tsc'), '-b', path.join(root, 'ui', 'workspace', 'tsconfig.json')]);

const compatible = await import(pathToFileURL(path.join(root, 'core', 'dist', 'providers', 'openai-compatible.js')));
const responses = await import(pathToFileURL(path.join(root, 'core', 'dist', 'providers', 'responses-compatible.js')));
const anthropic = await import(pathToFileURL(path.join(root, 'core', 'dist', 'providers', 'anthropic-messages.js')));
const wirePolicy = await import(pathToFileURL(path.join(root, 'core', 'dist', 'providers', 'provider-wire-api.js')));
const { ProviderStore } = await import(pathToFileURL(path.join(root, 'core', 'dist', 'providers', 'provider-store.js')));
const { MemoryMasterKeyStore } = await import(pathToFileURL(path.join(root, 'core', 'dist', 'providers', 'os-secret-store.js')));
const { SessionStore } = await import(pathToFileURL(path.join(root, 'core', 'dist', 'sessions', 'session-store.js')));
const { buildDefaultBundlePayload } = await import(pathToFileURL(path.join(root, 'core', 'dist', 'setup', 'default-bundle-payload.js')));

const originalFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const body = init.body ? JSON.parse(String(init.body)) : null;
  calls.push({ url: String(url), body });
  if (String(url).endsWith('/responses')) {
    return new Response(JSON.stringify({
      model: 'response-model',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'responses-ok' }] }],
      usage: { input_tokens: 3, output_tokens: 2 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  throw new Error(`unexpected URL: ${url}`);
};

try {
  const plain = await compatible.chatCompletion('https://mock.local/v1', 'secret', 'model', [{ role: 'user', content: 'hello' }], { wireApi: 'responses' });
  assert.equal(plain.content, 'responses-ok');
  assert.equal(calls[0].url, 'https://mock.local/v1/responses');
  assert.equal(calls[0].body.store, false);
  assert.ok(Array.isArray(calls[0].body.input));
  assert.equal('messages' in calls[0].body, false);
  console.log('PASS Responses primary request + output conversion');

  calls.length = 0;
  let responseSeq = 0;
  globalThis.fetch = async (url, init = {}) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url: String(url), body });
    responseSeq += 1;
    return new Response(JSON.stringify({
      id: `resp_${responseSeq}`,
      model: 'gpt-stateful',
      reasoning: { context: 'all_turns' },
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `turn-${responseSeq}` }] }],
      usage: {
        input_tokens: 20,
        output_tokens: 5,
        input_tokens_details: { cached_tokens: responseSeq === 2 ? 12 : 0, cache_write_tokens: 3 },
        output_tokens_details: { reasoning_tokens: 2 },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const providerState = {
    version: 1,
    mode: 'provider_state',
    provider_id: 'openai',
    model_id: 'gpt-stateful',
    next_message_index: 0,
    updated_at: new Date(0).toISOString(),
  };
  let persistedState = null;
  const firstMessages = [
    { role: 'system', content: 'stable instructions' },
    { role: 'user', content: 'first' },
  ];
  await responses.responsesCompletionAt('https://api.openai.test/v1', 'secret', 'gpt-stateful', firstMessages, {
    responsesState: providerState,
    onResponsesState: (state) => { persistedState = state; },
  });
  assert.equal(calls[0].body.store, true);
  assert.equal(calls[0].body.instructions, 'stable instructions');
  assert.equal(calls[0].body.previous_response_id, undefined);
  assert.equal(providerState.previous_response_id, 'resp_1');
  assert.equal(persistedState.usage.reasoning_tokens, 2);
  await responses.responsesCompletionAt('https://api.openai.test/v1', 'secret', 'gpt-stateful', [
    ...firstMessages,
    { role: 'assistant', content: 'turn-1' },
    { role: 'user', content: 'second' },
  ], { responsesState: providerState });
  assert.equal(calls[1].body.previous_response_id, 'resp_1');
  assert.deepEqual(calls[1].body.input, [{ role: 'user', content: 'second' }]);
  assert.equal(providerState.previous_response_id, 'resp_2');
  assert.equal(providerState.usage.cached_tokens, 12);
  console.log('PASS OpenAI previous_response_id continuation + usage details');

  calls.length = 0;
  responseSeq = 0;
  globalThis.fetch = async (url, init = {}) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url: String(url), body });
    responseSeq += 1;
    return new Response(JSON.stringify({
      id: `replay_${responseSeq}`,
      model: 'gateway-model',
      output: [
        { type: 'reasoning', encrypted_content: `cipher-${responseSeq}` },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `gateway-${responseSeq}` }] },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const replayState = {
    version: 1,
    mode: 'client_replay',
    provider_id: 'custom',
    model_id: 'gateway-model',
    next_message_index: 0,
    updated_at: new Date(0).toISOString(),
  };
  await responses.responsesCompletionAt('https://gateway.test/v1', 'secret', 'gateway-model', [{ role: 'user', content: 'one' }], { responsesState: replayState });
  await responses.responsesCompletionAt('https://gateway.test/v1', 'secret', 'gateway-model', [
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'gateway-1' },
    { role: 'user', content: 'two' },
  ], { responsesState: replayState });
  assert.equal(calls[1].body.store, false);
  assert.deepEqual(calls[1].body.include, ['reasoning.encrypted_content']);
  assert.equal(calls[1].body.previous_response_id, undefined);
  assert.equal(calls[1].body.input.some((item) => item.encrypted_content === 'cipher-1'), true);
  assert.deepEqual(calls[1].body.input.at(-1), { role: 'user', content: 'two' });
  console.log('PASS gateway client replay preserves encrypted reasoning items');

  calls.length = 0;
  globalThis.fetch = async (url) => {
    calls.push({ url: String(url), body: null });
    return new Response(JSON.stringify({ error: { message: 'Responses endpoint not found' } }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  };
  await assert.rejects(
    compatible.chatCompletion('https://legacy.local/v1', 'secret', 'model', [{ role: 'user', content: 'hello' }], { wireApi: 'responses' }),
    /RESPONSES_HTTP_404/,
  );
  assert.deepEqual(calls.map((row) => new URL(row.url).pathname), ['/v1/responses']);
  console.log('PASS runtime does not fall back from fixed Responses');

  calls.length = 0;
  globalThis.fetch = async (url) => {
    calls.push({ url: String(url), body: null });
    return new Response(JSON.stringify({ error: { message: 'invalid key' } }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  };
  await assert.rejects(compatible.chatCompletion('https://secure.local/v1', 'bad', 'model', [{ role: 'user', content: 'hello' }], { wireApi: 'responses' }), /RESPONSES_HTTP_401/);
  assert.equal(calls.length, 1);
  console.log('PASS auth errors remain on fixed transport');

  calls.length = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ model: 'tool-model', output: [{ type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const toolResult = await compatible.chatCompletionWithTools('https://tools.local/v1', 'secret', 'model', [{ role: 'user', content: 'read' }], [{ type: 'function', function: { name: 'read_file', description: 'Read', parameters: { type: 'object' } } }], { wireApi: 'responses', stream: false });
  assert.equal(toolResult.tool_calls[0].function.name, 'read_file');
  assert.equal(calls[0].body.tools[0].name, 'read_file');
  assert.equal('function' in calls[0].body.tools[0], false);
  console.log('PASS Responses function-call conversion');

  calls.length = 0;
  const removedToolName = ['ai', 'der', '_edit'].join('');
  const legacyToolState = {
    version: 1,
    mode: 'provider_state',
    provider_id: 'openai',
    model_id: 'tool-model',
    previous_response_id: 'resp_before_tool_schema_change',
    next_message_index: 1,
    replay_items: [{ type: 'function_call', call_id: 'old_call', name: removedToolName, arguments: '{}' }],
    reasoning_context: 'legacy-tools',
    usage: { input_tokens: 99 },
    updated_at: new Date(0).toISOString(),
  };
  const invalidations = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({
      id: 'resp_after_tool_schema_change',
      model: 'tool-model',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'reset-ok' }] }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  await compatible.chatCompletionWithTools(
    'https://tools.local/v1',
    'secret',
    'tool-model',
    [{ role: 'user', content: 'continue after upgrade' }],
    [{ type: 'function', function: { name: 'read_file', description: 'Read', parameters: { type: 'object' } } }],
    {
      wireApi: 'responses',
      stream: false,
      responsesState: legacyToolState,
      onResponsesState: (state) => { invalidations.push(structuredClone(state)); },
    },
  );
  assert.equal(calls[0].body.previous_response_id, undefined);
  assert.deepEqual(calls[0].body.input, [{ role: 'user', content: 'continue after upgrade' }]);
  assert.ok(legacyToolState.tool_schema_hash);
  assert.equal(invalidations[0].previous_response_id, undefined);
  assert.equal(invalidations[0].replay_items, undefined);
  assert.equal(invalidations[0].next_message_index, 0);
  console.log('PASS legacy Responses cache resets when tool schema changes');

  globalThis.fetch = async () => new Response([
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"stream-"}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"ok"}',
    '',
    'event: response.completed',
    'data: {"type":"response.completed","response":{"model":"stream-model"}}',
    '',
  ].join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  let streamed = '';
  const streamResult = await compatible.chatCompletionStream('https://stream.local/v1', 'secret', 'model', [{ role: 'user', content: 'stream' }], (delta) => { streamed += delta; }, { wireApi: 'responses' });
  assert.equal(streamed, 'stream-ok');
  assert.equal(streamResult.content, 'stream-ok');
  console.log('PASS Responses SSE streaming');

  const converted = responses.buildResponsesInput([
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'done' },
  ]);
  assert.equal(converted[0].type, 'function_call');
  assert.equal(converted[1].type, 'function_call_output');
  console.log('PASS stateless tool history conversion');

  calls.length = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
    return new Response(JSON.stringify({
      model: 'claude-test',
      content: [
        { type: 'text', text: 'messages-ok' },
        { type: 'tool_use', id: 'tool_1', name: 'read_file', input: { path: 'a' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 4, output_tokens: 3 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const messageTools = await compatible.chatCompletionWithTools(
    'https://api.anthropic.com/v1',
    'anthropic-secret',
    'claude-test',
    [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }],
    [{ type: 'function', function: { name: 'read_file', description: 'Read', parameters: { type: 'object' } } }],
    { wireApi: 'messages', stream: false },
  );
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].headers.get('x-api-key'), 'anthropic-secret');
  assert.equal(calls[0].headers.get('anthropic-version'), '2023-06-01');
  assert.equal(calls[0].body.system, 'system');
  assert.equal(calls[0].body.tools[0].input_schema.type, 'object');
  assert.equal(messageTools.tool_calls[0].function.name, 'read_file');
  console.log('PASS native Anthropic Messages + tools');

  globalThis.fetch = async () => new Response([
    'event: message_start',
    'data: {"type":"message_start","message":{"model":"claude-stream"}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"message-"}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"stream"}}',
    '',
  ].join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  let messageStream = '';
  const messageStreamResult = await compatible.chatCompletionStream(
    'https://api.anthropic.com/v1',
    'anthropic-secret',
    'claude-stream',
    [{ role: 'user', content: 'hello' }],
    (delta) => { messageStream += delta; },
    { wireApi: 'messages' },
  );
  assert.equal(messageStream, 'message-stream');
  assert.equal(messageStreamResult.model, 'claude-stream');
  console.log('PASS Anthropic Messages SSE streaming');

  const messageHistory = anthropic.buildAnthropicMessages([
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{"v":1}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'done' },
  ]);
  assert.equal(messageHistory.messages[0].content[0].type, 'tool_use');
  assert.equal(messageHistory.messages[1].content[0].type, 'tool_result');
  console.log('PASS Anthropic tool history conversion');

  const openaiDef = { id: 'openai', name: 'OpenAI', kind: 'openai_compatible', base_url: 'https://api.openai.com/v1', default_model: 'gpt-5' };
  const anthropicDef = { id: 'anthropic', name: 'Anthropic', kind: 'openai_compatible', base_url: 'https://api.anthropic.com/v1', default_model: 'claude' };
  const unknownDef = { id: 'user_unknown', name: 'Unknown', kind: 'openai_compatible', base_url: 'https://unknown/v1', default_model: 'model' };
  const customDef = { id: 'custom', name: 'MY 클라우드', kind: 'openai_compatible', base_url: 'https://owui.test/api', default_model: 'routed-model', custom: true, wire_api: 'responses' };
  assert.deepEqual(wirePolicy.configurationWireCandidates(openaiDef, 'gpt-5'), ['responses']);
  assert.deepEqual(wirePolicy.configurationWireCandidates(anthropicDef, 'claude-opus'), ['messages']);
  assert.equal(wirePolicy.knownProviderWireApi(openaiDef, 'gpt-5', 'chat_completions'), 'responses');
  assert.equal(wirePolicy.knownProviderWireApi(anthropicDef, 'claude-opus', 'responses'), 'messages');
  assert.equal(wirePolicy.knownProviderWireApi(customDef, 'routed-model', 'chat_completions'), 'responses');
  assert.equal(
    wirePolicy.knownProviderWireApi({ ...customDef, wire_api: 'chat_completions' }, 'routed-model'),
    'responses',
    'MY 클라우드 catalog values must not bypass its enforced Responses transport',
  );
  assert.deepEqual(wirePolicy.configurationWireCandidates(unknownDef, 'model'), ['responses', 'messages', 'chat_completions']);
  const configurationCalls = [];
  const selected = await wirePolicy.selectWireApiAtConfiguration(
    unknownDef,
    'model',
    null,
    async (wireApi) => {
      configurationCalls.push(wireApi);
      return { ok: wireApi === 'chat_completions', note: wireApi === 'chat_completions' ? 'OK' : 'unsupported' };
    },
  );
  assert.equal(selected.selected, 'chat_completions');
  assert.deepEqual(configurationCalls, ['responses', 'messages', 'chat_completions']);
  const gptConfigurationCalls = [];
  const gptSelection = await wirePolicy.selectWireApiAtConfiguration(
    openaiDef,
    'gpt-5',
    null,
    async (wireApi) => {
      gptConfigurationCalls.push(wireApi);
      return { ok: false, note: 'failed' };
    },
  );
  assert.equal(gptSelection.selected, null);
  assert.deepEqual(gptConfigurationCalls, ['responses']);
  console.log('PASS configuration-only Responses -> Messages -> Chat candidate policy');
} finally {
  globalThis.fetch = originalFetch;
}

const tempRoot = mkdtempSync(path.join(root, 'data', 'verify-vault-'));
try {
  const sessionsDir = tempRoot;
  const sessionStore = new SessionStore(sessionsDir, root);
  const durableState = {
    version: 1,
    mode: 'provider_state',
    provider_id: 'openai',
    model_id: 'gpt-stateful',
    previous_response_id: 'resp_durable',
    next_message_index: 4,
    updated_at: new Date().toISOString(),
  };
  sessionStore.saveResponsesState('session-a', durableState);
  sessionStore.saveResponsesState(
    'session-a',
    { ...durableState, previous_response_id: 'resp_coder' },
    'agent:coder',
  );
  const reloadedStore = new SessionStore(sessionsDir, root);
  assert.equal(
    reloadedStore.responsesState('session-a', 'openai', 'gpt-stateful', 'provider_state').previous_response_id,
    'resp_durable',
  );
  assert.equal(
    reloadedStore.responsesState('session-a', 'openai', 'gpt-stateful', 'provider_state', 'agent:coder').previous_response_id,
    'resp_coder',
  );
  const publicSession = reloadedStore.publicRecord(reloadedStore.load('session-a'));
  assert.equal('responses_state' in publicSession, false);
  assert.equal('responses_states' in publicSession, false);
  reloadedStore.append('session-a', { role: 'user', content: 'undo me', at: new Date().toISOString() });
  reloadedStore.popLastTurn('session-a');
  assert.equal(reloadedStore.load('session-a').responses_state, undefined);
  assert.equal(reloadedStore.load('session-a').responses_states, undefined);
  console.log('PASS Responses chain persists across reload and clears on undo branch');

  const vaultPath = path.join(tempRoot, 'provider-keys.json');
  const masterKeys = new MemoryMasterKeyStore();
  const store = new ProviderStore(vaultPath, root, masterKeys);
  const plaintext = 'owui-local-secret-1234';
  store.saveKey('custom', plaintext, { model_id: 'openai/gpt-5.6-terra-pro' });
  const raw = readFileSync(vaultPath, 'utf8');
  assert.equal(raw.includes(plaintext), false);
  assert.match(raw, /"api_key_enc"/);
  assert.equal(store.getSecret('custom').api_key, plaintext);
  const publicRow = store.listPublic().find((row) => row.id === 'custom');
  assert.equal(publicRow.configured, true);
  assert.equal(publicRow.wire_api, 'responses');
  assert.equal(publicRow.wire_api_confirmed, true);
  assert.equal(publicRow.tool_protocol, 'native');
  assert.equal(publicRow.tool_protocol_confirmed, false);
  assert.equal(publicRow.secret_storage, 'local_encrypted');
  assert.equal(publicRow.secret_backend, 'memory-test');
  assert.equal('api_key' in publicRow, false);
  store.saveKey('anthropic', 'anthropic-local-secret', {
    base_url: 'https://api.anthropic.com/v1',
    model_id: 'claude-opus-4-8',
  });
  assert.equal(store.getSecret('anthropic').wire_api, 'messages');
  store.saveKey('custom', '', { wire_api: 'chat_completions' });
  assert.equal(store.getSecret('custom').wire_api, 'responses', 'manual override must be ignored for known Responses endpoint');
  store.saveKey('custom', '', { tool_protocol: 'native' });
  assert.equal(store.getSecret('custom').tool_protocol, 'native');
  const tampered = readFileSync(vaultPath, 'utf8').replace(
    /("wire_api"\s*:\s*)"responses"/,
    '$1"chat_completions"',
  );
  writeFileSync(vaultPath, tampered, 'utf8');
  const migratedStore = new ProviderStore(vaultPath, root, masterKeys);
  assert.equal(migratedStore.getSecret('custom').wire_api, 'responses', 'legacy manual override must migrate to enforced Responses');
  store.deleteKey('custom');
  assert.equal(store.getSecret('custom'), null);
  console.log('PASS local AES-GCM vault save/read/public-redaction/delete');
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

const bundle = buildDefaultBundlePayload({ orgId: 'verify', cqrRoot: root, deploy: { ollama_base_url: 'http://ollama.internal/v1', ollama_default_model: 'qwen' } });
assert.deepEqual(Object.keys(bundle.entries), ['ollama']);
assert.equal(bundle.default_provider_id, 'ollama');
assert.equal(existsSync(path.join(root, 'core', 'config', 'defaults', 'keys-bundle.default.enc')), false);
assert.equal(existsSync(path.join(root, 'core', 'config', 'defaults', 'keys-bundle.dev.enc')), false);
console.log('PASS deployment bundle excludes Open WebUI credentials');

const setupSource = readFileSync(path.join(root, 'core', 'src', 'setup', 'setup-service.ts'), 'utf8');
assert.match(setupSource, /if \(id === 'custom'\) continue/);
const dispatchSource = readFileSync(path.join(root, 'core', 'src', 'routes', 'dispatch.ts'), 'utf8');
assert.match(dispatchSource, /sendJson\(res, 200, sessionStore\.publicRecord\(rec\)\)/);
assert.match(dispatchSource, /sendJson\(res, 201, sessionStore\.publicRecord\(rec\)\)/);
const ui = readFileSync(path.join(root, 'ui', 'workspace', 'src', 'components', 'GeminiNavSidebar.tsx'), 'utf8');
for (const marker of ['Responses 고정', 'Anthropic Messages 고정', '네이티브 tools', '구성 확정', '로컬 암호화 저장', '연결 테스트', '키 삭제']) assert.ok(ui.includes(marker), `missing UI acceptance marker: ${marker}`);
assert.ok(ui.includes('전송 방식은 모델·엔드포인트에서 자동 고정'));
assert.equal(ui.includes('className="inp-wire'), false, 'wire transport selector must not be user-editable');
assert.equal(ui.includes('personalForm.wire_api'), false, 'personal provider form must not accept manual transport');
console.log('PASS settings UI acceptance wiring markers');
console.log('VERIFY_RESPONSES_VAULT_OK');
