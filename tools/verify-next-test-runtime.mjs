#!/usr/bin/env node
/** Regression contract for the next external usability test build. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { agentToolOutputOk, summarizeAgentToolResult } = await import('../core/dist/agent/agent-tool-result.js');
const { summarizeResponsesPerfState } = await import('../core/dist/agent/agent-perf-metrics.js');
const {
  buildTaskChecklist,
  evaluateTaskChecklist,
  isTaskChecklistComplete,
  formatGitWorkflowSystemNote,
} = await import('../core/dist/agent/agent-task-checklist.js');
const { gitInit } = await import('../core/dist/agent/run-terminal.js');
const {
  buildAgentMessages,
} = await import('../core/dist/agent/agent-run-helpers.js');
const {
  synthesizeAnswerFromToolResults,
  looksLikeInspectToolDump,
} = await import('../core/dist/agent/agent-llm-step.js');

assert.equal(agentToolOutputOk('{"ok":false,"error":"denied"}'), false);
assert.equal(agentToolOutputOk('{"exit_code":1,"stdout":""}'), false);
assert.equal(agentToolOutputOk('{"ok":true,"exit_code":0}'), true);
assert.equal(
  summarizeAgentToolResult('{"ok":false,"exit_code":1,"error":"script failed"}').failure_type,
  'command_exit_nonzero',
);
assert.equal(
  summarizeAgentToolResult('ERROR: tool_call_failed\ndetail: {"ok":false,"exit_code":7}').failure_type,
  'command_exit_nonzero',
  'wrapped tool failures must retain their lower-level command classification',
);
assert.equal(
  summarizeAgentToolResult('{"ok":false,"skipped":true,"weak":true}').failure_type,
  'diagnostics_skipped',
);
assert.equal(
  summarizeAgentToolResult('ERROR: access is denied').failure_type,
  'permission_denied',
);
const responseSummary = summarizeResponsesPerfState({
  version: 1,
  mode: 'client_replay',
  provider_id: 'custom',
  model_id: 'fixture',
  previous_response_id: 'resp_secret_not_logged',
  next_message_index: 4,
  replay_items: [{ type: 'reasoning', encrypted_content: 'secret' }],
  reasoning_context: 'all_turns',
  usage: { cached_tokens: 12, cache_write_tokens: 3 },
  updated_at: new Date().toISOString(),
});
assert.equal(responseSummary.has_previous_response_id, true);
assert.equal(responseSummary.replay_item_count, 1);
assert.equal(JSON.stringify(responseSummary).includes('resp_secret_not_logged'), false);
assert.equal(JSON.stringify(responseSummary).includes('encrypted_content'), false);

const directoryPayload = JSON.stringify({
  path: '.',
  entries: [
    { name: 'background.js', is_dir: false },
    { name: 'manifest.json', is_dir: false },
  ],
});
assert.equal(looksLikeInspectToolDump(directoryPayload), true);
const directoryAnswer = synthesizeAnswerFromToolResults([{ role: 'tool', content: directoryPayload }]);
assert.match(directoryAnswer, /모델의 최종 답변을 받지 못했습니다/);
assert.match(directoryAnswer, /작업 보고서로 재작성하지 않았습니다/);
assert.doesNotMatch(directoryAnswer, /파일은 있습니다|background\.js/);
assert.doesNotMatch(directoryAnswer, /^도구 실행 결과:/);

const checklist = buildTaskChecklist('이 프로젝트 폴더를 새 repo로 만들어줘');
assert.equal(checklist.requiredGitState, 'first_commit');
assert.equal(checklist.labels.includes('greenfield-default-set'), false);
assert.deepEqual(checklist.requiredPaths, []);
assert.match(formatGitWorkflowSystemNote(checklist), /HEAD|first_commit|git_commit/i);

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const llmStepSource = readFileSync(path.join(projectRoot, 'core', 'src', 'agent', 'agent-llm-step.ts'), 'utf8');
const runLoopSource = readFileSync(path.join(projectRoot, 'core', 'src', 'agent', 'agent-run-loop.ts'), 'utf8');
const marSource = readFileSync(path.join(projectRoot, 'core', 'src', 'agent', 'agent-mar-runtime.ts'), 'utf8');
assert.doesNotMatch(llmStepSource, /모델 초안 \(TOOL_CALL\)|\[stub\] analyzing request/);
assert.doesNotMatch(runLoopSource, /pushThought[\s\S]{0,500}opts\.onThought/);
assert.doesNotMatch(marSource, /onThought\?\.\(`role_start/);
assert.match(runLoopSource, /const providerThought = thoughtBuf\.trim\(\)/);

const root = mkdtempSync(path.join(projectRoot, 'data', '_verify-git-contract-'));
try {
  writeFileSync(path.join(root, 'README.md'), '# fixture\n', 'utf8');
  const externalMessages = buildAgentMessages(
    {
      workspaceRoot: root,
      cqrRoot: projectRoot,
      userMessage: '이 프로젝트의 전체 구조 및 파이어폭스 적용 가능 여부 설명',
      providerId: 'custom',
      providerStore: {},
    },
    {},
    ['list_directory', 'read_file'],
    true,
    null,
    '',
    false,
    false,
  );
  const externalSystem = String(externalMessages[0]?.content || '');
  assert.match(externalSystem, /You are one workspace agent/i);
  assert.match(externalSystem, /local runtime does not classify the request or choose tools/i);
  assert.doesNotMatch(externalSystem, /code agent with filesystem tools|secretary\/ops plane|external workspace explain\/report/i);
  assert.match(externalSystem, /list_directory[\s\S]*read_file/i);
  assert.doesNotMatch(externalSystem, /answer in Korean from preloaded grounding/i);

  const before = evaluateTaskChecklist({
    checklist,
    workspaceRoot: root,
    mutatedPaths: [],
    toolsUsed: [],
    claimsDone: true,
    claimsPartial: false,
  });
  assert.equal(before.ok, false);
  assert.equal(before.missingGitState, 'first_commit');

  assert.equal(JSON.parse(gitInit(root, false)).ok, false, 'git_init must require explicit confirm');
  // The checked-out project is a real repository with HEAD; this verifies the
  // positive side without asking the test process to create nested Git state.
  assert.equal(
    isTaskChecklistComplete({ checklist, workspaceRoot: projectRoot, mutatedPaths: [] }),
    true,
    'existing repository HEAD must satisfy first-commit contract',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('verify-next-test-runtime: ok');
