#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

const runLoop = read('core/src/agent/agent-run-loop.ts');
const stepLoop = read('core/src/agent/agent-run-step-loop.ts');
const mar = read('core/src/agent/agent-mar-runtime.ts');
const approval = read('core/src/agent/approval-auto-review.ts');
const toolApproval = read('core/src/agent/tool-approval.ts');
const orchestrator = read('core/src/chat/chat-orchestrator.ts');
const workspaceAgent = read('core/src/chat/modes/workspace-agent.ts');
const chatFilters = read('core/src/chat/chat-filters.ts');
const automatonIntent = read('core/src/router/automaton-intent.ts');
const failurePlane = read('core/src/agent/agent-failure-plane.ts');
const assistantReply = read('core/src/chat/assistant-reply.ts');
const deepResearchMode = read('core/src/chat/modes/deep-research.ts');
const browserAgentMode = read('core/src/chat/modes/browser-agent.ts');
const workspaceLock = read('core/src/agent/agent-workspace-lock.ts');
const lockedConstraints = read('core/src/agent/agent-locked-constraints.ts');
const sessionContinuity = read('core/src/agent/agent-session-continuity.ts');
const outcomeGate = read('core/src/agent/agent-outcome-gate.ts');
const runMeta = read('core/src/agent/agent-run-meta.ts');
const toolDefinitions = read('core/src/agent/agent-tool-definitions.ts');
const llmStep = read('core/src/agent/agent-llm-step.ts');
const autopilot = read('core/src/agent/agent-autopilot.ts');
const planner = read('core/src/agent/agent-planner.ts');
const runHelpers = read('core/src/agent/agent-run-helpers.ts');
const multimodal = read('core/src/agent/agent-multimodal.ts');
const contextProfile = read('core/src/agent/agent-context-profile.ts');

