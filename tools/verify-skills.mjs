#!/usr/bin/env node
/**
 * Neutral bundled skills hygiene — registry, landing, code, and prompt skills.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const {
  getSkillDef,
  getSkillSystemPrompt,
  listBundledSkills,
} = await import('../core/dist/skills/skill-registry.js');
const {
  shouldIncludeDesignFirst,
  shouldIncludeMotionHint,
  looksLikeWebPageBuildTask,
  augmentWebLandingSystemPrompt,
  WEB_LANDING_ANTI_SLOP,
  WEB_DEV_PAGE_ANTI_SLOP,
  WEB_DEV_PRODUCT_UI_HINT,
} = await import('../core/dist/skills/web-landing-bundle.js');
// --- manifest: neutral core exposes generic skills only ---
const manifest = JSON.parse(
  readFileSync(path.join(root, 'core/config/defaults/skills/manifest.json'), 'utf8'),
);
assert.deepEqual(Object.keys(manifest.skills).sort(), ['prompt_master', 'web_dev', 'web_landing']);
assert.ok(!manifest.skills.web_landing.bundle_files.includes('skills/web-design-first-ui.md'));
assert.deepEqual(
  listBundledSkills().map((skill) => skill.id).sort(),
  ['prompt_master', 'web_dev', 'web_landing'],
);

assert.equal(getSkillDef('organization_private_skill'), null);

// --- landing ---
assert.equal(shouldIncludeDesignFirst('히어로 HTML 만들어줘'), false);
assert.equal(shouldIncludeDesignFirst('디자인 스펙 먼저'), true);
assert.equal(shouldIncludeMotionHint('히어로만'), false);
assert.equal(shouldIncludeMotionHint('스크롤 모션 넣어줘'), true);
const land = augmentWebLandingSystemPrompt('BASE', '랜딩 만들어');
assert.match(land, /미검증|browser_screenshot/);
assert.match(land, /Inter/);
assert.match(land, /Anti-slop/);
assert.doesNotMatch(land, /Motion \(on-demand\)/);
const landMotion = augmentWebLandingSystemPrompt('BASE', '랜딩에 GSAP 모션');
assert.match(landMotion, /Motion \(on-demand\)/);
assert.match(WEB_LANDING_ANTI_SLOP, /pill-chip|card-grid/);
assert.match(WEB_DEV_PRODUCT_UI_HINT, /Product UI look/);

// --- web_dev Done / Exit Gate ---
const webDev = readFileSync(path.join(root, 'core/config/defaults/skills/web-dev.md'), 'utf8');
assert.match(webDev, /Exit Gate/);
assert.match(webDev, /실행계획:/);
assert.match(webDev, /Product UI look/);
assert.doesNotMatch(webDev, /emit a short `PLAN:`/);

// --- routing exposes no organization skill or automaton defaults ---
const routing = JSON.parse(
  readFileSync(path.join(root, 'core/config/defaults/routing.json'), 'utf8'),
);
const webDevRoute = routing.tools.find((t) => t.id === 'web_dev');
const automatonManifest = JSON.parse(
  readFileSync(path.join(root, 'core/config/defaults/automaton-tools.manifest.json'), 'utf8'),
);
assert.deepEqual(automatonManifest.tools, []);
const { listAutomatonTools } = await import('../core/dist/automaton/tool-catalog.js');
assert.deepEqual(listAutomatonTools(), []);
assert.ok(!webDevRoute.anchors_ko.includes('html'));
assert.ok(!webDevRoute.anchors_ko.includes('css'));

// --- web_landing vs web_dev goldens ---
const { matchWebLandingRoute, matchWebDevRoute, matchFastSkillRoutes } = await import(
  '../core/dist/router/route-heuristics.js'
);
assert.equal(matchWebLandingRoute('랜딩 페이지 히어로 만들어줘')?.mode, 'web_landing');
assert.equal(matchWebLandingRoute('랜딩 만들어')?.mode, 'web_landing');
assert.equal(matchFastSkillRoutes('src/app.ts 버그 수정')?.mode, 'web_dev');
const landDev = matchFastSkillRoutes('랜딩 페이지와 백엔드 API 연동 코드');
// landing anchors win fast path when landing words present
assert.ok(landDev, 'landing+code message routes');
assert.ok(
  landDev.mode === 'web_landing' || landDev.mode === 'web_dev',
  `unexpected mode ${landDev.mode}`,
);

// --- prompt_master tier slim ---
const { trimPromptMasterToPrimary } = await import('../core/dist/skills/skill-registry.js');
const slimPm = getSkillSystemPrompt('prompt_master', root);
assert.ok(slimPm && slimPm.length < 14_000, `prompt_master slim too large: ${slimPm?.length}`);
assert.ok(trimPromptMasterToPrimary('X\n## MIDDLE ZONE\nY').endsWith('X'));

console.log('verify-skills: ok');
