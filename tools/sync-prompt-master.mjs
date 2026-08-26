#!/usr/bin/env node
/**
 * Sync nidhinjs/prompt-master into MY Agent bundled skills.
 * Usage: node tools/sync-prompt-master.mjs [--vendor PATH]
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillsOut = path.join(root, 'core', 'config', 'defaults', 'skills');

function getArg(name) {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return null;
  return process.argv[i + 1];
}

function resolveVendor() {
  const arg = getArg('--vendor');
  if (arg && existsSync(arg)) return path.resolve(arg);
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const candidates = [
    path.join(home, '.cursor', 'skills-vendor', 'prompt-master'),
    path.join(home, '.cursor', 'skills', 'prompt-master'),
  ];
  for (const p of candidates) {
    if (existsSync(path.join(p, 'SKILL.md'))) return p;
  }
  const cloneTo = path.join(home, '.cursor', 'skills-vendor', 'prompt-master');
  mkdirSync(path.dirname(cloneTo), { recursive: true });
  execSync(`git clone --depth 1 https://github.com/nidhinjs/prompt-master.git "${cloneTo}"`, {
    stdio: 'inherit',
  });
  return cloneTo;
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function stripFrontmatter(text) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
}

function extractVersion(skillMd) {
  const m = skillMd.match(/^version:\s*([0-9.]+)\s*$/m);
  return m ? m[1] : 'unknown';
}

function adaptCore(text) {
  let out = stripFrontmatter(text)
    .replace(/\[references\/templates\.md\]\(references\/templates\.md\)/g, 'the **Prompt Templates Reference** section below')
    .replace(/references\/templates\.md/g, 'Prompt Templates Reference (below)')
    .replace(/\[references\/patterns\.md\]\(references\/patterns\.md\)/g, 'the **Credit-Killing Patterns Reference** section below')
    .replace(/references\/patterns\.md/g, 'Credit-Killing Patterns Reference (below)');

  // MY Agent: auto-detect target — do not force a tool-picker question.
  out = out.replace(
    /- Do not output a prompt without first confirming the target tool — ask if ambiguous/,
    '- When a **MY Agent auto-detected target** block is present, treat that tool as confirmed — do NOT ask the user to pick a tool unless they named two conflicting tools. Only ask if no auto-detect block exists and the target is truly ambiguous.',
  );

  // MY Agent output order: 대상 line first, then paste block.
  out = out.replace(
    /Output format:\r?\n1\. A single copyable prompt block ready to paste into the target tool\r?\n2\. 🎯 Target: \[tool name\],💡 \[One sentence — what was optimized and why\]\r?\n3\. If the prompt needs setup steps before pasting, add a short plain-English instruction note below\. 1-2 lines max\. ONLY when genuinely needed\./,
    [
      'Output format:',
      '1. One line: `🎯 대상: [tool] · [why]`',
      '2. A single copyable prompt block ready to paste into the target tool',
      '3. If the prompt needs setup steps before pasting, add a short instruction note below (Korean if the user writes Korean). 1-2 lines max. ONLY when genuinely needed.',
    ].join('\n'),
  );

  return out;
}

function stampContextVersion(version) {
  const contextPath = path.join(skillsOut, 'prompt-master-context.md');
  if (!existsSync(contextPath)) return;
  let ctx = stripBom(readFileSync(contextPath, 'utf8'));
  const next = ctx.replace(
    /nidhinjs\/prompt-master v[\d.]+/g,
    `nidhinjs/prompt-master v${version}`,
  );
  if (next !== ctx) writeFileSync(contextPath, next, 'utf8');
}

const vendor = resolveVendor();
mkdirSync(skillsOut, { recursive: true });

const coreSrc = path.join(vendor, 'SKILL.md');
const rawSkill = stripBom(readFileSync(coreSrc, 'utf8'));
const version = extractVersion(rawSkill);
writeFileSync(
  path.join(skillsOut, 'prompt-master-core.md'),
  adaptCore(rawSkill),
  'utf8',
);
copyFileSync(path.join(vendor, 'references', 'templates.md'), path.join(skillsOut, 'prompt-master-templates.md'));
copyFileSync(path.join(vendor, 'references', 'patterns.md'), path.join(skillsOut, 'prompt-master-patterns.md'));
stampContextVersion(version);

console.log('sync-prompt-master OK from', vendor, `(v${version})`);
console.log('  templates/patterns synced; context is hand-maintained (version stamp updated)');
console.log('  note: runtime injects selected templates only (see prompt-master-target.ts)');
