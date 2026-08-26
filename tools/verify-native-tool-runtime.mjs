#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { resolveCodeOwuiProtocolMode } = await import('../core/dist/providers/harness-policy.js');
const { testNativeToolConnection } = await import('../core/dist/providers/openai-compatible.js');
const { externalReportReadTargetsFromOutput } = await import(
  '../core/dist/agent/agent-external-report-grounding.js'
);
const { ProviderStore } = await import('../core/dist/providers/provider-store.js');
const { requiresNativeTools } = await import('../core/dist/providers/provider-wire-api.js');
const { preloadExternalReportGrounding } = await import('../core/dist/agent/agent-run-step-loop.js');
const { completeAgentStepWithProtocol } = await import('../core/dist/agent/agent-llm-step.js');

assert.equal(resolveCodeOwuiProtocolMode({}), 'api');
assert.equal(requiresNativeTools('responses'), true);
assert.equal(requiresNativeTools('messages'), true);
assert.equal(requiresNativeTools('chat_completions'), false);
assert.deepEqual(
  externalReportReadTargetsFromOutput(
    '[tool=list_directory path=.]\n'
      + JSON.stringify({
        path: '.',
        entries: [
          { name: 'src', path: 'src', is_dir: true },
          { name: 'background.js', path: 'background.js', is_dir: false },
          { name: 'manifest.json', path: 'manifest.json', is_dir: false },
          { name: 'notes.txt', path: 'notes.txt', is_dir: false },
        ],
      }),
  ),
  ['manifest.json', 'background.js'],
  'tagged list_directory output must still select two grounding files',
);

const groundingRoot = mkdtempSync(path.join(projectRoot, 'data', 'verify-grounding-'));
try {
  writeFileSync(path.join(groundingRoot, 'manifest.json'), '{"name":"fixture"}\n');
  writeFileSync(path.join(groundingRoot, 'background.js'), 'export const ready = true;\n');
  writeFileSync(path.join(groundingRoot, 'notes.txt'), 'ignore\n');
  const state = {
    steps: 0,
    selfWorkspace: false,
    opts: {
      workspaceRoot: groundingRoot,
      userMessage: '이 프로젝트 전체 구조를 설명해줘',
    },
    toolNames: ['list_directory', 'read_file'],
    toolsUsedThisRun: new Set(),
    reportStatus: () => {},
    toolCallCount: 0,
    runStartedAt: Date.now(),
    messages: [],
    guard: {},
    toolCtx: { browserSession: null, cqrRoot: groundingRoot },
    toolTrace: [],
    retrievalSatisfiedThisRun: false,
    successfulReadsThisRun: new Set(),
    readBodiesFetchedThisRun: new Set(),
  };
  await preloadExternalReportGrounding(state);
  assert.equal(state.toolCallCount, 3, 'preflight must list once and read two key files');
  assert.deepEqual([...state.successfulReadsThisRun].sort(), ['background.js', 'manifest.json']);
} finally {
  rmSync(groundingRoot, { recursive: true, force: true });
}

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => new Response(
    JSON.stringify({
      id: 'resp_probe',
      model: 'fixture-model',
      output: [
        {
          type: 'function_call',
          call_id: 'call_probe',
          name: 'cqr_native_tool_probe',
          arguments: '{"value":"ok"}',
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
  const probe = await testNativeToolConnection(
    'https://fixture.invalid/v1',
    'fixture-key',
    'fixture-model',
    'responses',
  );
  assert.equal(probe.ok, true);
} finally {
  globalThis.fetch = originalFetch;
}

let lockedRequests = 0;
try {
  globalThis.fetch = async () => {
    lockedRequests += 1;
    return new Response(
      JSON.stringify({ error: { message: 'native tools not supported' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  };
  await assert.rejects(
    completeAgentStepWithProtocol(
      'api',
      'https://fixture.invalid/v1',
      'fixture-key',
      'fixture-model',
      [{ role: 'user', content: 'read' }],
      { wireApi: 'responses', nativeToolsLocked: true },
      [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
      ['read_file'],
    ),
    /native tools not supported/,
  );
  assert.equal(lockedRequests, 1, 'confirmed native execution must not retry through TEXT');
} finally {
  globalThis.fetch = originalFetch;
}

const tempRoot = mkdtempSync(path.join(projectRoot, 'data', 'verify-native-tools-'));
try {
  const store = new ProviderStore(path.join(tempRoot, 'provider-keys.json'), projectRoot);
  store.saveKey('custom', 'fixture-secret', {
    base_url: 'https://owui.invalid/api',
    model_id: 'openrouter/gpt-fixture',
    wire_api: 'responses',
    tool_protocol: 'text',
  });
  assert.equal(
    store.getSecret('custom')?.tool_protocol,
    undefined,
    'Responses must not persist a TEXT tool override',
  );
  assert.equal(store.resolveProvider('custom')?.toolProtocol, 'native');
  assert.equal(
    store.listPublic().find((row) => row.id === 'custom')?.tool_protocol_confirmed,
    false,
    'native tools remain unconfirmed until the native probe is saved',
  );
  store.saveKey('custom', 'fixture-secret', {
    base_url: 'https://owui.invalid/api',
    model_id: 'openrouter/gpt-fixture',
    wire_api: 'responses',
    tool_protocol: 'native',
  });
  const resolved = store.resolveProvider('custom');
  assert.equal(resolved?.wireApi, 'responses');
  assert.equal(resolved?.toolProtocol, 'native');
  const publicRow = store.listPublic().find((row) => row.id === 'custom');
  assert.equal(publicRow?.tool_protocol, 'native');
  assert.equal(publicRow?.tool_protocol_confirmed, true);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log('verify-native-tool-runtime: ok');
