#!/usr/bin/env node
/**
 * Delta apply script — locked shell DLL must not abort the whole update.
 * Static checks only (no live MY Agent process).
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const applyPs1 = path.join(root, 'tools', 'update', 'apply-delta.ps1');
const publishDelta = path.join(root, 'tools', 'publish-delta.mjs');
const updateBat = path.join(root, 'UPDATE.bat');

assert.ok(existsSync(applyPs1), 'apply-delta.ps1 missing');
assert.ok(existsSync(publishDelta), 'publish-delta.mjs missing');

const ps1 = readFileSync(applyPs1, 'utf8');
assert.match(ps1, /Stop-MyAgentForDelta/, 'must stop MYAgent before bin replace');
assert.match(ps1, /robocopy/i, 'must prefer robocopy overwrite over wipe');
assert.match(ps1, /\$failed/, 'must collect per-item failures');
assert.doesNotMatch(
  ps1,
  /foreach\s*\(\s*\$pid\s+in/,
  'must not shadow PowerShell automatic $PID',
);
assert.match(ps1, /bin\\my-agent/, 'must update shell');
assert.match(ps1, /Backup-ChatDataBeforeUpdate/, 'must backup chat before update');
assert.match(ps1, /data\\backups\\pre-update|pre-update-/, 'backup under data/backups');
assert.match(ps1, /data\\sessions/, 'must include sessions in backup');
assert.match(ps1, /data\\projects/, 'must include projects in backup');

const pub = readFileSync(publishDelta, 'utf8');
assert.match(pub, /copyRel\('bin\/my-agent'\)/, 'delta zip must include shell');
assert.match(pub, /apply-delta\.ps1/, 'delta zip must include apply script');

const bat = readFileSync(updateBat, 'utf8');
assert.match(bat, /apply-delta\.ps1/, 'UPDATE.bat must call apply-delta');
assert.match(bat, /MYAgent\.exe|자동 종료/, 'UPDATE.bat should warn about running shell');
assert.match(bat, /backups|채팅/, 'UPDATE.bat should mention chat backup');

console.log('verify-delta-apply: ok');
