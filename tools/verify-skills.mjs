#!/usr/bin/env node
/**
 * Neutral bundled skills hygiene — registry, web_dev skill, routing.
 * Legacy web_landing / prompt_master modes were removed; landing-style work
 * runs inside web_dev and prompt-crafting runs inside chat.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { getSkillDef, getSkillSystemPrompt, listBundledSkills } = await import(
  '../core/dist/skills/skill-registry.js'
);
const webLandingBundle = await import('../core/dist/skills/web-landing-bundle.js');
const { WEB_DEV_PRODUCT_UI_HINT } = webLandingBundle;
const { resolveSkillSystemPrompt } = await import('../core/dist/skills/chat-skill-flow.js');

// --- manifest: neutral core exposes web_dev only ---
const manifest = JSON.parse(
  readFileSync(path.join(root, 'core/config/defaults/skills/manifest.json'), 'utf8'),
);
assert.deepEqual(Object.keys(manifest.skills).sort(), ['web_dev']);
assert.deepEqual(
  listBundledSkills().map((skill) => skill.id).sort(),
  ['web_dev'],
);

assert.equal(getSkillDef('organization_private_skill'), null);
assert.equal(getSkillDef('web_landing'), null);
assert.equal(getSkillDef('prompt_master'), null);

// --- web_dev thin UI extras ---
// Request wording never inlines the design-first guide; web_dev carries a stable pointer.
assert.equal('shouldIncludeDesignFirst' in webLandingBundle, false);
{
  const webDevPrompt = resolveSkillSystemPrompt('web_dev', root) ?? '';
  assert.match(webDevPrompt, /Design-first guide \(read with read_file[^\n]*web-design-first-ui\.md/);
  assert.doesNotMatch(webDevPrompt, /프롬프트 골격/, 'guide body must not be inlined');
  assert.equal(resolveSkillSystemPrompt('web_dev', root), webDevPrompt, 'web_dev prompt is stable');
}
assert.match(WEB_DEV_PRODUCT_UI_HINT, /Product UI look/);

// --- web_dev thin prompt (RC-015): no mandatory report / Exit Gate template ---
const webDev = readFileSync(path.join(root, 'core/config/defaults/skills/web-dev.md'), 'utf8');
assert.doesNotMatch(webDev, /Exit Gate/);
assert.doesNotMatch(webDev, /실행계획:/);
assert.doesNotMatch(webDev, /결론\s*→\s*미충족|Before done: list changed paths/i);
assert.match(webDev, /Do not force a completion-report template/);
assert.match(webDev, /Product UI look/);
assert.doesNotMatch(webDev, /emit a short `PLAN:`/);
const webDevPrompt = getSkillSystemPrompt('web_dev', root);
assert.ok(webDevPrompt && webDevPrompt.length > 0, 'web_dev skill prompt loads');

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

// --- legacy entry normalization (stored sessions stay readable) ---
const { parseChatRequest } = await import('../core/dist/chat/chat-request.js');
assert.equal(parseChatRequest(JSON.stringify({ message: 'x', mode: 'web_landing' })).mode, 'web_dev');
assert.equal(parseChatRequest(JSON.stringify({ message: 'x', mode: 'code_agent' })).mode, 'web_dev');
assert.equal(parseChatRequest(JSON.stringify({ message: 'x', mode: 'prompt_master' })).mode, 'chat');

console.log('verify-skills: ok');
