#!/usr/bin/env node
/**
 * ADR-008 failure plane — infra ≠ answer; no tool-plane demotion.
 */
import assert from 'node:assert/strict';

const {
  classifyLlmFailure,
  isAgentExecutionLimit,
  isInfraLlmFailure,
  mustNotDemoteToolPlaneToChat,
  contentLooksLikeLeakedRoleInfraFailure,
  wrapAsInfraError,
  TOOL_PLANE_NO_WORKSPACE_REFUSAL,
  isNoWorkspaceBoundError,
  AgentInfraError,
  formatToolPlaneFailureAssistant,
  toolPlaneInfraRetryLimit,
  toolPlaneAutoResumeLimit,
  shouldAutoResumeAfterInfra,
} = await import('../core/dist/agent/agent-failure-plane.js');

assert.equal(classifyLlmFailure(new Error('OWUI_GATEWAY_TIMEOUT (504)')), 'infra');
assert.equal(isInfraLlmFailure(new Error('UPSTREAM_HTML_ERROR')), true);
assert.equal(classifyLlmFailure(new Error('AbortError')), 'abort');
assert.equal(classifyLlmFailure(new Error('syntax oops')), 'other');
assert.equal(
  isAgentExecutionLimit(
    new Error('Code agent exceeded 45 LLM orchestration rounds (not tool calls).'),
  ),
  true,
);
assert.equal(isAgentExecutionLimit(new Error('Code agent exceeded 45 tool steps')), true);
assert.equal(isAgentExecutionLimit(new Error('OWUI_GATEWAY_TIMEOUT (504)')), false);

assert.equal(mustNotDemoteToolPlaneToChat(true), true);
assert.equal(mustNotDemoteToolPlaneToChat(false), false);


assert.equal(
  contentLooksLikeLeakedRoleInfraFailure('coder 실패: OWUI_GATEWAY_TIMEOUT (504)'),
  true,
);
assert.equal(contentLooksLikeLeakedRoleInfraFailure('파일을 수정했습니다.'), false);

const wrapped = wrapAsInfraError(new Error('HTTP 504'));
assert.ok(wrapped instanceof AgentInfraError);
assert.equal(wrapped.failureClass, 'infra');

assert.match(TOOL_PLANE_NO_WORKSPACE_REFUSAL, /작업 폴더/);
assert.equal(
  isNoWorkspaceBoundError(new Error('이 대화에는 연결된 작업 폴더가 없습니다. 노트북에서…')),
  true,
);
assert.equal(isNoWorkspaceBoundError(new Error('OWUI_GATEWAY_TIMEOUT (504)')), false);

{
  const body = formatToolPlaneFailureAssistant({
    formattedError: 'OWUI_GATEWAY_TIMEOUT (504)',
    mutatedPaths: ['app.js'],
    kind: 'infra',
  });
  assert.match(body, /AI 공급자 오류/);
  assert.match(body, /app\.js/);
  assert.match(body, /자동 재시도를 모두 수행했지만 복구되지 않았습니다/);
  assert.equal(toolPlaneInfraRetryLimit({}), 2);
  assert.equal(toolPlaneInfraRetryLimit({ MY_AGENT_TOOL_PLANE_INFRA_RETRIES: '4' }), 4);
  assert.equal(toolPlaneAutoResumeLimit({}), 0);
  assert.equal(toolPlaneAutoResumeLimit({ MY_AGENT_TOOL_PLANE_AUTO_RESUME: '2' }), 2);
  assert.equal(shouldAutoResumeAfterInfra({ mutatedPaths: ['a.ts'] }), true);
  assert.equal(shouldAutoResumeAfterInfra({ readPaths: ['a.ts'] }), true);
  assert.equal(
    shouldAutoResumeAfterInfra({}),
    false,
    'empty meta must not auto-resume (infra retries cover cold 504)',
  );
}

