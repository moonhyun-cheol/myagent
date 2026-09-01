#!/usr/bin/env node
/**
 * ADR-006 Coding IQ — understanding + execute spine (no live LLM).
 * Proves: mutate intent classification, code OWUI native default, understanding note export,
 * and a real disk edit via executeAgentTool (chat→disk proxy without provider).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { CODE_AGENT_TOOLS } = await import('../core/dist/agent/tools.js');
const { formatUnderstandingCardSystemNote, formatCodingSpineSystemNote } = await import(
  '../core/dist/agent/agent-planner.js'
);
const { resolveCodeOwuiProtocolMode, owuiPrefersClientToolProtocol } = await import(
  '../core/dist/providers/harness-policy.js'
);
const { prefersClientToolProtocol } = await import('../core/dist/agent/agent-tool-protocol.js');
const { executeAgentTool } = await import('../core/dist/agent/agent-tool-execute.js');
const { formatAgentPhaseStatus, formatElapsedDuration } = await import(
  '../core/dist/agent/agent-status-report.js'
);

const toolNames = new Set(CODE_AGENT_TOOLS.map(tool => tool.function.name));
assert.equal(toolNames.has('edit_file'), true);
assert.equal(toolNames.has('apply_patch'), true);

const card = formatUnderstandingCardSystemNote();
assert.match(card, /Understanding Card/);
assert.match(card, /TOOL_CALL|edit_file|apply_patch/);
const spine = formatCodingSpineSystemNote({ autopilot: true, compactUnderstanding: true });
assert.match(spine, /Coding spine/);
assert.match(spine, /Autopilot ON/);
assert.ok(spine.length < card.length, 'spine must be leaner than full Understanding Card');
const compact = formatUnderstandingCardSystemNote({ compact: true });
assert.match(compact, /Coding spine/);
assert.ok(compact.length < card.length, 'compact card must be shorter');

assert.equal(resolveCodeOwuiProtocolMode({}), 'api', 'code OWUI default native tools');
assert.equal(resolveCodeOwuiProtocolMode({ MY_AGENT_CODE_OWUI_PROTOCOL: 'probe' }), 'probe');
assert.equal(
  resolveCodeOwuiProtocolMode({ MY_AGENT_CODE_ALLOW_OWUI_NATIVE_TOOLS: '0' }),
  'text',
  'Safe TEXT when native disabled',
);

// Probe timeout plumbing: stepOpts.timeoutMs must not be discarded (OWUI 25s fix).
{
  const { resolveAgentStepTimeoutMs } = await import('../core/dist/agent/agent-llm-step.js');
  assert.equal(resolveAgentStepTimeoutMs({ timeoutMs: 25_000 }), 25_000);
  assert.equal(resolveAgentStepTimeoutMs({}), 600_000);
  assert.equal(resolveAgentStepTimeoutMs({ timeoutMs: 0 }), 600_000);
}
assert.equal(owuiPrefersClientToolProtocol('custom', { custom: true }, {}, true), false);
assert.equal(
  prefersClientToolProtocol('custom', { kind: 'openai_compatible', custom: true }),
  false,
);
assert.equal(
  formatAgentPhaseStatus({ step: 10, providerLabel: 'MY OpenRouter', kind: 'model', detail: '네이티브 tools' }),
  '모델 응답 대기 중 · 10번째 호출 — MY OpenRouter · 네이티브 tools',
);
assert.equal(formatElapsedDuration(0), '0분 0초');
assert.equal(formatElapsedDuration(72), '1분 12초');
const { sanitizeFinalAgentContent } = await import(
  '../core/dist/agent/tool-content-guards.js'
);
{
  const scrubbed = sanitizeFinalAgentContent(
    'done\nTOOL_CALL: {"name":"write_file","arguments":{}}\nERROR: WIRING_SMOKE missing #app\nANSWER_SYNTH_X',
  );
  assert.ok(!/TOOL_CALL/i.test(scrubbed), 'final scrub drops TOOL_CALL');
  assert.ok(/WIRING_SMOKE/i.test(scrubbed), 'semantic content remains model-owned');
  assert.ok(/ANSWER_SYNTH/i.test(scrubbed), 'non-protocol prose remains intact');
}
{
  const { buildTaskChecklist, looksLikeColdMultiCreate } = await import(
    '../core/dist/agent/agent-task-checklist.js'
  );
  const cl = buildTaskChecklist('빈 폴더에 웹 앱 하나 만들어줘');
  assert.ok(cl.labels.includes('greenfield-default-set'), 'path-free greenfield seeds default set');
  assert.ok(cl.requiredPaths.length >= 3, 'default set has multiple paths');
  assert.equal(cl.requireRetrieval, false, 'greenfield skips retrieval');
  const {
    formatGreenfieldDefaultSetNote,
  } = await import('../core/dist/agent/agent-task-checklist.js');
  const gNote = formatGreenfieldDefaultSetNote(cl);
  assert.match(
    gNote,
    /at most 2 write_file|Stream-safe|≤2 write_file/i,
    'stream-safe chunked multi-create system note',
  );

  const coldMsg = [
    '빈 Desktop 워크스페이스에 데모 프로젝트를 한 실행에서 완성.',
    '필수 파일 write_file: public/index.html public/app.js src/lib.js package.json README.md',
    'SEED.md 유지. missing 0 까지 완료.',
  ].join(' ');
  assert.equal(looksLikeColdMultiCreate(coldMsg), true, 'cold multi-create detect');
  const coldCl = buildTaskChecklist(coldMsg);
  assert.equal(coldCl.requireRetrieval, false, 'cold multi-create skips retrieval-first');
  assert.ok(coldCl.labels.includes('cold-create') || coldCl.labels.includes('greenfield'));

  const scrubDone = (
    await import('../core/dist/agent/tool-content-guards.js')
  ).sanitizeFinalAgentContent(
    '## 완료\n17 files.\n\n**다음 조치**: npm start 후 브라우저 육안 확인\n### 변경 증거\nmutate: 1 paths',
  );
  assert.ok(/다음\s*조치/i.test(scrubDone), 'response structure remains model-owned');
  assert.ok(/변경\s*증거|mutate:\s*1\s*paths/i.test(scrubDone), 'semantic footer remains intact');
}

const ws = mkdtempSync(path.join(tmpdir(), 'cqr-coding-iq-'));
try {
  // Multi-path checklist: partial mutate cannot silently pass.
  const { buildTaskChecklist, evaluateTaskChecklist } = await import(
    '../core/dist/agent/agent-task-checklist.js'
  );
  const checklist = buildTaskChecklist(
    '처음부터 public/index.html public/app.js docs/concept-brief.md 만들어줘',
  );
  assert.ok(checklist.requiredPaths.length >= 2, `expected multi paths, got ${checklist.requiredPaths}`);
  const blocked = evaluateTaskChecklist({
    checklist,
    workspaceRoot: ws,
    mutatedPaths: ['public/index.html'],
    toolsUsed: ['write_file'],
    claimsDone: false,
    claimsPartial: false,
  });
  assert.equal(blocked.ok, false, 'multi-path incomplete must block');
  assert.ok(blocked.missingPaths?.length >= 1);

  const target = path.join(ws, 'app.js');
  writeFileSync(target, 'const x = 1;\n', 'utf8');
  const out = await executeAgentTool(ws, {
    id: '1',
    type: 'function',
    function: {
      name: 'edit_file',
      arguments: JSON.stringify({
        path: 'app.js',
        old_text: 'const x = 1;',
        new_text: 'const x = 2; // coding-iq',
      }),
    },
  });
  assert.ok(!String(out.output).startsWith('ERROR'), out.output);
  assert.match(readFileSync(target, 'utf8'), /coding-iq/);
} finally {
  rmSync(ws, { recursive: true, force: true });
}

console.log('verify-coding-iq: ok');
