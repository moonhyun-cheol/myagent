#!/usr/bin/env node
/**
 * Golden: OpenClaw us_sample_stock_lookup body surfaces summary/qty (not bare success).
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  formatAutomatonEnvelope,
  formatAutomatonEnvelopeWithContract,
  pickAutomatonUserFacingText,
  automatonBackgroundNeedsChatFollowUp,
  replaceAutomatonStatusEmoji,
} = await import(pathToFileURL(path.join(root, 'core/dist/automaton/format-result.js')).href);

const samplePayload = {
  status: 'success',
  route: 'openclaw_adapter',
  result: {
    status: 'success',
    artifacts: [{ name: 'json_output', path: '../out/us_sample_stock_lookup_latest.json' }],
    output: {
      summary:
        '스탁: A스탁\nSKU: KR05091_CQTSP641FRT_38W/12L\n수량: 4\n재고위치: Astock\n출처: lookData',
      last_stdout:
        '스탁: A스탁\nSKU: KR05091_CQTSP641FRT_38W/12L\n수량: 4\n재고위치: Astock\n출처: lookData',
      result: {
        status: 'found',
        qty: 4,
        stock_label: 'A스탁',
        source: 'lookdata',
        matched_date: '2026-08-03',
        message:
          '스탁: A스탁\nSKU: KR05091_CQTSP641FRT_38W/12L\n수량: 4\n재고위치: Astock\n출처: lookData',
        form_fields: { SKU: 'KR05091_CQTSP641FRT_38W/12L', 수량: 4, 재고위치: 'Astock' },
        row: { inven_SKU: 'KR05091_CQTSP641FRT_38W/12L' },
        json_output: '../out/us_sample_stock_lookup_latest.json',
      },
    },
  },
};

const text = pickAutomatonUserFacingText(samplePayload);
assert.match(text, /수량:\s*4/);
assert.match(text, /A스탁/);

// Legacy `auto` renderer (tool without a manifest response contract).
const body = formatAutomatonEnvelope('legacy_auto_fixture', samplePayload);
assert.match(body, /수량:\s*4|수량:\*\*\s*4|\*\*수량:\*\*\s*4/);
assert.match(body, /A스탁/);
assert.match(body, /### 결과/);
assert.match(body, /KR05091_CQTSP641FRT_38W\/12L/);
assert.ok(!/^[\s\S]*result\.status:\s*success\s*$/m.test(body.split('###')[0]), 'not status-only');
// Must not be the thin two-line success user complained about
assert.ok(body.length > 120, 'body has business content');

// Manifest `text` contract with labeled fields: data only, no headings/summary copy.
{
  const contracted = formatAutomatonEnvelopeWithContract('us_sample_stock_lookup', samplePayload, {
    profile: 'text',
    fields: ['stock_label', 'form_fields.SKU', 'qty', 'form_fields.재고위치', 'matched_date', 'source'],
    field_labels: {
      stock_label: '스탁',
      'form_fields.SKU': 'SKU',
      qty: '수량',
      'form_fields.재고위치': '재고위치',
      matched_date: '기준일',
      source: '출처',
    },
  });
  assert.equal(contracted, [
    '- 스탁: A스탁',
    '- SKU: KR05091_CQTSP641FRT_38W/12L',
    '- 수량: 4',
    '- 재고위치: Astock',
    '- 기준일: 2026-08-03',
    '- 출처: lookdata',
  ].join('\n'));
  assert.doesNotMatch(contracted, /###|요약|\p{Extended_Pictographic}/u);
}

{
  const noisy = {
    status: 'ok',
    result: {
      output: {
        last_stdout:
          '작업 실행 결과\nlivesi_base_source completed successfully. | status=ok | message=======작업 완료======\nLiveSI 기초자료 작업',
      },
    },
  };
  const cleaned = pickAutomatonUserFacingText(noisy);
  assert.match(cleaned, /======작업 완료======/);
  assert.match(cleaned, /LiveSI 기초자료 작업/);
  assert.doesNotMatch(cleaned, /completed successfully/);
  assert.doesNotMatch(cleaned, /작업 실행 결과/);
}

assert.equal(automatonBackgroundNeedsChatFollowUp({ status: 'ok' }, 'JEWEL9505'), false);

// Discord batch marks (DISCORD_RESPONSE_FORMATS.md §2) → text tags in MY Agent chat.
{
  const discordMsg = [
    '샘플 재고 (3건)',
    '✅ KR001 — 4개',
    '⚠️ KR002 조회 오류',
    '⏭ KR003 중복',
    '— KR004 재고없음',
    'Brand™ 🎉 끝',
  ].join('\n');
  const rendered = formatAutomatonEnvelopeWithContract(
    'us_sample_stock_lookup',
    { status: 'ok', message: discordMsg },
    { profile: 'discord', fallback_profile: 'text' },
  );
  assert.equal(rendered, [
    '샘플 재고 (3건)',
    '[성공] KR001 — 4개',
    '[오류] KR002 조회 오류',
    '[건너뜀] KR003 중복',
    '— KR004 재고없음',
    'Brand™ 끝',
  ].join('\n'));
  assert.doesNotMatch(rendered.replace('™', ''), /\p{Extended_Pictographic}/u);
  assert.equal(replaceAutomatonStatusEmoji('plain'), 'plain');
}
assert.equal(automatonBackgroundNeedsChatFollowUp({ status: 'ok' }, ''), true);
assert.equal(automatonBackgroundNeedsChatFollowUp({ status: 'denied' }, 'JEWEL9505'), true);

console.log('verify-automaton-format: ok');
