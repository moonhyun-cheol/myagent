#!/usr/bin/env node
import assert from 'node:assert/strict';

const {
  isBareToolDeferral,
  shouldHoldPublicationUntilToolDeferralCheck,
  shouldWithholdToolDeferralPublication,
} = await import('../core/dist/agent/agent-claim-gates.js');

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

const hold = {
  retryAlreadyUsed: false,
  toolsAvailable: true,
  toolsUsed: false,
};
assert.equal(shouldHoldPublicationUntilToolDeferralCheck(hold), true);
assert.equal(
  shouldWithholdToolDeferralPublication({
    ...hold,
    text: '코드에서 확인하겠습니다. 기억만으로 단정하지 않겠습니다.',
  }),
  true,
  'a held promise is not published',
);
assert.equal(
  shouldWithholdToolDeferralPublication({
    ...hold,
    text: '오류가 아닙니다. 스킬은 그대로 쓸 수 있습니다.',
  }),
  false,
  'a finished explanation is published after the hold',
);
assert.equal(
  shouldWithholdToolDeferralPublication({
    ...hold,
    retryAlreadyUsed: true,
    text: '코드에서 확인하겠습니다.',
  }),
  false,
  'the second promise is shown; retry stays once',
);
assert.equal(
  shouldHoldPublicationUntilToolDeferralCheck({ ...hold, toolsUsed: true }),
  false,
  'after a tool call, publication is not held',
);

const {
  contentClaimsWorkspaceAbsence,
  shouldFlagUncheckedAbsenceClaim,
} = await import('../core/dist/agent/agent-claim-gates.js');

assert.equal(
  contentClaimsWorkspaceAbsence('제가 언급한 조회 경로·파일명은 지어낸 것이 섞여 있습니다.'),
  true,
  '「지어냈다」 is an absence claim',
);
assert.equal(
  contentClaimsWorkspaceAbsence('여기엔 CQR 제품 카탈로그도, 시장조사 파이프라인도 없습니다.'),
  true,
  '「카탈로그 … 없습니다」 is an absence claim',
);
assert.equal(
  contentClaimsWorkspaceAbsence('API 연결·데이터 파일·파이프라인 전부 부재'),
  true,
  '「부재」 is an absence claim',
);
assert.equal(
  contentClaimsWorkspaceAbsence('그 파일이 없는지는 검색으로 확인하겠습니다.'),
  false,
  'asking whether it is missing is not a claim',
);
assert.equal(
  contentClaimsWorkspaceAbsence('맞습니다. 개인 작업은 접기만 됩니다.'),
  false,
  'unrelated answer is not an absence claim',
);

const absence = {
  text: '여기엔 model_catalog.json 같은 데이터 파일이 없습니다.',
  retryAlreadyUsed: false,
  toolsAvailable: true,
  depthToolUsed: false,
};
assert.equal(shouldFlagUncheckedAbsenceClaim(absence), true, 'unchecked absence gets one search retry');
assert.equal(
  shouldFlagUncheckedAbsenceClaim({ ...absence, depthToolUsed: true }),
  false,
  'after search_files/read_file/list_directory the claim stands',
);
assert.equal(
  shouldFlagUncheckedAbsenceClaim({ ...absence, retryAlreadyUsed: true }),
  false,
  'absence retry stays once per turn',
);
assert.equal(
  shouldFlagUncheckedAbsenceClaim({ ...absence, toolsAvailable: false }),
  false,
  'no tools, no retry',
);

console.log('verify-tool-deferral: ok');
