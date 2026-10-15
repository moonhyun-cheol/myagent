#!/usr/bin/env node
import assert from 'node:assert/strict';

const { isBareToolDeferral } = await import('../core/dist/agent/agent-claim-gates.js');

assert.equal(
  isBareToolDeferral('코드에서 확인하겠습니다. 기억만으로 단정하지 않겠습니다.'),
  true,
  'promise with no finding is a deferral',
);
assert.equal(
  isBareToolDeferral(
    '같은 문장만 반복하는 경우를 막도록 고치겠습니다. 먼저 종료 경로와 재촉 판정이 들어갈 위치를 확인합니다.',
  ),
  true,
  'plan sentence that only promises a lookup is a deferral',
);
assert.equal(
  isBareToolDeferral('왼쪽 연필의 새 대화가 어느 위치를 따르는지도 같이 보겠습니다.'),
  true,
  '보겠습니다 without a tool is a deferral',
);

assert.equal(
  isBareToolDeferral('오류가 아닙니다. 스킬은 그대로 쓸 수 있습니다.'),
  false,
  'a finished explanation is not a deferral',
);
assert.equal(
  isBareToolDeferral('원인은 모델이 도구 없이 정상 완료로 돌려줬기 때문입니다.'),
  false,
  'a cause statement is not a deferral',
);
assert.equal(
  isBareToolDeferral('맞습니다. 개인 작업은 접기만 됩니다.'),
  false,
  'a short factual answer is not a deferral',
);
assert.equal(
  isBareToolDeferral('원하시면 커밋한 뒤 main을 try에 반영하겠습니다.'),
  false,
  'an offer waiting for confirmation is not a deferral',
);
assert.equal(
  isBareToolDeferral('agent-run-step-loop.ts 497줄에서 문구를 띄웁니다. 확인하겠습니다.'),
  false,
  'a path citation is already a finding',
);

console.log('verify-tool-deferral: ok');
