import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const compatible = await import(pathToFileURL(
  path.join(root, 'core', 'dist', 'providers', 'openai-compatible.js'),
));
const originalFetch = globalThis.fetch;
const calls = [];

try {
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response([
      'event: response.reasoning_summary_text.delta',
      'data: {"type":"response.reasoning_summary_text.delta","delta":"summary-stream"}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"answer-stream"}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"model":"gpt-reasoning"}}',
      '',
    ].join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };

  let streamedAnswer = '';
  let streamedThought = '';
  const streamed = await compatible.chatCompletionStream(
    'https://openai.test/v1',
    'secret',
    'gpt-reasoning',
    [{ role: 'user', content: 'reason' }],
    (delta) => { streamedAnswer += delta; },
    {
      wireApi: 'responses',
      reasoningEffort: 'high',
      onThought: (delta) => { streamedThought += delta; },
    },
  );

  assert.equal(streamed.content, 'answer-stream');
  assert.equal(streamedAnswer, 'answer-stream');
  assert.equal(streamedThought, 'summary-stream');
  assert.deepEqual(calls[0].body.reasoning, { effort: 'high', summary: 'concise' });

  calls.length = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response([
      'event: response.completed',
      'data: {"type":"response.completed","response":{"model":"openai/gpt-5.6-sol","output":[{"type":"reasoning","summary":["summary-string",{"type":"summary_text","text":"summary-object"}]},{"type":"message","content":[{"type":"output_text","text":"answer-completed"}]}]}}',
      '',
    ].join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };

  let completedAnswer = '';
  let completedThought = '';
  const completedOnly = await compatible.chatCompletionStream(
    'https://openrouter.test/api/v1',
    'secret',
    'openai/gpt-5.6-sol',
    [{ role: 'user', content: 'reason' }],
    (delta) => { completedAnswer += delta; },
    {
      wireApi: 'responses',
      reasoningEffort: 'high',
      onThought: (delta) => { completedThought += delta; },
    },
  );

  assert.equal(completedOnly.content, 'answer-completed');
  assert.equal(completedAnswer, '');
  assert.equal(completedThought, 'summary-string\n\nsummary-object');
  assert.deepEqual(calls[0].body.reasoning, { effort: 'high', summary: 'concise' });

  calls.length = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({
      model: 'gpt-reasoning',
      output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'summary-document' }] },
        { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  let documentThought = '';
  const toolResult = await compatible.chatCompletionWithTools(
    'https://openai.test/v1',
    'secret',
    'gpt-reasoning',
    [{ role: 'user', content: 'inspect' }],
    [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
    { wireApi: 'responses', stream: false, reasoningEffort: 'high' },
    { onThought: (delta) => { documentThought += delta; } },
  );

  assert.equal(toolResult.reasoning, 'summary-document');
  assert.equal(documentThought, 'summary-document');
  assert.equal(toolResult.tool_calls[0].function.name, 'read_file');
  assert.deepEqual(calls[0].body.reasoning, { effort: 'high', summary: 'concise' });

  console.log('VERIFY_OPENAI_REASONING_SUMMARY_OK');
} finally {
  globalThis.fetch = originalFetch;
}
