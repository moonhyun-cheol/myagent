#!/usr/bin/env node
/**
 * Plan → Build handoff: PLAN block only, new Agent chat with chosen model / reasoning,
 * Locked P0 copied, source Plan reply marked so Build is not offered again.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../core/dist/sessions/session-store.js';
import {
  createPlanBuildHandoff,
  extractPlanBlock,
} from '../core/dist/sessions/plan-build-handoff.js';
import { loadLockedConstraints } from '../core/dist/agent/agent-locked-constraints.js';

const PLAN = [
  'PLAN:',
  '- 목표: Build를 새 대화로 넘긴다',
  '- P0: 기존 수정 | artifactKind: unknown | 손대지 말 것: core/src/updates/ | 진입점: ChatPane.tsx | 필수 env: 없음',
  '- 대상 파일: ui/workspace/src/components/ChatPane.tsx',
  '- 단계:',
  '  1. API 추가',
  '  2. UI 연결',
  '- Exit Gate: verify-plan-build-handoff ok',
].join('\n');

const REPLY = `탐색 결과 ChatPane.tsx와 workspaceStore.ts를 확인했습니다.\n\n${PLAN}\n\n궁금한 점이 있으면 알려 주세요.`;

// Block extraction: prose before/after dropped, fenced and bold headers handled.
assert.equal(extractPlanBlock(REPLY), PLAN);
assert.equal(extractPlanBlock(`설명\n\n\`\`\`\n${PLAN}\n\`\`\`\n끝`), PLAN);
assert.equal(extractPlanBlock(PLAN.replace('PLAN:', '**PLAN:**')), PLAN);
assert.equal(extractPlanBlock('PLAN을 아래처럼 세웠습니다.\n- 하나\n- 둘'), null);
assert.equal(extractPlanBlock('서술형 답변만 있습니다.'), null);
// The latest PLAN block in a reply wins (revised plan after an earlier draft).
const revised = PLAN.replace('Build를 새 대화로 넘긴다', '수정된 목표');
assert.equal(extractPlanBlock(`${PLAN}\n\n수정본:\n\n${revised}`), revised);

const temp = mkdtempSync(path.join(os.tmpdir(), 'cqr-plan-build-'));

function seed(store, id, reply) {
  store.ensure(id, {
    execution_policy: { reasoning: 'max', autopilot: 'off', approval: 'delegate', workspace_behavior: 'plan' },
  });
  store.append(id, { role: 'user', content: '계획 세워줘', at: new Date().toISOString() });
  store.append(id, { role: 'assistant', content: reply, at: new Date().toISOString(), workspace_behavior: 'plan' });
}

try {
  const store = new SessionStore(temp, temp);
  seed(store, 'plan-a', REPLY);
  store.setScopeSettings('plan-a', { allowed_paths: [path.join(temp, 'ws')] });

  const out = createPlanBuildHandoff({
    sessionStore: store,
    cqrRoot: temp,
    sourceSessionId: 'plan-a',
    model: 'openai/gpt-test',
    reasoning: 'low',
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  const target = store.load(out.session.id);
  assert.equal(target.messages.length, 0, 'new chat starts empty; UI sends build_message');
  assert.equal(target.preferred_model, 'openai/gpt-test');
  assert.deepEqual(target.execution_policy, {
    reasoning: 'low',
    autopilot: 'auto',
    approval: 'delegate',
    workspace_behavior: 'agent',
  });
  assert.deepEqual(target.allowed_paths, [path.resolve(path.join(temp, 'ws'))]);
  assert.match(out.build_message, /^아래 PLAN을 Agent 모드로/);
  assert.ok(out.build_message.endsWith(PLAN), 'build message carries the PLAN block only');
  assert.doesNotMatch(out.build_message, /탐색 결과|궁금한 점/);

  const locked = loadLockedConstraints(temp, out.session.id);
  assert.ok(locked, 'Locked P0 copied to the Build chat');
  assert.equal(out.plan_constraints_locked, true);
  assert.ok(locked.doNotTouch.some((p) => /core\/src\/updates/.test(p)));
  assert.equal(locked.entry, 'ChatPane.tsx');

  const source = store.load('plan-a');
  assert.equal(source.messages.at(-1).plan_built_session_id, out.session.id);
  const again = createPlanBuildHandoff({ sessionStore: store, cqrRoot: temp, sourceSessionId: 'plan-a', model: 'auto', reasoning: 'auto' });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'PLAN_NOT_BUILDABLE');

  seed(store, 'plan-prose', '서술형 계획입니다. 먼저 A를 하고 B를 합니다.');
  const prose = createPlanBuildHandoff({ sessionStore: store, cqrRoot: temp, sourceSessionId: 'plan-prose', model: 'auto', reasoning: 'auto' });
  assert.equal(prose.ok, false);
  assert.equal(prose.error, 'PLAN_BLOCK_MISSING');

  seed(store, 'plan-auto', REPLY);
  const auto = createPlanBuildHandoff({ sessionStore: store, cqrRoot: temp, sourceSessionId: 'plan-auto', model: 'auto', reasoning: 'auto' });
  assert.equal(auto.ok, true);
  assert.equal(store.load(auto.session.id).preferred_model, undefined, "'auto' inherits scope default");

  const bad = createPlanBuildHandoff({ sessionStore: store, cqrRoot: temp, sourceSessionId: 'plan-auto', model: 'x', reasoning: 'turbo' });
  assert.equal(bad.ok, false);

  console.log('verify-plan-build-handoff: ok');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
