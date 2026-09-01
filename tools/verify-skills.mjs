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
const { shouldIncludeDesignFirst, WEB_DEV_PRODUCT_UI_HINT } = await import(
  '../core/dist/skills/web-landing-bundle.js'
);

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
assert.equal(shouldIncludeDesignFirst('그냥 HTML 만들어줘'), false);
assert.equal(shouldIncludeDesignFirst('디자인 스펙 먼저'), true);
assert.match(WEB_DEV_PRODUCT_UI_HINT, /Product UI look/);

// --- web_dev Done / Exit Gate ---
const webDev = readFileSync(path.join(root, 'core/config/defaults/skills/web-dev.md'), 'utf8');
assert.match(webDev, /Exit Gate/);
assert.match(webDev, /실행계획:/);
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
