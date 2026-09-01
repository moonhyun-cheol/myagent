#!/usr/bin/env node
/**
 * Scan live agent tool sources → core/config/defaults/agent-runtime-facts.json
 * Workspace behavior packs (Plan/Ask/Agent) — prefer over hardcoded tool lists in runtime.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readText(rel) {
  const abs = path.join(root, rel);
  if (!existsSync(abs)) return '';
  return readFileSync(abs, 'utf8');
}

const verifyLoop = readText('core/src/agent/verify-loop.ts');
const mutatingBlock = verifyLoop.match(/const MUTATING_TOOLS = new Set\(\[([\s\S]*?)\]\)/);
assert.ok(mutatingBlock, 'MUTATING_TOOLS block not found in verify-loop.ts');
const mutatingTools = [...mutatingBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
assert.ok(mutatingTools.length > 0, 'mutating_tools empty');

const toolDefs = readText('core/src/agent/agent-tool-definitions.ts');
const allToolNames = [...toolDefs.matchAll(/name: '([^']+)'/g)].map((m) => m[1]);
assert.ok(allToolNames.length > 0, 'no tools in agent-tool-definitions.ts');

const readOnlyInclude = [
  'read_file',
  'list_directory',
  'search_files',
  'query_repo_map',
  'search_embeddings',
  'git_status',
  'git_diff',
  'git_log',
  'git_show',
  'git_blame',
  'git_history_tree',
  'remote_git_inspect',
  'ast_grep_search',
  'repomix_pack',
  'markitdown_convert',
  'plugin_list',
  'task_history_search',
  'task_history_detail',
  'active_task',
];

for (const name of readOnlyInclude) {
  assert.ok(allToolNames.includes(name), `read_only tool missing from definitions: ${name}`);
}
for (const name of readOnlyInclude) {
  assert.ok(!mutatingTools.includes(name), `read_only tool is mutating: ${name}`);
}

const facts = {
  version: 1,
  generated_at: new Date().toISOString(),
  note: 'Build-generated. Re-run: node tools/sync-agent-runtime-facts.mjs',
  mutating_tools: mutatingTools.sort(),
  tool_packs: {
    read_only: {
      include: readOnlyInclude,
    },
    files: {
      extends: 'read_only',
      include_all_code_agent: true,
    },
  },
  behaviors: {
    agent: {
      tool_pack: 'files+browser',
      verify: 'full',
      autopilot_allowed: true,
    },
    plan: {
      tool_pack: 'read_only',
      verify: 'none',
      autopilot_allowed: false,
      system_skill: 'skills/plan-mode.md',
      persist_locked_constraints: true,
      ui_handoff: 'build',
      build_prompt:
        '위 PLAN을 Agent 모드로 구현해 주세요. Locked P0·대상 파일·단계만 따르고, Exit Gate 1개만 닫으세요. PLAN에 없는 리팩터·범위 확장 금지. verify로 증거를 남기세요.',
    },
    ask: {
      tool_plane: false,
      context: 'workspace_snippet',
    },
  },
  system_skills: {
    plan_mode: 'skills/plan-mode.md',
  },
};

const outDir = path.join(root, 'core', 'config', 'defaults');
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'agent-runtime-facts.json');
writeFileSync(outPath, `${JSON.stringify(facts, null, 2)}\n`, 'utf8');

console.log(
  `sync-agent-runtime-facts: ${mutatingTools.length} mutating, ${readOnlyInclude.length} read_only → ${path.relative(root, outPath)}`,
);