{
  const body = formatToolPlaneFailureAssistant({
    formattedError: 'Code agent exceeded 45 LLM orchestration rounds (not tool calls).',
    kind: 'other',
  });
  assert.doesNotMatch(body, /자동 재시도/);
  assert.doesNotMatch(body, /요청을 더 짧게 나눠/);
  assert.match(body, /이어서 진행/);
}

{
  const { shrinkMessagesForInfraRetry, estimateChatPayloadChars } = await import(
    '../core/dist/agent/agent-run-helpers.js'
  );
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'do it' },
    {
      role: 'tool',
      tool_call_id: '1',
      content: `path=old.js\n${'x'.repeat(20_000)}`,
    },
    {
      role: 'tool',
      tool_call_id: '2',
      content: `path=new.js\n${'y'.repeat(8_000)}`,
    },
  ];
  const before = estimateChatPayloadChars(msgs);
  const dropped = shrinkMessagesForInfraRetry(msgs, { keepRecentToolTurns: 1, maxToolChars: 2_000 });
  assert.ok(dropped > 0);
  assert.ok(estimateChatPayloadChars(msgs) < before);
  assert.match(String(msgs[2].content), /tool stub/);
  assert.ok(String(msgs[3].content).length <= 2_200);
}

{
  const {
    synthesizeAnswerFromToolResults,
    looksLikeInspectToolDump,
    contentIsInspectAnswerSynthFailure,
    compressToolBlockForAnswer,
    INSPECT_ANSWER_SYNTH_FAIL_MARKER,
  } = await import('../core/dist/agent/agent-llm-step.js');
  assert.equal(
    looksLikeInspectToolDump('[read_file meta] path=styles.css lines=168 bytes=6263\n:root {'),
    true,
  );
  const dump = synthesizeAnswerFromToolResults([
    {
      role: 'tool',
      content:
        '[read_file meta] path=styles.css lines=168 bytes=6263\n' + ':root {\n  color: red;\n}\n'.repeat(80),
    },
  ]);
  assert.equal(dump.includes(':root {'), false, 'must not dump CSS body');
  assert.match(dump, /모델의 최종 답변을 받지 못했습니다/);
  assert.match(dump, /로컬 런타임이 이를 작업 보고서로 재작성하지 않았습니다/);
  assert.ok(dump.includes(INSPECT_ANSWER_SYNTH_FAIL_MARKER));
  assert.equal(contentIsInspectAnswerSynthFailure(dump), true);
  const mutateFallback = synthesizeAnswerFromToolResults([
    { role: 'tool', content: 'Wrote app.js (100 bytes)' },
  ]);
  assert.match(mutateFallback, /모델의 최종 답변을 받지 못했습니다/);
  assert.doesNotMatch(mutateFallback, /파일 저장 완료|변경 파일|진단 통과/);
  const compressed = compressToolBlockForAnswer(
    '[read_file meta] path=ui/workspace/src/store/workspaceStore.ts lines=900\n' + 'x'.repeat(5000),
  );
  assert.match(compressed, /read_file summary/);
  assert.match(compressed, /workspaceStore\.ts/);
  assert.ok(compressed.length < 3000, 'answer path must shrink inspect dumps');
}

{
  const { truncateToolResultForLlm } = await import('../core/dist/agent/agent-run-helpers.js');
  const dump =
    '[read_file meta] path=core/src/foo.ts lines=40\n' + 'const x = 1;\n'.repeat(500);
  const out = truncateToolResultForLlm(dump, 'read_file');
  assert.equal(out, dump, 'read_file content under the context budget stays intact');

  const jsonBig = JSON.stringify({
    ok: true,
    path: 'a.js',
    blob: 'z'.repeat(20_000),
  });
  const jsonOut = truncateToolResultForLlm(jsonBig, 'write_file', { maxChars: 2_000 });
  assert.ok(jsonOut.length <= 2_200);
  assert.match(jsonOut, /"ok":true|"ok": true/);
}

console.log('verify-failure-plane: ok');
