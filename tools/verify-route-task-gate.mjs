#!/usr/bin/env node
/** Smoke: cross-mode task-type gate (inspect files vs research pipelines). */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const build = spawnSync(process.execPath, [path.join(root, 'tools', 'build.mjs')], {
  cwd: root,
  encoding: 'utf8',
  env: process.env,
});
assert.equal(build.status, 0, build.stderr || build.stdout || 'build failed');

const {
  blocksSpecializedPipelineModes,
  evaluateSpecializedModeFit,
  looksLikeInspectFilesTask,
  extractUncOrDrivePaths,
} = await import('../core/dist/router/route-task-gate.js');
const {
  matchFastSkillRoutes,
  matchMarketResearchRoute,
} = await import('../core/dist/router/route-heuristics.js');

const nasMsg =
  '\\\\fileserver\\shared_research\\planning\\sample orders\\shipping\\complete 먼저 이 루트의 레거시 파일들을 보고 양식을 확인해봐. 주소쪽에';

const extracted = extractUncOrDrivePaths(nasMsg);
assert.equal(extracted.length, 1);
assert.ok(
  extracted[0].endsWith('\\shipping\\complete') || extracted[0].endsWith('/shipping/complete'),
  `expected full UNC with spaces, got: ${extracted[0]}`,
);
assert.ok(extracted[0].includes('sample orders'), 'space in path segment must be kept');

assert.equal(looksLikeInspectFilesTask(nasMsg), true);
assert.equal(blocksSpecializedPipelineModes(nasMsg), true);
assert.equal(matchMarketResearchRoute(nasMsg), null);

const fast = matchFastSkillRoutes(nasMsg);
assert.ok(fast, 'inspect-files should fast-route');
assert.equal(fast.mode, 'web_dev');

const fitMarket = evaluateSpecializedModeFit('deep_research', nasMsg);
assert.equal(fitMarket.ok, false);
assert.equal(fitMarket.ok === false && fitMarket.action, 'reroute');

const conflict =
  '\\\\nas\\공용\\배송요청\\완료 양식 확인해줘. 그리고 경쟁사 시장조사도 해줘';
assert.equal(looksLikeInspectFilesTask(conflict), true);
const fitConflict = evaluateSpecializedModeFit('deep_research', conflict);
assert.equal(fitConflict.ok, false);
assert.equal(fitConflict.ok === false && fitConflict.action, 'clarify');

// Folder name containing 시장조사 must NOT fake research intent.
const pathOnlyTeam =
  '\\\\nas\\공용_시장조사팀\\배송요청\\완료 레거시 양식 주소쪽 확인해봐';
assert.equal(looksLikeInspectFilesTask(pathOnlyTeam), true);
assert.equal(evaluateSpecializedModeFit('deep_research', pathOnlyTeam).ok, false);
assert.equal(
  evaluateSpecializedModeFit('deep_research', pathOnlyTeam).ok === false
    && evaluateSpecializedModeFit('deep_research', pathOnlyTeam).action,
  'reroute',
);
assert.equal(matchFastSkillRoutes(pathOnlyTeam)?.mode, 'web_dev');

const marketOk = '/심층리서치 summer cargo market pain heat pocket';
assert.equal(looksLikeInspectFilesTask(marketOk), false);
assert.equal(evaluateSpecializedModeFit('deep_research', marketOk).ok, true);
assert.equal(matchMarketResearchRoute('경쟁사 시장조사 해줘')?.mode, 'deep_research');

const explicitFit = evaluateSpecializedModeFit('deep_research', nasMsg);
assert.equal(explicitFit.ok, false);

const {
  looksLikeProductBuildTask,
} = await import('../core/dist/router/route-task-gate.js');

const extMsg = [
  '이걸 표준화해서, 구글 익스탠션 프로그램으로 만들거야. 예를 들어 Gabriel Betancourt',
  '',
  '9870 SW 32nd St',
  'Miami, FL  33165',
  'United States',
  '',
  '786-724-6411',
  '',
  'Tacticalvillainsinc@gmail.com 이런식의 정보를 긁어넣으면 (순서,  양식 등 다양할 수 있음, 한국 주소 입력할 수도 있음) 그러면 알아서 나눠주는거야. 한국 주소를 넣으면 한글주소, 영문주소 모두 나오는 식으로.',
].join('\n');

assert.equal(looksLikeProductBuildTask(extMsg), true);
assert.equal(blocksSpecializedPipelineModes(extMsg), true);
assert.equal(matchFastSkillRoutes(extMsg)?.mode, 'web_dev');
assert.equal(evaluateSpecializedModeFit('browser_agent', extMsg).ok, false);
assert.equal(
  evaluateSpecializedModeFit('browser_agent', extMsg).ok === false
    && evaluateSpecializedModeFit('browser_agent', extMsg).action,
  'reroute',
);
console.log('verify-route-task-gate: ok');
