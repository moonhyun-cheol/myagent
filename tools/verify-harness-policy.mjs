#!/usr/bin/env node
/**
 * Harness policy + chat completion body extras (OWUI IQ redesign).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const stepLoopSource = readFileSync(
  new URL('../core/src/agent/agent-run-step-loop.ts', import.meta.url),
  'utf8',
);
const runTypesSource = readFileSync(
  new URL('../core/src/agent/agent-run-types.ts', import.meta.url),
  'utf8',
);
const contextAssemblerSource = readFileSync(
  new URL('../core/src/agent/agent-context-assembler.ts', import.meta.url),
  'utf8',
);
const todoToolSource = readFileSync(
  new URL('../core/src/agent/agent-tool-definitions.ts', import.meta.url),
  'utf8',
);
const readThroughSource = readFileSync(
  new URL('../core/src/agent/agent-read-through-cache.ts', import.meta.url),
  'utf8',
);
const runLoopSource = readFileSync(
  new URL('../core/src/agent/agent-run-loop.ts', import.meta.url),
  'utf8',
);

assert.match(
  runTypesSource,
  /export const MAX_AGENT_STEPS = 100;/,
  'MAX_AGENT_STEPS must be the declared orchestration-step ceiling',
);
for (const source of [runTypesSource, runLoopSource, stepLoopSource]) {
  assert.doesNotMatch(
    source,
    /MAX_PROGRESSIVE_TOTAL_ROUNDS|MAX_PROGRESSIVE_STAGES|PROGRESSIVE_STAGE_ROUNDS|normalizeProgressiveMaxSteps|progressiveRunBudget/,
    'retired progressive budget authorities must not return',
  );
}
assert.match(contextAssemblerSource, /prepareAgentContextForRequest/);
assert.match(stepLoopSource, /forceRebuild: state\.steps === 1 && state\.priorSteps > 0/);
assert.doesNotMatch(stepLoopSource, /formatAgentProgressCheckpoint|recordSessionProgressCheckpoint/);
assert.doesNotMatch(stepLoopSource, /shrinkMessagesForInfraRetry/);
assert.match(readThroughSource, /selection_required/);
assert.match(readThroughSource, /text:\s*status === 'exact' \? sliced\.text : ''/);
assert.match(todoToolSource, /name: 'todo_update'/);
assert.match(todoToolSource, /retainEvidence/);
assert.doesNotMatch(todoToolSource, /dropEvidence|discardEvidence/);

assert.doesNotMatch(
  stepLoopSource,
  /PROSE_FORCED_TOOL_RETRY/,
  'prose-pattern tool forcing must stay retired',
);
assert.match(stepLoopSource, /toolChoice: 'auto' as const/, 'native tools stay model-selected');
assert.doesNotMatch(
  stepLoopSource,
  /toolChoice:\s*\(preferToolsFirst\s*\?\s*'required'/,
  'first code turn must not force tool_choice=required',
);
assert.doesNotMatch(stepLoopSource, /· 도구 재요청/, 'no prose-driven tool retry round trip');

const {
  loadHarnessPolicy,
  resolveReasoningEffort,
  resolveCodeReasoningEffort,
  resolveCodeReasoningEffortForModel,
  resolveSessionReasoningEffort,
  resolveOwuiProtocolMode,
  resolveCodeOwuiProtocolMode,
  owuiPrefersClientToolProtocol,
  harnessCompletionExtras,
  modelRejectsReasoningEffort,
  ollamaAllowedForCodeAgent,
  ollamaEmergencyFallbackEnabled,
} = await import('../core/dist/providers/harness-policy.js');
const {
  buildChatCompletionBody,
  shouldFallbackToClientToolProtocol,
} = await import('../core/dist/providers/openai-compatible.js');
const {
  DEFAULT_AGENT_READ_PARALLELISM,
  MAX_AGENT_READ_PARALLELISM,
  isParallelReadOnlyTool,
  resolveAgentReadParallelism,
  runParallelToolCalls,
} = await import('../core/dist/agent/agent-tool-parallel.js');
const { formatChatErrorMessage } = await import('../core/dist/debug-session-log.js');
const { formatExitGateToolNudge } = await import('../core/dist/agent/agent-claim-gates.js');
const { getHistoryTurns, applyHistoryContentBudget } = await import(
  '../core/dist/chat/history-budget.js',
);
const { prefersClientToolProtocol } = await import('../core/dist/agent/agent-tool-protocol.js');

function withEnv(patch, fn) {
  const prev = {};
  for (const k of Object.keys(patch)) {
    prev[k] = process.env[k];
    const v = patch[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(patch)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

// defaults
{
  withEnv(
    {
      MY_AGENT_REASONING_EFFORT: undefined,
      MY_AGENT_HISTORY_TURNS: undefined,
      MY_AGENT_OWUI_PROTOCOL: undefined,
      MY_AGENT_OWUI_TEXT_TOOLS: undefined,
    },
    () => {
      assert.equal(resolveReasoningEffort(), null);
      assert.equal(
        resolveCodeReasoningEffort({}),
        null,
        'unset effort leaves the provider/model in control',
      );
      assert.equal(
        resolveCodeReasoningEffortForModel({}, { modelId: 'gpt-5.6-sol-pro' }),
        null,
        'model labels do not silently force an effort',
      );
      assert.equal(
        resolveCodeReasoningEffortForModel(
          { MY_AGENT_REASONING_EFFORT: 'high' },
          { modelId: 'gpt-5.6-sol-pro' },
        ),
        'high',
        'explicit operator effort still wins for pro endpoints',
      );
      assert.equal(
        resolveCodeReasoningEffort({ MY_AGENT_REASONING_EFFORT: 'high' }),
        'high',
        'explicit operator effort is preserved',
      );
      assert.equal(getHistoryTurns(), 40);
      assert.equal(resolveOwuiProtocolMode(), 'text');
      assert.equal(resolveCodeOwuiProtocolMode(), 'api', 'code OWUI default native tools');
      assert.equal(
        owuiPrefersClientToolProtocol('custom', { custom: true }),
        true,
        'OWUI global default TEXT',
      );
      assert.equal(
        owuiPrefersClientToolProtocol('custom', { custom: true }, process.env, true),
        false,
        'OWUI code path starts native tools by default',
      );
      assert.equal(
        prefersClientToolProtocol('custom', { kind: 'openai_compatible', custom: true }),
        false,
        'code-agent OWUI starts native tools',
      );
      assert.equal(
        prefersClientToolProtocol('custom', { kind: 'openai_compatible', custom: true }, {
          forCodeAgent: false,
        }),
        true,
        'non-code OWUI still TEXT',
      );
      assert.equal(
        prefersClientToolProtocol('openai', { kind: 'openai_compatible' }),
        false,
      );
    },
  );
}

// code OWUI: native default; Safe TEXT remains an explicit compatibility override
{
  withEnv(
    {
      MY_AGENT_CODE_OWUI_PROTOCOL: 'probe',
      MY_AGENT_OWUI_PROTOCOL: 'probe',
      MY_AGENT_CODE_ALLOW_OWUI_NATIVE_TOOLS: undefined,
    },
    () => {
      assert.equal(resolveCodeOwuiProtocolMode(), 'probe', 'probe opt-in');
      assert.equal(
        owuiPrefersClientToolProtocol('custom', { custom: true }, process.env, true),
        false,
      );
    },
  );
  withEnv(
    {
      MY_AGENT_CODE_ALLOW_OWUI_NATIVE_TOOLS: '0',
      MY_AGENT_CODE_OWUI_PROTOCOL: 'probe',
      MY_AGENT_OWUI_TEXT_TOOLS: undefined,
    },
    () => {
      assert.equal(resolveCodeOwuiProtocolMode(), 'text', 'ALLOW=0 forces TEXT');
      assert.equal(
        owuiPrefersClientToolProtocol('custom', { custom: true }, process.env, true),
        true,
      );
    },
  );
  withEnv(
    {
      MY_AGENT_CODE_OWUI_PROTOCOL: 'text',
      MY_AGENT_CODE_ALLOW_OWUI_NATIVE_TOOLS: '1',
    },
    () => {
      assert.equal(resolveCodeOwuiProtocolMode(), 'text', 'explicit PROTOCOL=text');
    },
  );
}

// session reasoning is independent from Responses summary requests
{
  assert.equal(
    resolveSessionReasoningEffort('auto', {}, { providerId: 'openai', modelId: 'gpt-5.6-sol' }),
    null,
    'auto omits effort so the provider/model owns its reasoning budget',
  );
  assert.equal(
    resolveSessionReasoningEffort('low', {}, { providerId: 'openai', modelId: 'gpt-5.6-sol' }),
    'low',
    'an explicit session effort is preserved',
  );
  assert.equal(
    resolveSessionReasoningEffort(
      'low',
      { MY_AGENT_REASONING_EFFORT: 'high' },
      { providerId: 'openai', modelId: 'gpt-5.6-sol' },
    ),
    'high',
    'an explicit operator override still wins',
  );
  assert.equal(
    resolveSessionReasoningEffort(
      'high',
      {},
      { providerId: 'custom', modelId: 'qwen2.5:7b' },
    ),
    null,
    'unsupported models still omit effort',
  );
}

// reasoning off
{
  withEnv({ MY_AGENT_REASONING_EFFORT: 'off' }, () => {
    assert.equal(resolveReasoningEffort(), null);
    assert.deepEqual(harnessCompletionExtras(), {});
  });
}

// omit reasoning_effort for ollama / qwen2.5
{
  withEnv({ MY_AGENT_REASONING_EFFORT: 'high' }, () => {
    assert.equal(modelRejectsReasoningEffort('qwen2.5:7b'), true);
    assert.equal(modelRejectsReasoningEffort('qwen2.5-thinking'), false);
    assert.deepEqual(harnessCompletionExtras(process.env, { providerId: 'ollama', modelId: 'llama3' }), {});
    assert.deepEqual(
      harnessCompletionExtras(process.env, { providerId: 'custom', modelId: 'qwen2.5:7b' }),
      {},
    );
    assert.deepEqual(
      harnessCompletionExtras(process.env, { providerId: 'openai', modelId: 'gpt-5' }),
      { reasoningEffort: 'high' },
    );
  });
}

// Ollama coding + emergency fallback off by default
{
  withEnv(
    {
      MY_AGENT_ALLOW_OLLAMA_CODE: undefined,
      MY_AGENT_OLLAMA_FALLBACK: undefined,
    },
    () => {
      assert.equal(ollamaAllowedForCodeAgent(), false);
      assert.equal(ollamaAllowedForCodeAgent(process.env, { localOnly: true }), true);
      assert.equal(ollamaEmergencyFallbackEnabled(), false);
    },
  );
  withEnv({ MY_AGENT_ALLOW_OLLAMA_CODE: '1', MY_AGENT_OLLAMA_FALLBACK: '1' }, () => {
    assert.equal(ollamaAllowedForCodeAgent(), true);
    assert.equal(ollamaEmergencyFallbackEnabled(), true);
  });
}

// OWUI probe/api
{
  withEnv({ MY_AGENT_OWUI_PROTOCOL: 'probe' }, () => {
    assert.equal(resolveOwuiProtocolMode(), 'probe');
    assert.equal(owuiPrefersClientToolProtocol('custom', { custom: true }), false);
  });
  withEnv({ MY_AGENT_OWUI_PROTOCOL: 'api', MY_AGENT_OWUI_TEXT_TOOLS: '1' }, () => {
    assert.equal(resolveOwuiProtocolMode(), 'text', 'TEXT_TOOLS forces text');
  });
}

// body merge + native parallel tool-call request
{
  const body = buildChatCompletionBody(
    {
      model: 'm',
      messages: [],
      stream: false,
      tools: [{ type: 'function', function: { name: 'read_file', parameters: {} } }],
    },
    {
      reasoningEffort: 'high',
      extraBody: { temperature: 0.2 },
      parallelToolCalls: true,
    },
  );
  assert.equal(body.reasoning_effort, 'high');
  assert.equal(body.temperature, 0.2);
  assert.equal(body.parallel_tool_calls, true);
  assert.equal(body.model, 'm');
}

// bounded read-only parallelism preserves model tool-call order
{
  assert.equal(DEFAULT_AGENT_READ_PARALLELISM, 4);
  assert.equal(MAX_AGENT_READ_PARALLELISM, 8);
  assert.equal(resolveAgentReadParallelism({ MY_AGENT_READ_PARALLELISM: '99' }), 8);
  assert.equal(resolveAgentReadParallelism({ MY_AGENT_READ_PARALLELISM: '1' }), 1);
  assert.equal(isParallelReadOnlyTool('read_file'), true);
  assert.equal(isParallelReadOnlyTool('apply_patch'), false);

  const calls = [30, 5, 15].map((delay, index) => ({
    id: `call-${index}`,
    type: 'function',
    function: { name: 'read_file', arguments: JSON.stringify({ delay }) },
  }));
  let active = 0;
  let peak = 0;
  const results = await runParallelToolCalls(calls, 2, async (call) => {
    active += 1;
    peak = Math.max(peak, active);
    const { delay } = JSON.parse(call.function.arguments);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active -= 1;
    return { output: call.id };
  });
  assert.equal(peak, 2);
  assert.deepEqual(results.map((row) => row.output), ['call-0', 'call-1', 'call-2']);
}

{
  const raw = 'Code agent exceeded 100 LLM orchestration rounds (not tool calls).';
  const message = formatChatErrorMessage(raw);
  assert.equal(message, raw);
  assert.doesNotMatch(message, /Independent tool calls/);
  assert.doesNotMatch(message, /작업을 더 작은 단위로/);
}

// history content budget
{
  withEnv({ MY_AGENT_HISTORY_ASSISTANT_MAX_CHARS: '500' }, () => {
    const out = applyHistoryContentBudget([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'x'.repeat(800) },
    ]);
    assert.equal(out[0].content, 'hi');
    assert.ok(out[1].content.startsWith('x'.repeat(500)));
    assert.match(out[1].content, /history truncated/);
    assert.ok(out[1].content.length > 500);
  });
}

// probe timeout → TEXT fallback
assert.equal(shouldFallbackToClientToolProtocol('AbortError: timed out'), true);
assert.equal(shouldFallbackToClientToolProtocol('headers timeout'), true);
assert.equal(shouldFallbackToClientToolProtocol('Tool not found'), true);
assert.equal(shouldFallbackToClientToolProtocol('Unknown tool: Foo'), true);

// code OWUI native default; probe compatibility mode; Safe TEXT via ALLOW=0
{
  assert.equal(resolveCodeOwuiProtocolMode({}), 'api');
  assert.equal(
    resolveCodeOwuiProtocolMode({ MY_AGENT_CODE_OWUI_PROTOCOL: 'probe' }),
    'probe',
    'probe is opt-in native path',
  );
  assert.equal(
    resolveCodeOwuiProtocolMode({
      MY_AGENT_CODE_ALLOW_OWUI_NATIVE_TOOLS: '0',
      MY_AGENT_CODE_OWUI_PROTOCOL: 'probe',
    }),
    'text',
  );
}

// exit-gate nudge shape
{
  const n = formatExitGateToolNudge({
    gate: 'diagnostics pass',
    toolName: 'run_diagnostics',
    args: {},
  });
  assert.match(n, /EXIT_GATE/);
  assert.match(n, /TOOL_CALL:/);
  assert.match(n, /run_diagnostics/);
}

// Autopilot default off; env on
{
  withEnv({ MY_AGENT_AUTOPILOT: undefined }, () => {
    assert.equal(loadHarnessPolicy().autopilot, false);
  });
  withEnv({ MY_AGENT_AUTOPILOT: '1' }, () => {
    assert.equal(loadHarnessPolicy().autopilot, true);
  });
}

{
  const {
    looksLikeAutopilotContinue,
    resolveAutopilotEnabled,
    shouldOrInContinuityAutopilot,
  } = await import('../core/dist/agent/agent-autopilot.js');
  const { formatAcceptanceScenarioSystemNote } = await import(
    '../core/dist/agent/agent-planner.js'
  );
  assert.equal(looksLikeAutopilotContinue('다음 조치 실행'), true);
  assert.equal(looksLikeAutopilotContinue('니가 알아서 다음 단계 실행'), true);
  assert.equal(resolveAutopilotEnabled({ MY_AGENT_AUTOPILOT: '0' }, true), true, 'user override wins');
  assert.equal(resolveAutopilotEnabled({ MY_AGENT_AUTOPILOT: '1' }, false), false);
  assert.equal(resolveAutopilotEnabled({ MY_AGENT_AUTOPILOT: '1' }, null), true);
  const { buildAgentContinuationSnapshot } = await import(
    '../core/dist/agent/agent-continuation-snapshot.js'
  );
  const { MAX_AGENT_STEPS } = await import('../core/dist/agent/agent-run-types.js');
  assert.equal(MAX_AGENT_STEPS, 100);
  const snapshot = buildAgentContinuationSnapshot({
    step: 13,
    elapsedMs: 125_000,
    payloadChars: 32_768,
    model: 'OpenAI/gpt-test',
    todoLedger: {
      version: 1,
      todos: [{ id: 'T1', text: '루프 복구', status: 'doing', evidenceRefs: ['ev-1'], nextAction: '테스트 통과' }],
      retainEvidence: [{ evidenceId: 'ev-1', form: 'exact', todoId: 'T1' }],
      workingNotes: [],
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    evidenceRefs: ['ev-1'],
    readPaths: ['src/a.ts'],
    mutatedPaths: ['src/a.ts'],
    unresolvedFailures: ['edit_file: atomic_abort'],
    lastModelOutput: '모델이 작성한 실제 작업 내용',
    now: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(snapshot.step, 13);
  assert.equal(snapshot.todoLedger?.todos[0]?.nextAction, '테스트 통과');
  assert.deepEqual(snapshot.evidenceRefs, ['ev-1']);
  assert.equal(snapshot.model, 'OpenAI/gpt-test');
  assert.equal(snapshot.elapsedMs, 125_000);
  assert.equal(snapshot.payloadChars, 32_768);
  assert.equal(snapshot.lastModelOutput, '모델이 작성한 실제 작업 내용');
  assert.equal(
    resolveAutopilotEnabled({ MY_AGENT_AUTOPILOT: '0' }, null, '인앱 브라우저 ChatPane 링크 연결 구현'),
    false,
    'message wording must not enable autopilot',
  );
  assert.equal(
    resolveAutopilotEnabled(
      { MY_AGENT_AUTOPILOT: '0' },
      null,
      'app.js에 주석 한 줄 추가해줘',
      { codeSession: true },
    ),
    false,
    'code-session wording must not enable autopilot',
  );
  assert.equal(
    resolveAutopilotEnabled(
      { MY_AGENT_AUTOPILOT: '0' },
      null,
      'app.js에 주석 한 줄 추가해줘',
      { codeSession: false },
    ),
    false,
    'non-codeSession does not enable CODE autopilot',
  );
  assert.equal(
    resolveAutopilotEnabled(
      { MY_AGENT_AUTOPILOT: '0' },
      null,
      '이 코드 구조 설명해줘',
      { codeSession: true },
    ),
    false,
    'explain/report tasks stay off CODE autopilot',
  );
  const { buildTaskChecklist, isTaskChecklistComplete } = await import(
    '../core/dist/agent/agent-task-checklist.js'
  );
  {
    const cl = buildTaskChecklist('처음부터 public/a.js public/b.js 만들어줘');
    assert.equal(
      isTaskChecklistComplete({
        checklist: cl,
        workspaceRoot: process.cwd(),
        mutatedPaths: ['public/a.js'],
        toolsUsed: ['write_file'],
      }),
      false,
      'incomplete multi-path',
    );
  }
  assert.equal(
    shouldOrInContinuityAutopilot({
      currentlyEnabled: false,
      sessionContinuity: true,
      optsAutopilot: false,
      env: {},
    }),
    false,
    'Manager Safe lock blocks OR-in',
  );
  assert.match(formatAcceptanceScenarioSystemNote(), /Acceptance scenario/);
  assert.match(formatAcceptanceScenarioSystemNote(), /inAppBrowser\.open/);
  const { formatAgenticLoopSystemNote, formatPatchFormatConstraints } = await import(
    '../core/dist/agent/agent-planner.js'
  );
  assert.match(formatAgenticLoopSystemNote(), /Planner|Executor|Verify/i);
  assert.ok(formatAgenticLoopSystemNote().length < 900, 'agentic loop note must stay lean');
  assert.match(formatPatchFormatConstraints(), /Begin Patch|atomic/i);
}

// history compress + model context budgets
{
  const { applyHistoryContextCompress, applyHistoryContentBudget, getHistoryTurns } = await import(
    '../core/dist/chat/history-budget.js',
  );
  const {
    resolveModelContextLength,
    resolveContextBudgets,
    usedContextLimitsFallback,
    getContextLimitMismatch,
    rememberRemoteModelContext,
    DEFAULT_CONTEXT_LENGTH,
    DEFAULT_RESERVE_TOKENS,
    clearRemoteModelContextCache,
  } = await import('../core/dist/providers/model-context-limits.js');
  const { parseRemoteModels } = await import('../core/dist/providers/openai-compatible.js');
  const { projectEvidenceForModel } = await import('../core/dist/agent/agent-run-helpers.js');
  const { softRpmLimit, softStepLatencyWarnMs } = await import(
    '../core/dist/providers/harness-policy.js'
  );

  withEnv(
    {
      MY_AGENT_HISTORY_KEEP_RECENT: '4',
      MY_AGENT_HISTORY_COMPRESS_CHARS: '800',
    },
    () => {
      const policy = loadHarnessPolicy();
      assert.equal(policy.historyKeepRecent, 4);
      assert.equal(policy.historyCompressChars, 800);
    },
  );

  clearRemoteModelContextCache();
  assert.equal(resolveModelContextLength('openai/gpt-5.6-sol'), 1_000_000);
  assert.equal(
    resolveModelContextLength('open_webui_openrouter_integration.openai.gpt-5.6-sol-pro'),
    1_000_000,
  );
  assert.equal(resolveModelContextLength('totally-unknown-model-xyz'), DEFAULT_CONTEXT_LENGTH);
  assert.equal(usedContextLimitsFallback('totally-unknown-model-xyz'), true);
  assert.equal(usedContextLimitsFallback('openai/gpt-5.6-sol'), false);

  const sol = resolveContextBudgets('openai/gpt-5.6-sol');
  const base = resolveContextBudgets(null);
  assert.ok(sol.reserveTokens >= DEFAULT_RESERVE_TOKENS);
  assert.equal(sol.effectiveContextLength, sol.contextLength - sol.reserveTokens);
  assert.equal(sol.limitsFallback, false);
  assert.equal(base.limitsFallback, true);
  assert.ok(sol.historyTurns > base.historyTurns, 'sol should scale turns above 128k baseline');
  assert.ok(sol.toolResultMaxChars > base.toolResultMaxChars);
  assert.equal(getHistoryTurns(process.env, { modelId: 'openai/gpt-5.6-sol' }), sol.historyTurns);
  assert.equal(getHistoryTurns(), 40);

  const debited = resolveContextBudgets('openai/gpt-5.6-sol', process.env, {
    visionImageCount: 3,
    attachmentChars: 5_000,
  });
  assert.ok(
    debited.historyCompressChars < sol.historyCompressChars,
    'vision/attach debit must shrink compress budget',
  );

  rememberRemoteModelContext('openai/gpt-5.6-sol', 200_000);
  const mismatch = getContextLimitMismatch('openai/gpt-5.6-sol');
  assert.ok(mismatch && /context_limit_mismatch/.test(mismatch.note));
  clearRemoteModelContextCache();

  withEnv({ MY_AGENT_SOFT_RPM: '30', MY_AGENT_SOFT_STEP_LATENCY_MS: '90000' }, () => {
    assert.equal(softRpmLimit(), 30);
    assert.equal(softStepLatencyWarnMs(), 90_000);
  });
  assert.equal(softRpmLimit({}), null);

  const longHist = [];
  for (let i = 0; i < 12; i++) {
    longHist.push({ role: 'user', content: `u${i} ${'질문내용입니다 '.repeat(20)}` });
    longHist.push({ role: 'assistant', content: `a${i} ${'답변내용입니다 '.repeat(20)}` });
  }
  const compressed = applyHistoryContextCompress(longHist, {
    MY_AGENT_HISTORY_KEEP_RECENT: '4',
    MY_AGENT_HISTORY_COMPRESS_CHARS: '500',
  });
  assert.ok(compressed.length < longHist.length, 'compress folds older turns');
  assert.match(compressed[0].content, /history compress/);
  assert.equal(compressed[compressed.length - 1].role, 'assistant');

  const budgeted = applyHistoryContentBudget(
    [{ role: 'assistant', content: 'x'.repeat(900) }],
    { MY_AGENT_HISTORY_ASSISTANT_MAX_CHARS: '500' },
  );
  assert.match(budgeted[0].content, /history truncated/);

  const parsed = parseRemoteModels({
    data: [
      { id: 'openai/gpt-5.6-sol', context_length: 1_000_000 },
      { id: 'other', meta: { context_window: 200_000 } },
    ],
  });
  assert.equal(parsed.find((m) => m.id === 'openai/gpt-5.6-sol')?.context_length, 1_000_000);
  assert.equal(parsed.find((m) => m.id === 'other')?.context_length, 200_000);

  const inspectDump =
    '[read_file meta] path=styles.css lines=168\n' + ':root { color: red; }\n'.repeat(400);
  const evidence = {
    version: 1,
    evidenceId: 'ev_harness_1',
    runId: 'harness',
    tool: 'read_file',
    args: { path: 'styles.css' },
    complete: true,
    fingerprint: 'a'.repeat(64),
    ok: true,
    at: new Date(0).toISOString(),
    bytes: Buffer.byteLength(inspectDump),
    bodyFile: 'data/evidence-runs/harness/ev_harness_1.txt',
    observedByModel: false,
  };
  const projected = projectEvidenceForModel(evidence, inspectDump);
  assert.match(projected, /:root \{ color: red; \}/, 'evidence under the context budget stays exact');
  assert.match(projected, /ev_harness_1/);
}

console.log('verify-harness-policy: ok');
