#!/usr/bin/env node
/**
 * P0 post-mutate syntax gate — broken JS/JSON must surface ERROR: SYNTAX_BROKEN;
 * TS/TSX duplicate module-scope decls must too (agent refine-append failure mode).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  checkPostMutateSyntax,
  appendPostMutateSyntaxCheck,
  outputHasSyntaxBroken,
  findDuplicateModuleDecls,
} = await import('../core/dist/agent/agent-post-mutate-syntax.js');

const dir = mkdtempSync(path.join(os.tmpdir(), 'cqr-syntax-'));
try {
  const okJs = path.join(dir, 'ok.js');
  const badJs = path.join(dir, 'bad.js');
  const okJson = path.join(dir, 'ok.json');
  const badJson = path.join(dir, 'bad.json');
  writeFileSync(okJs, 'const x = 1;\n');
  writeFileSync(
    badJs,
    [
      'const deviceProfiles = [',
      "  { id: 'a', name: 'A' }",
      '',
      'function broken() { return 1; }',
      "  ,{ id: 'b' }",
      '];',
      '',
    ].join('\n'),
  );
  writeFileSync(okJson, '{"a":1}');
  writeFileSync(badJson, '{a:1}');

  const pass = checkPostMutateSyntax(dir, ['ok.js', 'ok.json']);
  assert.equal(pass.ok, true);
  assert.equal(pass.applicable, true);

  const failJs = checkPostMutateSyntax(dir, ['bad.js']);
  assert.equal(failJs.ok, false);
  assert.equal(failJs.applicable, true);

  const failJson = checkPostMutateSyntax(dir, ['bad.json']);
  assert.equal(failJson.ok, false);

  const appended = appendPostMutateSyntaxCheck(dir, ['bad.js'], 'Wrote bad.js (12 chars)');
  assert.match(appended, /Wrote bad\.js/);
  assert.equal(outputHasSyntaxBroken(appended), true);
  assert.match(appended, /ERROR:\s*SYNTAX_BROKEN/);

  const clean = appendPostMutateSyntaxCheck(dir, ['ok.js'], 'Wrote ok.js (10 chars)');
  assert.equal(outputHasSyntaxBroken(clean), false);
  assert.equal(clean.includes('SYNTAX_BROKEN'), false);

  // mid-array insert (session failure mode)
  const midBreak = path.join(dir, 'app.js');
  writeFileSync(
    midBreak,
    [
      'const deviceProfiles = [',
      "  { id: 'mobile-360', name: '모바일 360' }",
      '',
      'function getAutomatedReport() {',
      '  return null;',
      '}',
      "  ,{ id: 'mobile-375', name: '모바일 375' }",
      '];',
    ].join('\n'),
  );
  const mid = checkPostMutateSyntax(dir, ['app.js']);
  assert.equal(mid.ok, false, 'mid-array function insert must fail node --check');

  // TS duplicate module-scope decls (PiP refine-append failure)
  const okTs = path.join(dir, 'ok.ts');
  writeFileSync(okTs, 'export function readPreviewLayout() { return null; }\n');
  const okTsCheck = checkPostMutateSyntax(dir, ['ok.ts']);
  assert.equal(okTsCheck.ok, true);
  assert.equal(okTsCheck.applicable, true);
  assert.equal(okTsCheck.checked[0]?.checker, 'duplicate-decl');

  const dupTs = path.join(dir, 'dup.ts');
  writeFileSync(
    dupTs,
    [
      "export type PreviewDisplayState = 'docked' | 'pip' | 'closed';",
      'export function readPreviewLayout() { return 1; }',
      'export function writePreviewLayout() {}',
      "export type PreviewDisplayState = 'docked' | 'pip' | 'closed';",
      'export function readPreviewLayout() { return 2; }',
      'export function writePreviewLayout() {}',
      'const PIP_MAX_WIDTH = 960;',
      'const PIP_MAX_WIDTH = 960;',
      '  const nestedOk = 1;',
      '  const nestedOk = 2;',
    ].join('\n'),
  );
  const dups = findDuplicateModuleDecls(
    [
      'export function readPreviewLayout() { return 1; }',
      'export function readPreviewLayout() { return 2; }',
    ].join('\n'),
  );
  assert.equal(dups.length, 1);
  assert.equal(dups[0].name, 'readPreviewLayout');
  assert.equal(dups[0].count, 2);

  const failDup = checkPostMutateSyntax(dir, ['dup.ts']);
  assert.equal(failDup.ok, false);
  assert.equal(failDup.checked[0]?.checker, 'duplicate-decl');
  assert.match(failDup.checked[0]?.detail ?? '', /readPreviewLayout appears 2/);
  assert.match(failDup.checked[0]?.detail ?? '', /PIP_MAX_WIDTH appears 2/);
  assert.equal(
    /nestedOk/.test(failDup.checked[0]?.detail ?? ''),
    false,
    'indented consts must not trip duplicate-decl',
  );

  const dupAppendix = appendPostMutateSyntaxCheck(dir, ['dup.ts'], 'Wrote dup.ts');
  assert.equal(outputHasSyntaxBroken(dupAppendix), true);
  assert.match(dupAppendix, /duplicate-decl/);
  assert.match(dupAppendix, /appended instead of replacing/);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('verify-post-mutate-syntax: ok');
