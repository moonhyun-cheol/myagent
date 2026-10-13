#!/usr/bin/env node
/**
 * ADR-008 failure plane — infra ≠ answer; no tool-plane demotion.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  withFailureModelLine,
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
    new Error('Code agent exceeded 100 LLM orchestration rounds (not tool calls).'),
  ),
  true,
);
assert.equal(isAgentExecutionLimit(new Error('Code agent exceeded 100 tool steps')), true);
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
    formattedError: 'Code agent exceeded 100 LLM orchestration rounds (not tool calls).',
    kind: 'other',
  });
  assert.doesNotMatch(body, /자동 재시도/);
  assert.doesNotMatch(body, /요청을 더 짧게 나눠/);
  assert.match(body, /이어서 진행/);
}

{
  // Failure / stop copy names the model that was running.
  const withModel = formatToolPlaneFailureAssistant({
    formattedError: 'RESPONSES_HTTP_402: Provider returned error',
    kind: 'other',
    model: 'OpenRouter/anthropic/claude-opus-5.5',
  });
  assert.match(withModel, /작업 모델: OpenRouter\/anthropic\/claude-opus-5\.5/);
  const stopped = formatToolPlaneFailureAssistant({
    formattedError: '(중지됨)',
    kind: 'stopped',
    model: 'OpenRouter/openai/gpt-6-astra',
  });
  assert.match(stopped, /작업 모델: OpenRouter\/openai\/gpt-6-astra/);
  for (const placeholder of [undefined, '', 'none', 'policy/tool-plane-failure']) {
    const body = formatToolPlaneFailureAssistant({ formattedError: 'x', kind: 'other', model: placeholder });
    assert.doesNotMatch(body, /작업 모델/);
  }
  const orchestrator = readFileSync(
    new URL('../core/src/chat/chat-orchestrator.ts', import.meta.url),
    'utf8',
  );
  assert.match(orchestrator, /model: runModel \?\? 'policy\/tool-plane-failure'/);
  assert.match(orchestrator, /model: opts\.model \|\| 'policy\/tool-plane-failure'/);

  // General (non-agent) chat stream errors also name the model.
  assert.equal(
    withFailureModelLine('RESPONSES_HTTP_402', 'OpenRouter/anthropic/claude-opus-5.5'),
    'RESPONSES_HTTP_402\n작업 모델: OpenRouter/anthropic/claude-opus-5.5',
  );
  for (const placeholder of [undefined, '', 'none', 'policy/x']) {
    assert.equal(withFailureModelLine('err', placeholder), 'err');
  }
  assert.match(orchestrator, /message: withFailureModelLine\(baseMsg, failModel\)/);
  assert.match(orchestrator, /savePartialAssistant\(sessionId, streamedPartial, routing\.mode, failModel \|\| 'stopped'\)/);

  // One-shot modes (image / research / video): the model rides on the thrown error.
  const { tagFailureModel, failureModelFromError } = await import('../core/dist/agent/agent-failure-plane.js');
  const tagged = tagFailureModel(new Error('IMAGE_BACKEND_FAILED'), 'OpenRouter/google/gemini-3-pro-image');
  assert.equal(failureModelFromError(tagged), 'OpenRouter/google/gemini-3-pro-image');
  assert.equal(Object.keys(tagged).length, 0, 'tag must stay non-enumerable');
  assert.equal(tagFailureModel(tagged, 'other/model') === tagged, true);
  assert.equal(failureModelFromError(tagged), 'OpenRouter/google/gemini-3-pro-image', 'first (inner) tag wins');
  assert.equal(failureModelFromError(tagFailureModel(new Error('x'), 'policy/x')), '');
  assert.equal(failureModelFromError(tagFailureModel(new Error('x'), undefined)), '');
  assert.equal(tagFailureModel('plain', 'm'), 'plain');
  assert.equal(failureModelFromError('plain'), '');
  assert.match(orchestrator, /throw tagFailureModel\(e, runningModel\)/);
  assert.match(orchestrator, /message: withFailureModelLine\(msg, oneShotFailModel\)/);
  assert.match(orchestrator, /withFailureModelLine\(formatChatErrorMessage\(e\), videoFailModel\)/);
  const imageGen = readFileSync(new URL('../core/src/chat/modes/image-gen.ts', import.meta.url), 'utf8');
  assert.match(imageGen, /withFailureModelLine\(owuiFail \?\? '[^']+', resolved\.display\)/);
  const videoGen = readFileSync(new URL('../core/src/chat/modes/video-gen.ts', import.meta.url), 'utf8');
  assert.match(videoGen, /withFailureModelLine\(msg, model\.id\)/);
}

{
  // Failure / stop copy names the model that was running.
  const withModel = formatToolPlaneFailureAssistant({
    formattedError: 'RESPONSES_HTTP_402: Provider returned error',
    kind: 'other',
    model: 'OpenRouter/anthropic/claude-opus-5.5',
  });
  assert.match(withModel, /\uC791\uC5C5 \uBAA8\uB378: OpenRouter\/anthropic\/claude-opus-5\.5/);
  const stopped = formatToolPlaneFailureAssistant({
    formattedError: '(stopped)',
    kind: 'stopped',
    model: 'OpenRouter/openai/gpt-6-astra',
  });
  assert.match(stopped, /\uC791\uC5C5 \uBAA8\uB378: OpenRouter\/openai\/gpt-6-astra/);
  for (const placeholder of [undefined, '', 'none', 'policy/tool-plane-failure']) {
    const body = formatToolPlaneFailureAssistant({ formattedError: 'x', kind: 'other', model: placeholder });
    assert.doesNotMatch(body, /\uC791\uC5C5 \uBAA8\uB378/);
  }
  const orchestrator = readFileSync(
    new URL('../core/src/chat/chat-orchestrator.ts', import.meta.url),
    'utf8',
  );
  assert.match(orchestrator, /model: runModel \?\? 'policy\/tool-plane-failure'/);
  assert.match(orchestrator, /model: opts\.model \|\| 'policy\/tool-plane-failure'/);
}

{
  const helpersSource = readFileSync(
    new URL('../core/src/agent/agent-run-helpers.ts', import.meta.url),
    'utf8',
  );
  const llmStepSource = readFileSync(
    new URL('../core/src/agent/agent-llm-step.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(helpersSource, /shrinkMessagesForInfraRetry|infra-retry truncate/);
  assert.doesNotMatch(llmStepSource, /synthesizeAnswerFromToolResults|compressToolBlockForAnswer/);
  assert.match(llmStepSource, /caller supplies a phase=final Context View/);
}

{
  const { projectEvidenceForModel } = await import('../core/dist/agent/agent-run-helpers.js');
  const dump =
    '[read_file meta] path=core/src/foo.ts lines=40\n' + 'const x = 1;\n'.repeat(500);
  const baseRecord = {
    version: 1,
    evidenceId: 'ev_failure_1',
    runId: 'failure-plane',
    tool: 'read_file',
    args: { path: 'core/src/foo.ts' },
    complete: true,
    fingerprint: 'b'.repeat(64),
    ok: true,
    at: new Date(0).toISOString(),
    bytes: Buffer.byteLength(dump),
    bodyFile: 'data/evidence-runs/failure-plane/ev_failure_1.txt',
    observedByModel: false,
  };
  const exact = projectEvidenceForModel(baseRecord, dump);
  assert.match(exact, /const x = 1;/, 'evidence under the context budget stays exact');

  const uniqueTail = 'MUST_NOT_LEAK_PARTIAL_BODY';
  const oversized = `${'z'.repeat(20_000)}${uniqueTail}`;
  const projected = projectEvidenceForModel(
    { ...baseRecord, evidenceId: 'ev_failure_2', bytes: Buffer.byteLength(oversized) },
    oversized,
    { maxChars: 2_000 },
  );
  const doc = JSON.parse(projected);
  assert.equal(doc.status, 'selection_required');
  assert.equal(doc.complete, false);
  assert.deepEqual(doc.returnedRanges, []);
  assert.match(projected, /evidence_read/);
  assert.doesNotMatch(projected, new RegExp(uniqueTail));
}

{
  const { readWorkspaceFileThroughCache } = await import(
    '../core/dist/agent/agent-read-through-cache.js'
  );
  const root = mkdtempSync(path.join(os.tmpdir(), 'my-agent-large-read-'));
  try {
    const source = Array.from({ length: 6000 }, (_, index) => `line-${index + 1}-${'x'.repeat(48)}`).join('\n');
    writeFileSync(path.join(root, 'large.txt'), source, 'utf8');
    const selection = readWorkspaceFileThroughCache({
      workspaceRoot: root,
      relPath: 'large.txt',
    });
    assert.equal(selection.status, 'selection_required');
    assert.equal(selection.complete, false);
    assert.equal(selection.text, '', 'selection response must not leak a partial body');
    assert.deepEqual(selection.omitted_ranges, [{ start: 1, end: 6000 }]);

    const lateRange = readWorkspaceFileThroughCache({
      workspaceRoot: root,
      relPath: 'large.txt',
      startLine: 5001,
      endLine: 5010,
    });
    assert.equal(lateRange.status, 'exact');
    assert.equal(lateRange.complete, true);
    assert.match(lateRange.text, /line-5001-/);
    assert.match(lateRange.text, /line-5010-/);

    const tooLarge = readWorkspaceFileThroughCache({
      workspaceRoot: root,
      relPath: 'large.txt',
      startLine: 2000,
      endLine: 5000,
    });
    assert.equal(tooLarge.status, 'range_too_large');
    assert.equal(tooLarge.text, '', 'oversized range must return no partial body');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('verify-failure-plane: ok');
