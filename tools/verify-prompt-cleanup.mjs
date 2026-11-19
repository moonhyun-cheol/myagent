#!/usr/bin/env node
/**
 * Stale system-prompt lines stay removed (ui-target-map FORBIDDEN, Ollama TOOL_CALL note,
 * codingTaxSystemLines, Exit Gate infra-retry note) and run_terminal verification
 * commands cover non-JS toolchains.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const stepLoop = readFileSync('core/src/agent/agent-run-step-loop.ts', 'utf8');
const verifyLine = stepLoop.split('\n').find((l) => l.includes("execCall.function.name === 'run_terminal'") || l.includes('npm\\s+(?:test|run'));
const reLine = stepLoop.split('\n').find((l) => l.includes('npm\\s+(?:test|run'));
assert.ok(verifyLine && reLine, 'run_terminal verify regex present');
const re = new RegExp(reLine.match(/&& \/(.+)\/i\.test/)[1], 'i');
const cases = {
  'dotnet build shell/x.csproj': true,
  'dotnet test': true,
  'cargo test': true,
  'cargo check': true,
  'go test pkg': true,
  'go vet': true,
  'npm run typecheck': true,
  'npm test': true,
  'npx tsc -p x': true,
  'git status': false,
  'Get-ChildItem': false,
  'npm install': false,
};
for (const [command, want] of Object.entries(cases)) {
  assert.equal(re.test(JSON.stringify({ command })), want, `verify regex: ${command}`);
}

const helpers = await import('../core/dist/agent/agent-run-helpers.js');
assert.equal('codingTaxSystemLines' in helpers, false, 'codingTaxSystemLines removed');
for (const self of [true, false]) {
  for (const client of [true, false]) {
    const msgs = helpers.buildAgentMessages(
      { workspaceRoot: process.cwd(), userMessage: 'x', history: [] },
      {},
      ['read_file'],
      client,
      '',
      self,
    );
    assert.doesNotMatch(msgs[0].content, /ui-target-map|ollama/i, `system prompt (self=${self}, client=${client})`);
  }
}

const orch = readFileSync('core/src/chat/chat-orchestrator.ts', 'utf8');
assert.doesNotMatch(orch, /Infra retry|Close the open Exit Gate/, 'infra retry system note removed');
assert.match(orch, /continuationRetry: attempt > 1/, 'retry still resumes stored progress');

console.log('verify-prompt-cleanup: ok');
