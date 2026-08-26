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
  pickAutomatonUserFacingText,
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

const body = formatAutomatonEnvelope('us_sample_stock_lookup', samplePayload);
assert.match(body, /수량:\s*4|수량:\*\*\s*4|\*\*수량:\*\*\s*4/);
assert.match(body, /A스탁/);
assert.match(body, /### 결과/);
assert.match(body, /KR05091_CQTSP641FRT_38W\/12L/);
assert.ok(!/^[\s\S]*result\.status:\s*success\s*$/m.test(body.split('###')[0]), 'not status-only');
// Must not be the thin two-line success user complained about
assert.ok(body.length > 120, 'body has business content');

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

console.log('verify-automaton-format: ok');
