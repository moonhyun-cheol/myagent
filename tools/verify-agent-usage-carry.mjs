#!/usr/bin/env node
// 오류·중지로 중단된 에이전트 작업의 토큰 사용량 보존 회귀 검증
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const m = await import(pathToFileURL(path.join(root, 'core/dist/agent/agent-usage-carry.js')).href);

// 1) 누적: 단계별 usage 합산, 음수/NaN/누락은 0
const live = m.emptyAgentUsage();
m.addAgentUsage(live, { prompt_tokens: 1200, completion_tokens: 300, cached_tokens: 100 });
m.addAgentUsage(live, { prompt_tokens: 800, completion_tokens: -5, reasoning_tokens: Number.NaN });
m.addAgentUsage(live, undefined);
assert.deepEqual(live, { prompt_tokens: 2000, completion_tokens: 300, reasoning_tokens: 0, cached_tokens: 100, cache_write_tokens: 0 });

// 2) throw 경로: 오류 객체에 스냅숏 첨부 → 이후 live 변경에 영향 없음, 직렬화에 노출 안 됨
const err = new Error('504 Gateway Timeout');
m.attachAgentUsage(err, live);
live.prompt_tokens = 999999;
assert.deepEqual(m.agentUsageFromError(err)?.prompt_tokens, 2000);
assert.equal(JSON.stringify(err).includes('agentLlmUsage'), false);
assert.equal(Object.keys(err).length, 0);

// 3) 사용량 0이거나 원시값 오류는 첨부하지 않음
const zeroErr = new Error('before provider call');
m.attachAgentUsage(zeroErr, m.emptyAgentUsage());
assert.equal(m.agentUsageFromError(zeroErr), undefined);
m.attachAgentUsage('string error', live);
assert.equal(m.agentUsageFromError('string error'), undefined);
assert.equal(m.agentUsageFromError(null), undefined);

// 4) 재시도 합산: 실패 시도 2회 + 성공 시도(lastPerf)
const carried = m.emptyAgentUsage();
const fail1 = new Error('ECONNRESET');
m.attachAgentUsage(fail1, { prompt_tokens: 500, completion_tokens: 50 });
const fail2 = Object.assign(new Error('aborted'), { name: 'AbortError' });
m.attachAgentUsage(fail2, { prompt_tokens: 700, completion_tokens: 70 });
m.addAgentUsage(carried, m.agentUsageFromError(fail1));
m.addAgentUsage(carried, m.agentUsageFromError(fail2));
m.addAgentUsage(carried, m.agentUsageFromError(new Error('no usage')));
assert.deepEqual(
  m.toMessageUsage(m.sumAgentUsage(carried, { prompt_tokens: 1000, completion_tokens: 100 })),
  { input_tokens: 2200, output_tokens: 220 },
);

// 5) 메시지 형식: 사용량 없으면 undefined (UI가 0 토큰을 표시하지 않도록)
assert.equal(m.toMessageUsage(m.emptyAgentUsage()), undefined);
assert.equal(m.toMessageUsage(undefined), undefined);
assert.deepEqual(m.toMessageUsage(carried), { input_tokens: 1200, output_tokens: 120 });

console.log('verify-agent-usage-carry OK');
