#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  parseNopsUserLogName,
  pickLocalNopsUserId,
  attachLocalNopsUserId,
} = await import(pathToFileURL(path.join(root, 'core/dist/automaton/local-nops-user-id.js')).href);

assert.deepEqual(parseNopsUserLogName('2026-08-27_INS78516.Log'), {
  date: '2026-08-27',
  userId: 'INS78516',
});
assert.equal(parseNopsUserLogName('2026-08-27_FILE.Log'), null);
assert.equal(parseNopsUserLogName('2026-08-27_NC_Main.Log'), null);
assert.equal(parseNopsUserLogName('2026-08-27_ADMIN.Log'), null);
assert.equal(parseNopsUserLogName('ai_bridge.json'), null);

assert.equal(
  pickLocalNopsUserId(
    [
      '2026-08-27_FILE.Log',
      '2026-08-27_NC_Main.Log',
      '2026-08-27_INS78516.Log',
      '2026-08-26_INS78516.Log',
    ],
    '2026-08-27',
  ),
  'INS78516',
);

assert.equal(
  pickLocalNopsUserId(['2026-08-26_JEWEL9505.Log', '2026-08-25_INS78516.Log'], '2026-08-27'),
  'JEWEL9505',
);

assert.equal(
  pickLocalNopsUserId(
    ['2026-08-27_INS78516.Log', '2026-08-27_JEWEL9505.Log'],
    '2026-08-27',
  ),
  '',
);

assert.equal(pickLocalNopsUserId([], '2026-08-27'), '');

const args = {};
const req = attachLocalNopsUserId({ platform: 'my_agent', args }, args, 'JEWEL9505');
assert.equal(req.nopspro_user_id, 'JEWEL9505');
assert.equal(args.nopspro_user_id, 'JEWEL9505');

const emptyArgs = {};
const emptyReq = attachLocalNopsUserId({ platform: 'my_agent', args: emptyArgs }, emptyArgs, '');
assert.equal(emptyReq.nopspro_user_id, undefined);

console.log('OK local-nops-user-id');
