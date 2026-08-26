#!/usr/bin/env node
/**
 * Pinned facts survive lossy history fold; tool JSON key preservation after truncate.
 * Also supports --compress-ab (fold on/off gap for soak).
 */
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compressAb = process.argv.includes('--compress-ab');

const { applyHistoryContextCompress, applyHistoryContentBudget } = await import(
  '../core/dist/chat/history-budget.js'
);
const { truncateToolResultForLlm } = await import('../core/dist/agent/agent-run-helpers.js');
const {
  resolveContextBudgets,
  usedContextLimitsFallback,
  DEFAULT_RESERVE_TOKENS,
} = await import('../core/dist/providers/model-context-limits.js');

const PIN_PATH = 'core/src/chat/history-budget.ts';
const PIN_NUM = 'budgetScale=7.8125';
const PIN_PRODUCT = 'MY Agent';

const longHist = [];
for (let i = 0; i < 16; i++) {
  longHist.push({
    role: 'user',
    content: `u${i} filler ${'질문내용입니다 '.repeat(30)} path=${PIN_PATH} num=${PIN_NUM}`,
  });
  longHist.push({
    role: 'assistant',
    content: `a${i} filler ${'답변내용입니다 '.repeat(30)} product=${PIN_PRODUCT}`,
  });
}

const env = {
  MY_AGENT_HISTORY_KEEP_RECENT: '4',
  MY_AGENT_HISTORY_COMPRESS_CHARS: '600',
};

let compressEvents = 0;
const compressed = applyHistoryContextCompress(longHist, env, {
  modelId: 'openai/gpt-5.6-sol',
  pinnedFacts: [PIN_PATH, PIN_NUM, `product:${PIN_PRODUCT}`],
  onCompress: (t) => {
    compressEvents += 1;
    assert.equal(t.compressed, true);
    assert.ok(t.foldedTurns >= 8);
    assert.ok(t.pinnedFactCount >= 3);
    assert.equal(t.usedFallback128k, false);
  },
});

assert.ok(compressed.length < longHist.length, 'fold must shorten history');
assert.match(compressed[0].content, /\[pinned facts\]/);
assert.ok(compressed[0].content.includes(PIN_PATH), 'pin path must survive fold');
assert.ok(compressed[0].content.includes(PIN_NUM), 'pin number must survive fold');
assert.ok(compressed[0].content.includes(`product:${PIN_PRODUCT}`), 'pin product must survive fold');
assert.ok(compressEvents >= 1);

const budgeted = applyHistoryContentBudget(longHist, env, {
  modelId: 'totally-unknown-model-xyz',
  pinnedFacts: [PIN_PATH],
});
assert.ok(budgeted[0]?.content?.includes(PIN_PATH));
assert.equal(usedContextLimitsFallback('totally-unknown-model-xyz'), true);

const budgets = resolveContextBudgets('openai/gpt-5.6-sol');
assert.ok(budgets.reserveTokens >= DEFAULT_RESERVE_TOKENS);
assert.equal(budgets.effectiveContextLength, budgets.contextLength - budgets.reserveTokens);

// IMP-ATT-03: vision/attach debit shrinks compress budget
const withVision = resolveContextBudgets('openai/gpt-5.6-sol', process.env, {
  visionImageCount: 2,
  attachmentChars: 4_000,
});
assert.ok(
  withVision.historyCompressChars < budgets.historyCompressChars,
  'vision/attach debit must reduce historyCompressChars',
);

const retrievalJson = JSON.stringify({
  query: 'history-budget',
  count: 0,
  hits: [],
  ok: true,
  noisyDump: 'x'.repeat(80_000),
});
const truncated = truncateToolResultForLlm(retrievalJson, 'search_embeddings', {
  maxChars: 4_000,
  modelId: 'openai/gpt-5.6-sol',
});
assert.match(truncated, /"count":0/);
assert.match(truncated, /"hits":\[\]/);
assert.match(truncated, /"query":"history-budget"/);
assert.ok(truncated.length < 8_000);

if (compressAb) {
  const offEnv = { ...env, MY_AGENT_HISTORY_COMPRESS_CHARS: '999999999' };
  const noFold = applyHistoryContextCompress(longHist, offEnv, {
    pinnedFacts: [PIN_PATH, PIN_NUM],
  });
  const withFold = applyHistoryContextCompress(longHist, env, {
    pinnedFacts: [PIN_PATH, PIN_NUM],
  });
  const chars = (ms) => ms.reduce((n, m) => n + String(m.content || '').length, 0);
  const gap = {
    turnsOff: noFold.length,
    turnsOn: withFold.length,
    charsOff: chars(noFold),
    charsOn: chars(withFold),
    pinSurvivesOn: withFold[0]?.content?.includes(PIN_PATH) === true,
    pinSurvivesOff: noFold.some((m) => String(m.content || '').includes(PIN_PATH)),
  };
  assert.ok(gap.turnsOn < gap.turnsOff, 'compress-ab: fold must reduce turns');
  assert.ok(gap.charsOn < gap.charsOff, 'compress-ab: fold must reduce chars');
  assert.equal(gap.pinSurvivesOn, true);
  const outDir = path.join(root, 'data', '_fpv');
  mkdirSync(outDir, { recursive: true });
  const fp = path.join(outDir, 'compress-ab.json');
  writeFileSync(fp, `${JSON.stringify({ ok: true, gap }, null, 2)}\n`);
  console.log(`compress-ab ok → ${fp}`);
}

console.log('verify-history-compress: ok');
