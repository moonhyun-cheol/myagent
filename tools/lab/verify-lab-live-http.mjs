#!/usr/bin/env node
import assert from 'node:assert/strict';
import { isInfraFetchError, withInfraRetry } from './lab-live-http.mjs';

assert.equal(isInfraFetchError(new Error('fetch failed')), true);
assert.equal(isInfraFetchError(new Error('ECONNRESET')), true);
assert.equal(isInfraFetchError(new Error('other side closed')), true);
assert.equal(isInfraFetchError(new Error('premature close')), true);
assert.equal(isInfraFetchError(new Error('capability_denial')), false);

let n = 0;
const out = await withInfraRetry(
  async () => {
    n += 1;
    if (n < 3) throw new Error('fetch failed');
    return { content: 'ok', error: null };
  },
  { extra: 2, base: 'http://127.0.0.1:9' },
);
assert.equal(out.content, 'ok');
assert.equal(n, 3);

console.log('verify-lab-live-http: ok');
