#!/usr/bin/env node
/**
 * Prompt Master — target detect + selective template inject (no live LLM).
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const {
  resolvePromptMasterTarget,
  templateLettersForTarget,
  shouldIncludePromptMasterPatterns,
  extractTemplateSections,
  augmentPromptMasterSystemPrompt,
  buildPromptMasterReferenceAppend,
} = await import('../core/dist/skills/prompt-master-target.js');

function expectTarget(msg, id) {
  const r = resolvePromptMasterTarget(msg);
  assert.equal(r.id, id, `target ${id}: ${msg} → ${r.id} (${r.reason})`);
}

expectTarget('미드저니용 패션 룩북 프롬프트', 'midjourney');
expectTarget('dalle 프롬프트로 포스터', 'dalle3');
expectTarget('이미지 프롬프트 짜줘 로고', 'dalle3');
expectTarget('negative prompt cfg 7', 'stable_diffusion');
expectTarget('comfyui 노드용', 'comfyui');
expectTarget('커서용 에이전트 프롬프트', 'cursor');
expectTarget('my_agent 코드 에이전트용 프롬프트', 'my_agent');
expectTarget('클로드 프롬프트 개선', 'claude');
expectTarget('그냥 프롬프트 마스터', 'general');

assert.deepEqual(templateLettersForTarget('midjourney', '룩북'), ['I', 'J']);
assert.deepEqual(templateLettersForTarget('my_agent', '구현 프롬프트'), ['G', 'H', 'M']);
assert.ok(templateLettersForTarget('general', '이 프롬프트 고쳐줘').includes('L'));
assert.equal(shouldIncludePromptMasterPatterns('이 프롬프트 개선해줘'), true);
assert.equal(shouldIncludePromptMasterPatterns('미드저니용 룩북'), false);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const templatesPath = path.join(root, 'core/config/defaults/skills/prompt-master-templates.md');
assert.ok(existsSync(templatesPath), 'templates file present');
const templates = readFileSync(templatesPath, 'utf8');
const selected = extractTemplateSections(templates, ['I', 'G']);
assert.match(selected, /Template I/);
assert.match(selected, /Template G/);
assert.doesNotMatch(selected, /Template K —/);

const refs = buildPromptMasterReferenceAppend('midjourney', '미드저니 룩북');
assert.match(refs, /Template I/);
assert.doesNotMatch(refs, /Credit-Killing Patterns/);

const corePath = path.join(root, 'core/config/defaults/skills/prompt-master-core.md');
const core = readFileSync(corePath, 'utf8');
assert.match(core, /auto-detected target/);
assert.doesNotMatch(core, /Do not output a prompt without first confirming the target tool/);
assert.match(core, /🎯 대상:/);

const augmented = augmentPromptMasterSystemPrompt('BASE', 'my_agent 코드 에이전트용 프롬프트');
assert.match(augmented, /my_agent/);
assert.match(augmented, /🎯 대상:/);
assert.match(augmented, /Loaded templates: G, H, M/);
assert.match(augmented, /Template G/);

// Slim system base under previous 28k full dump
const {
  getSkillSystemPrompt,
  trimPromptMasterToPrimary,
} = await import('../core/dist/skills/skill-registry.js');
const basePm = getSkillSystemPrompt('prompt_master', root);
assert.ok(basePm);
assert.ok(basePm.length < 14_000, `slim base ${basePm.length}`);
assert.ok(basePm.includes('PRIMACY') || basePm.includes('Hard rules'));
assert.ok(!/^## MIDDLE ZONE/m.test(basePm) || trimPromptMasterToPrimary(core).length < core.length);

console.log('verify-prompt-master-target: ok');
