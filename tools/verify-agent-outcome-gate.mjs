#!/usr/bin/env node
/** Focused smoke for the current disk-backed completion gate. */
import assert from 'node:assert/strict';
import {
  contentClaimsPartialOnly,
  contentClaimsStructuralDeliverable,
  diagnosticsEvidenceStatus,
  evaluateOutcomeGate,
  extractClaimedMarkers,
  extractPathsFromUserMessage,
  HYPOTHETICAL_DONE_REFUSAL,
  probeContentsForMarkers,
  userAsksHypotheticalDoneReport,
  userForbidsToolUse,
} from '../core/dist/agent/agent-outcome-gate.js';

assert.equal(diagnosticsEvidenceStatus({ ok: true, skipped: true }), 'weak');
assert.equal(diagnosticsEvidenceStatus({ ok: true, skipped: false }), true);
assert.equal(userForbidsToolUse('도구는 쓰지 마'), true);
assert.equal(userAsksHypotheticalDoneReport('수정했다고 가정하고 완료 보고만 해'), true);
assert.match(HYPOTHETICAL_DONE_REFUSAL, /미반영|완료 보고 불가/);

assert.equal(contentClaimsStructuralDeliverable('별도 모듈로 분리했습니다.'), true);
assert.equal(contentClaimsPartialOnly('부분 반영만 했습니다.'), true);
assert.ok(extractClaimedMarkers('`HEADERS`를 반영했습니다.').includes('HEADERS'));
assert.ok(extractPathsFromUserMessage('core/src/main.ts를 수정해').includes('core/src/main.ts'));
assert.deepEqual(probeContentsForMarkers(['const HEADERS = {};'], ['HEADERS']).found, ['HEADERS']);

const base = {
  text: '수정을 완료했습니다.',
  mutatedOk: true,
  mutatedPaths: ['core/src/main.ts'],
  fileContents: { 'core/src/main.ts': 'export const ready = true;' },
};

assert.equal(
  evaluateOutcomeGate({ ...base, mutatedOk: false, mutatedPaths: [], diagnostics: true }).reason,
  'no_claim',
);
assert.equal(evaluateOutcomeGate({ ...base, diagnostics: false }).reason, 'diag_fail');
assert.equal(evaluateOutcomeGate({ ...base, diagnostics: null }).reason, 'diag_unverified');
assert.equal(evaluateOutcomeGate({ ...base, diagnostics: true }).reason, 'pass');

const markerMiss = evaluateOutcomeGate({
  ...base,
  text: '`EXPECTED_MARKER`를 반영했습니다.',
  diagnostics: true,
});
assert.equal(markerMiss.reason, 'probe_miss');

console.log('verify-agent-outcome-gate: ok');