for (const retired of [
  'core/src/agent/agent-work-mode.ts',
  'core/src/agent/agent-surface-plane.ts',
  'core/src/agent/agent-capability-policy.ts',
  'core/src/agent/outcome-runtime.ts',
  'core/src/router/skill-intent.ts',
  'core/src/router/l1-bypass.ts',
  'core/src/router/l2-similarity.ts',
  'core/src/chat/failure-followup-routing.ts',
  'core/src/router/unified-intent.ts',
  'core/src/router/unified-intent-catalog.ts',
  'core/src/agent/agent-gates.ts',
  'core/src/agent/agent-review-seed.ts',
  'core/src/router/route-task-gate.ts',
  'core/src/router/route-heuristics.ts',
  'core/src/agent/agent-open-gate.ts',
  'core/src/agent/agent-mar-roles.ts',
  'core/src/agent/agent-mar-types.ts',
  'core/src/agent/agent-mar-specialists.ts',
]) {
  assert.equal(existsSync(path.join(root, retired)), false, `${retired} must stay deleted`);
}
for (const source of [runLoop, stepLoop, mar, workspaceAgent]) {
  assert.doesNotMatch(source, /mutationsOverride|filterToolsForWorkMode|AgentWorkMode|SurfacePlane|PROSE_FORCED_TOOL_RETRY|inferToolFromUserMessage/);
}
assert.match(runLoop, /agentTools = await getCodeAgentToolsByPackAsync/);
assert.match(runLoop, /playwrightAvailable \? 'files\+browser' : 'files'/);
assert.doesNotMatch(runLoop, /evaluateTurnStart\(/);
assert.doesNotMatch(runLoop, /evaluateProseTurn\(/);
assert.doesNotMatch(runLoop, /persistConstraintsFromAssistantText\(/);
assert.doesNotMatch(runLoop, /withExecutePriorReviewExpansion\(/);
assert.doesNotMatch(runLoop, /sanitizeFinalAgentContent\(/);
assert.doesNotMatch(runLoop, /rewriteIf(?:SecretaryMapDump|KnowledgeInspectDefer|PendingShellHandoff|ExternalPathDefer)\(/);
assert.match(runLoop, /formatActiveTaskSystemNote\(activeTask\)/);
assert.doesNotMatch(runLoop, /const finalContent = stripToolMimeticNoise/);
assert.match(toolDefinitions, /name: 'active_task'/);
assert.match(runMeta, /The runtime persists and reinjects[\s\S]*never infers it from user prose/);
assert.match(llmStep, /답변 구조와 포함할 정보는 직접 판단하고/);
assert.match(llmStep, /로컬 런타임이 이를 작업 보고서로 재작성하지 않았습니다/);
assert.doesNotMatch(llmStep, /파일 변경 완료 —|파일은 있습니다|경로·변경·다음 조치만/);
for (const source of [autopilot, planner]) {
  assert.doesNotMatch(source, /short Korean summary/);
}

assert.doesNotMatch(stepLoop, /evaluateProseTurn\(/);
assert.doesNotMatch(stepLoop, /contentLooksLikeTokenSalad\(/);
assert.match(stepLoop, /toolChoice: 'auto'/);
assert.doesNotMatch(stepLoop, /work_mode_locked|retrieval_required|autoInvokePendingPlugins|preloadExternalReportGrounding/);
assert.doesNotMatch(stepLoop, /sanitizeToolNotFoundPoison|contentLooksLikeToolNotFoundPoison/);
assert.doesNotMatch(stepLoop, /runWorkspaceDiagnostics\(|runWorkspaceTests\(|ERROR: ALREADY_READ/);
assert.doesNotMatch(runHelpers, /compressInspectToolResult|read_file summary/);
assert.doesNotMatch(multimodal, /runWorkspaceDiagnostics|seedDiagnosticsContext|messageLooksErrorish/);

assert.match(mar, /return runCodeAgent\(opts\)/);
assert.doesNotMatch(mar, /reviewer|critic|VERDICT|openGate/i);

assert.match(approval, /APPROVAL_REVIEW_MODEL_ID = 'openai\/gpt-5\.6-luna'/);
assert.doesNotMatch(approval, /confidence\s*>?=\s*0\.9/);
assert.match(toolApproval, /external_write/);
assert.match(toolApproval, /toolName === 'delete_file'/);
assert.match(toolApproval, /toolName === 'run_terminal'\) return true/);

assert.doesNotMatch(orchestrator, /RouterService|evaluateSpecializedModeFit|messagePrefersBrandSkillOverCode|isCasualChatBypass|TOOL_PLANE_MUTATE_REFUSAL/);
assert.doesNotMatch(orchestrator, /preserveRecentToolFailureContext/);
assert.doesNotMatch(orchestrator, /resolveUnifiedIntent|intent-clarify/);
assert.match(orchestrator, /if \(explicitMode\)/);
assert.match(orchestrator, /peekAutomatonIntent/);
assert.match(automatonIntent, /getSlashAutomatonPatterns/);
assert.doesNotMatch(automatonIntent, /chatCompletion|scoreToolsBySimilarity|resolveAutomatonIntent|intent_phrases|intent_patterns/);
assert.match(orchestrator, /routing\.mode === 'web_dev' && !workspaceAgentAvailable/);
assert.doesNotMatch(workspaceAgent, /looksLikeToolTask|messagePrefersBrandSkillOverCode|looksLikeAcceptanceReviewTask|requiresLiveFsCapability|requiresShellNetCapability/);
assert.match(workspaceAgent, /return Boolean\(sessionRoot \|\| \(scope === 'standalone' && hasDevWorkspace\(configPath\)\)\)/);
assert.doesNotMatch(workspaceAgent, /previousLockedRoot|editorContext: req\.editor_context|setSessionLockedTarget/);
assert.match(workspaceLock, /Only an explicit structured path may narrow/);
assert.doesNotMatch(workspaceLock, /opts\.message|opts\.editorContext|opts\.previousLockedRoot/);
assert.doesNotMatch(lockedConstraints, /inferArtifactContract\(opts\.userMessage\)|looksLikeDirectionReversal\(opts\.userMessage\)/);
assert.doesNotMatch(runLoop, /clearInterruptOpenGateIfFreshBrief|shouldSuppressWorkspaceUiBuildGate|evaluateOutcomeGate/);
assert.doesNotMatch(runLoop, /formatOpenGateSystemNote|openGateBlocksDoneClaim/);
assert.doesNotMatch(mar, /critic_structure_forced_fail|setSessionOpenGate|clearSessionOpenGate/);
assert.match(outcomeGate, /diagnosticsEvidenceStatus/);
assert.doesNotMatch(chatFilters, /contentLooksLikeTokenSalad\(text\)|contentIsReviewEvasion\(text\)|contentLooksLikeChineseProse\(text\)/);
assert.match(chatFilters, /SECRET_PATTERNS/);
assert.match(chatFilters, /redactPatterns/);
assert.doesNotMatch(chatFilters, /HISTORY_POLLUTION_RE|CHINESE_PROSE_MARKERS_RE|userPrefersKoreanReply|contentLooksLikeChineseProse/);
assert.doesNotMatch(chatFilters, /replace\(\/\^\\s\*TOOL_CALL|ERROR:\\s\*WIRING_SMOKE|ANSWER_SYNTH_\[A-Z0-9_\]/);
assert.doesNotMatch(assistantReply, /looksLikeAcceptanceReviewTask|contentIsReviewEvasion|isHistoryPollutionAssistantContent|withReviewEvasionRetry/);
assert.doesNotMatch(deepResearchMode, /evaluateSpecializedModeFit|route-task-gate/);
assert.doesNotMatch(browserAgentMode, /looksLikeProductBuildTask|route-task-gate|로그인\|클릭\|click\|fill/);
assert.doesNotMatch(orchestrator, /appendChatResponseStyle|messageNeedsChatCapabilityBoundary|appendChatCapabilityBoundary|route-heuristics/);
assert.doesNotMatch(failurePlane, /코드 칩/);
assert.throws(() => read('core/src/router/router-service.ts'), /ENOENT/);

const { scrubAgentChannelLeak } = await import('../core/dist/chat/chat-filters.js');
const { stripOwuiImageMarkdown } = await import('../core/dist/image/owui-media.js');
const modelBody = [
  '[P:final_answer]: 핵심 결론',
  '',
  '',
  'TOOL_CALL: 이 문자열을 설명하는 사용자 정보',
  'ERROR: WIRING_SMOKE 원인과 복구 정보',
  'ANSWER_SYNTH_DETAIL 역시 보존',
].join('\n');
const preserved = scrubAgentChannelLeak(modelBody);
assert.match(preserved, /핵심 결론/);
assert.match(preserved, /TOOL_CALL: 이 문자열/);
assert.match(preserved, /ERROR: WIRING_SMOKE/);
assert.match(preserved, /ANSWER_SYNTH_DETAIL/);
assert.match(preserved, /\n\n\n/);
const mixedImages = [
  '![generated](/api/v1/files/abc-123/content)',
  '모델이 제시한 참고 이미지:',
  '![reference](https://example.com/reference.png)',
].join('\n');
const imagePreserved = stripOwuiImageMarkdown(mixedImages);
assert.doesNotMatch(imagePreserved, /api\/v1\/files/);
assert.match(imagePreserved, /모델이 제시한 참고 이미지/);
assert.match(imagePreserved, /!\[reference\]\(https:\/\/example\.com\/reference\.png\)/);

assert.doesNotMatch(contextProfile, /PROFILE_TOOL_ALLOWLIST|agentTools\.filter/);
const { compileAgentStepContext } = await import('../core/dist/agent/agent-context-profile.js');
const allTools = ['read_file', 'apply_patch', 'run_diagnostics', 'run_tests'].map((name) => ({
  type: 'function',
  function: { name, description: `${name} contract fixture`, parameters: { type: 'object' } },
}));
for (const profile of ['orient', 'execute', 'repair', 'verify', 'final']) {
  const sourceMessages = [{ role: 'user', content: '프로필 도구 계약 검사' }];
  const compiled = compileAgentStepContext({
    profile,
    messages: sourceMessages,
    agentTools: allTools,
    userMessage: '프로필 도구 계약 검사',
  });
  assert.strictEqual(compiled.agentTools, allTools, `${profile} must preserve the complete tool schema`);
  assert.deepEqual(
    compiled.toolNames,
    allTools.map((tool) => tool.function.name),
    `${profile} must expose every runtime tool name`,
  );
  assert.deepEqual(
    compiled.messages,
    sourceMessages,
    `${profile} must not inject a synthetic phase/user message`,
  );
}
assert.doesNotMatch(contextProfile, /Native context profile|profileTailNote|phaseInstruction/);

console.log('model-directed runtime contract: PASS');
