#!/usr/bin/env node
/**
 * IMP-SUP-01: Local error-record path exists; no external send.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const menu = path.join(root, 'ui/workspace/src/components/ErrorReportMenu.tsx');
const client = path.join(root, 'ui/workspace/src/api/cqrClient.ts');
const dispatch = path.join(root, 'core/src/routes/dispatch.ts');
const service = path.join(root, 'core/src/support/error-report-service.ts');

assert.ok(existsSync(menu), 'ErrorReportMenu.tsx missing');
assert.ok(existsSync(client), 'cqrClient.ts missing');
const menuText = readFileSync(menu, 'utf8');
const clientText = readFileSync(client, 'utf8');
const dispatchText = readFileSync(dispatch, 'utf8');
const serviceText = readFileSync(service, 'utf8');

assert.match(menuText, /sendErrorReport|fetchErrorReportStatus/);
assert.match(clientText, /error-report|ErrorReport/);
assert.match(dispatchText, /\/error-report/);
// No auto-send on mount — user gesture only
assert.ok(!/useEffect\(\s*\(\)\s*=>\s*\{\s*void\s*sendErrorReport/m.test(menuText));
assert.match(serviceText, /error-reports\.jsonl/);
assert.doesNotMatch(serviceText, /smtp|sendSmtpMail|gmail\.com/i);
assert.doesNotMatch(menuText, /메일|전송 대상/);

console.log('verify-error-report-dry: ok (local JSONL; no external send)');
