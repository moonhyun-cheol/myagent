#!/usr/bin/env node
/**
 * Workspace behavior contract: Plan read-only pack, Ask skips tool plane, codingPlanLock wired.
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultExecutionPolicyFromConfig,
  normalizeExecutionPolicy,
  resolveWorkspaceBehavior,
} from '../core/dist/execution-policy.js';
import { codingPlanLockEnabled } from '../core/dist/providers/harness-policy.js';
import {
  getCodeAgentToolsByPack,
  getCodeAgentToolNamesFromTools,
} from '../core/dist/agent/tools.js';
import { isMutatingAgentTool } from '../core/dist/agent/verify-loop.js';
import {
  behaviorOffersBuildHandoff,
  behaviorPersistsLockedConstraints,
  behaviorSkipsSilentVerify,
  loadAgentRuntimeFacts,
  loadPlanBuildPrompt,
  resolveForcedToolPack,
  shouldUseWorkspaceToolPlane,
} from '../core/dist/agent/agent-runtime-facts.js';
import { extractLockedConstraintsFromText } from '../core/dist/agent/agent-locked-constraints.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

const factsPath = path.join(root, 'core/config/defaults/agent-runtime-facts.json');
assert.equal(existsSync(factsPath), true, 'agent-runtime-facts.json missing — run sync:agent-runtime-facts');
const facts = loadAgentRuntimeFacts(root);
assert.ok(facts.mutating_tools.length >= 5, 'mutating_tools');
assert.ok(facts.tool_packs.read_only.include.length >= 10, 'read_only include');
assert.equal(facts.behaviors.plan?.persist_locked_constraints, true);
assert.equal(facts.behaviors.plan?.ui_handoff, 'build');
assert.ok(String(facts.behaviors.plan?.build_prompt || '').length > 20, 'plan build_prompt');

const readOnlyTools = getCodeAgentToolsByPack(root, 'read_only');
const readOnlyNames = getCodeAgentToolNamesFromTools(readOnlyTools);
for (const name of readOnlyNames) {
  assert.equal(isMutatingAgentTool(name), false, `read_only pack includes mutating tool: ${name}`);
}
for (const name of ['write_file', 'edit_file', 'apply_patch']) {
  assert.equal(readOnlyNames.includes(name), false, `mutating tool in read_only schema: ${name}`);
}

assert.equal(shouldUseWorkspaceToolPlane('ask'), false);
assert.equal(shouldUseWorkspaceToolPlane('plan'), true);
assert.equal(shouldUseWorkspaceToolPlane('agent'), true);

assert.equal(behaviorSkipsSilentVerify('plan', root), true);
assert.equal(behaviorSkipsSilentVerify('agent', root), false);
assert.equal(behaviorPersistsLockedConstraints('plan', root), true);
assert.equal(behaviorOffersBuildHandoff('plan', root), true);
assert.equal(resolveForcedToolPack('plan', root), 'read_only');
assert.equal(resolveForcedToolPack('agent', root), undefined);

assert.equal(codingPlanLockEnabled({}), false);
assert.equal(codingPlanLockEnabled({ MY_AGENT_CODE_PLAN_LOCK: '1' }), true);
const locked = defaultExecutionPolicyFromConfig({}, { MY_AGENT_CODE_PLAN_LOCK: '1' });
assert.equal(resolveWorkspaceBehavior(locked), 'plan');

const normalized = normalizeExecutionPolicy({ workspace_behavior: 'plan' });
assert.equal(normalized.workspace_behavior, 'plan');

const planSkill = read('core/config/defaults/skills/plan-mode.md');
assert.match(planSkill, /Investigation order/);
assert.match(planSkill, /Build handoff/);
assert.match(planSkill, /Acceptance/);
assert.match(planSkill, /계층/);
assert.match(planSkill, /권장:/);
assert.match(planSkill, /data\/profile|Reuse existing paths/);
assert.match(planSkill, /harness 비진입|agent-run-loop/);

const uiBuild = read('ui/workspace/src/lib/plan-build.ts');
assert.match(uiBuild, /workspace_behavior !== 'plan'/);
assert.doesNotMatch(uiBuild, /looksLikePlan/);
const prompt = loadPlanBuildPrompt(root);
assert.ok(uiBuild.includes(prompt), 'UI PLAN_BUILD_USER_MESSAGE must match facts build_prompt');

const sample = extractLockedConstraintsFromText(`PLAN:
- 목표: test
- P0: 기존 수정 | artifactKind: unknown | 손대지 말 것: core/src/updates/ | 진입점: ChatPane.tsx | 필수 env: 없음
- 대상 파일: ui/workspace/src/components/ChatPane.tsx
- Exit Gate: disk probe ChatPane.tsx`);
assert.ok(sample, 'compact P0 extract');
assert.ok(sample.doNotTouch?.some((p) => /updates/.test(p)), 'P0 do-not-touch');
assert.equal(sample.entry, 'ChatPane.tsx');

for (const rel of [
  'core/src/chat/chat-orchestrator.ts',
  'core/src/chat/modes/workspace-agent.ts',
  'core/src/agent/agent-tool-execute.ts',
  'core/src/agent/agent-run-loop.ts',
  'ui/workspace/src/components/ChatPane.tsx',
  'ui/workspace/src/store/workspaceStore.ts',
]) {
  const src = read(rel);
  if (rel.endsWith('ChatPane.tsx')) {
    assert.match(src, /plan-build-button/);
    assert.match(src, /buildFromPlan/);
    assert.match(src, /P0 미추출/);
  } else if (rel.endsWith('workspaceStore.ts')) {
    assert.match(src, /buildFromPlan/);
    assert.match(src, /planBuildOffer/);
  } else if (rel.endsWith('agent-run-loop.ts')) {
    assert.match(src, /resolveBehaviorToolPack/);
    assert.doesNotMatch(src, /workspaceBehavior === 'plan'\s*\?\s*'read_only'/);
  } else if (rel.endsWith('workspace-agent.ts')) {
    assert.match(src, /resolveForcedToolPack|behaviorPersistsLockedConstraints/);
  } else {
    assert.match(src, /shouldEnterWorkspaceToolPlane|WORKSPACE_BEHAVIOR_READ_ONLY|workspaceBehavior|planConstraintsLocked/);
  }
}

console.log('verify-workspace-behavior: ok');
