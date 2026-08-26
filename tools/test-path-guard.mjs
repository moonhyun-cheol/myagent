import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertWritablePath, isNasPath, SecurityError } from '../core/dist/security/path-guard.js';
import {
  assertDevWorkspaceRoot,
  isAbsoluteUserPath,
  resolveDevWorkspaceReadPath,
  resolveDevWorkspaceRelPath,
  toAgentPath,
} from '../core/dist/security/dev-workspace-guard.js';
import { assertNasWriteAllowed } from '../core/dist/security/nas-write-consent.js';

const root = path.resolve('data-test-root');
process.env.MY_AGENT_ROOT = root;

assert(isNasPath('\\\\nas\\share\\file.txt'));
assert(isNasPath('\\\\nas3\\docs\\a.pdf'));
assert(isAbsoluteUserPath('\\\\nas\\공용_시장조사팀\\a.xlsx'));
assert(isAbsoluteUserPath('C:\\tmp\\a.txt'));
assert(!isAbsoluteUserPath('src/main.ts'));
assert(!isAbsoluteUserPath('\\\\nas')); // bare server root — need share

try {
  assertWritablePath('\\\\nas\\share\\out.txt', root);
  assert.fail('expected NAS error');
} catch (e) {
  assert(e instanceof SecurityError);
  assert.equal(e.code, 'NAS_WRITE_FORBIDDEN');
}

try {
  assertWritablePath('C:\\outside\\file.txt', root);
  assert.fail('expected outside error');
} catch (e) {
  assert(e instanceof SecurityError);
  assert.equal(e.code, 'OUTSIDE_MY_AGENT_ROOT');
}

const inside = path.join(root, 'data', 'attachments', 'a.txt');
assertWritablePath(inside, root);

try {
  assertNasWriteAllowed('\\\\nas\\share\\project', false);
  assert.fail('expected NAS consent error');
} catch (e) {
  assert(e instanceof SecurityError);
  assert.equal(e.code, 'NAS_CONSENT_REQUIRED');
}

assert.doesNotThrow(() => assertNasWriteAllowed('\\\\nas\\share\\project', true));
assert.doesNotThrow(() => assertNasWriteAllowed('C:\\local\\project', false));

try {
  assertDevWorkspaceRoot('\\\\nas\\share\\missing-project', { allowNas: false });
  assert.fail('expected NAS consent error for workspace root');
} catch (e) {
  assert(e instanceof SecurityError);
  assert.equal(e.code, 'NAS_CONSENT_REQUIRED');
}

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cqr-ws-'));
fs.writeFileSync(path.join(ws, 'in.txt'), 'hello', 'utf8');
assert.equal(resolveDevWorkspaceReadPath(ws, 'in.txt'), path.resolve(ws, 'in.txt'));

const unc = '\\\\nas\\공용_시장조사팀\\01_상품기획파트';
assert.equal(resolveDevWorkspaceReadPath(ws, unc), path.win32.normalize(unc));
assert.equal(toAgentPath(ws, unc), path.win32.normalize(unc));
assert.equal(toAgentPath(ws, path.join(ws, 'in.txt')), 'in.txt');

try {
  resolveDevWorkspaceRelPath(ws, unc, { allowNas: false });
  assert.fail('expected NAS consent on write');
} catch (e) {
  assert(e instanceof SecurityError);
  assert.equal(e.code, 'NAS_CONSENT_REQUIRED');
}
assert.equal(
  resolveDevWorkspaceRelPath(ws, unc, { allowNas: true }),
  path.win32.normalize(unc),
);

const outsideLocal = path.join(os.tmpdir(), `cqr-outside-${Date.now()}.txt`);
assert.equal(
  resolveDevWorkspaceRelPath(ws, outsideLocal, { allowNas: false }),
  path.resolve(outsideLocal),
);

try {
  resolveDevWorkspaceReadPath(ws, '..\\..\\Windows');
  assert.fail('expected relative escape blocked');
} catch (e) {
  assert(e instanceof SecurityError);
  assert.equal(e.code, 'OUTSIDE_MY_AGENT_ROOT');
}

fs.rmSync(ws, { recursive: true, force: true });
console.log('path-guard tests OK');
