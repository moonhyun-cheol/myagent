#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync('core/src/agent/agent-context-profile.ts', 'utf8');
const loop = readFileSync('core/src/agent/agent-run-step-loop.ts', 'utf8');

for (const profile of ['orient', 'execute', 'repair', 'verify', 'final']) {
  assert(source.includes(`'${profile}'`), `missing context profile: ${profile}`);
}
assert(source.includes('compactConsumedToolResults'), 'old tool results must be compacted');
assert(source.includes('selectedNamesForProfile'), 'tool schemas must be selected by profile');
assert(loop.includes('resolveAgentContextProfile'), 'step loop must resolve a profile for every model call');
assert(loop.includes('profiledContext.agentTools'), 'native tool schema must use the selected profile tools');
assert(loop.includes('profiledContext.toolNames'), 'client protocol must use the selected profile tool names');
assert(loop.includes('profiledContext.messages'), 'model calls must use the compiled profile context');

const {
  compileAgentStepContext,
  resolveAgentContextProfile,
} = await import('../core/dist/agent/agent-context-profile.js');

const tool = (name) => ({
  type: 'function',
  function: { name, description: name, parameters: { type: 'object' } },
});
const tools = [
  tool('read_file'),
  tool('apply_patch'),
  tool('run_diagnostics'),
  tool('git_commit'),
  tool('browser_navigate'),
];
const baseMessages = [
  { role: 'system', content: 'safety kernel' },
  { role: 'user', content: '코드를 수정해줘' },
];

assert.equal(resolveAgentContextProfile({ step: 1, messages: baseMessages }), 'orient');
assert.equal(resolveAgentContextProfile({ step: 2, messages: baseMessages }), 'execute');
assert.equal(resolveAgentContextProfile({
  step: 3,
  messages: [...baseMessages, { role: 'tool', content: 'ERROR: patch failed' }],
}), 'repair');
assert.equal(resolveAgentContextProfile({
  step: 3,
  messages: baseMessages,
  evidence: { mutatedPaths: ['a.ts'], acceptanceOk: false },
}), 'verify');
assert.equal(resolveAgentContextProfile({
  step: 4,
  messages: baseMessages,
  evidence: { mutatedPaths: ['a.ts'], acceptanceOk: true },
}), 'final');

const orient = compileAgentStepContext({
  profile: 'orient',
  messages: baseMessages,
  agentTools: tools,
  userMessage: '코드를 수정해줘',
});
assert.deepEqual(orient.toolNames, ['read_file']);
assert(orient.messages.some((message) => String(message.content).includes('Native context profile: orient')));

const execute = compileAgentStepContext({
  profile: 'execute',
  messages: baseMessages,
  agentTools: tools,
  userMessage: '커밋하고 브라우저로 검증해줘',
});
assert(execute.toolNames.includes('apply_patch'));
assert(execute.toolNames.includes('git_commit'));
assert(execute.toolNames.includes('browser_navigate'));

const oldToolMessages = Array.from({ length: 8 }, (_, index) => ({
  role: 'tool',
  tool_call_id: `tool-${index}`,
  content: `result-${index}: ${'x'.repeat(900)}`,
}));
const compacted = compileAgentStepContext({
  profile: 'execute',
  messages: [...baseMessages, ...oldToolMessages],
  agentTools: tools,
  userMessage: '수정',
});
assert(String(compacted.messages[3].content).includes('이전 도구 결과 압축됨'));
assert(String(compacted.messages.at(-1).content).length > 800, 'recent tool results must remain intact');

console.log('agent context profiles: ok');
