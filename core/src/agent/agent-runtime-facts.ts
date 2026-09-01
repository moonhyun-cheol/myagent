import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { WorkspaceBehavior } from '../execution-policy.js';
import type { AgentToolPack } from './agent-tool-pack.js';

export type AgentRuntimeFacts = {
  version: number;
  generated_at?: string;
  note?: string;
  mutating_tools: string[];
  tool_packs: {
    read_only: { include: string[] };
    files?: { extends?: string; include_all_code_agent?: boolean };
  };
  behaviors: Record<
    WorkspaceBehavior,
    {
      tool_pack?: AgentToolPack | 'read_only';
      verify?: 'full' | 'none';
      autopilot_allowed?: boolean;
      tool_plane?: boolean;
      context?: string;
      system_skill?: string;
      persist_locked_constraints?: boolean;
      ui_handoff?: 'build' | 'none';
      build_prompt?: string;
    }
  >;
  system_skills?: { plan_mode?: string };
};

const DEFAULT_READ_ONLY = [
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

const DEFAULT_MUTATING = [
  'write_file',
  'edit_file',
  'apply_patch',
  'delete_file',
  'rename_file',
  'plugin_install',
  'plugin_set_enabled',
  'git_init',
  'git_stage',
  'git_commit',
];

/** Fallback when facts file missing — keep in sync with sync-agent-runtime-facts.mjs */
export const DEFAULT_PLAN_BUILD_PROMPT =
  '위 PLAN을 Agent 모드로 구현해 주세요. Locked P0·대상 파일·단계만 따르고, Exit Gate 1개만 닫으세요. PLAN에 없는 리팩터·범위 확장 금지. verify로 증거를 남기세요.';

function defaultsDir(cqrRoot: string): string[] {
  return [
    path.join(cqrRoot, 'core', 'config', 'defaults'),
    path.join(cqrRoot, 'core', 'dist', 'config', 'defaults'),
  ];
}

export function loadAgentRuntimeFacts(cqrRoot: string): AgentRuntimeFacts {
  for (const dir of defaultsDir(cqrRoot)) {
    const fp = path.join(dir, 'agent-runtime-facts.json');
    if (!existsSync(fp)) continue;
    try {
      const raw = JSON.parse(readFileSync(fp, 'utf8')) as AgentRuntimeFacts;
      if (raw?.mutating_tools?.length && raw?.tool_packs?.read_only?.include?.length) {
        return raw;
      }
    } catch {
      /* try next */
    }
  }
  return {
    version: 1,
    mutating_tools: DEFAULT_MUTATING,
    tool_packs: { read_only: { include: DEFAULT_READ_ONLY } },
    behaviors: {
      agent: { tool_pack: 'files+browser', verify: 'full', autopilot_allowed: true },
      plan: {
        tool_pack: 'read_only',
        verify: 'none',
        autopilot_allowed: false,
        system_skill: 'skills/plan-mode.md',
        persist_locked_constraints: true,
        ui_handoff: 'build',
        build_prompt: DEFAULT_PLAN_BUILD_PROMPT,
      },
      ask: { tool_plane: false, context: 'workspace_snippet' },
    },
    system_skills: { plan_mode: 'skills/plan-mode.md' },
  };
}

export function mutatingToolNames(cqrRoot: string): Set<string> {
  return new Set(loadAgentRuntimeFacts(cqrRoot).mutating_tools);
}

export function readOnlyToolNames(cqrRoot: string): Set<string> {
  return new Set(loadAgentRuntimeFacts(cqrRoot).tool_packs.read_only.include);
}

export function shouldUseWorkspaceToolPlane(behavior: WorkspaceBehavior): boolean {
  return behavior !== 'ask';
}

export function behaviorSkipsSilentVerify(behavior: WorkspaceBehavior, cqrRoot: string): boolean {
  const cfg = loadAgentRuntimeFacts(cqrRoot).behaviors[behavior];
  return cfg?.verify === 'none';
}

export function behaviorAllowsAutopilot(behavior: WorkspaceBehavior, cqrRoot: string): boolean {
  const cfg = loadAgentRuntimeFacts(cqrRoot).behaviors[behavior];
  return cfg?.autopilot_allowed !== false;
}

export function behaviorPersistsLockedConstraints(
  behavior: WorkspaceBehavior,
  cqrRoot: string,
): boolean {
  return loadAgentRuntimeFacts(cqrRoot).behaviors[behavior]?.persist_locked_constraints === true;
}

export function behaviorOffersBuildHandoff(
  behavior: WorkspaceBehavior,
  cqrRoot: string,
): boolean {
  return loadAgentRuntimeFacts(cqrRoot).behaviors[behavior]?.ui_handoff === 'build';
}

/** Forced pack for non-agent behaviors (e.g. plan → read_only). Agent returns undefined. */
export function resolveForcedToolPack(
  behavior: WorkspaceBehavior,
  cqrRoot: string,
): AgentToolPack | undefined {
  if (behavior === 'agent') return undefined;
  const pack = loadAgentRuntimeFacts(cqrRoot).behaviors[behavior]?.tool_pack;
  if (pack === 'read_only' || pack === 'files' || pack === 'browser' || pack === 'files+browser') {
    return pack;
  }
  return undefined;
}

export function resolveBehaviorToolPack(
  behavior: WorkspaceBehavior,
  cqrRoot: string,
  fallback: AgentToolPack,
): AgentToolPack {
  return resolveForcedToolPack(behavior, cqrRoot) ?? fallback;
}

export function loadPlanBuildPrompt(cqrRoot: string): string {
  const prompt = loadAgentRuntimeFacts(cqrRoot).behaviors.plan?.build_prompt?.trim();
  return prompt || DEFAULT_PLAN_BUILD_PROMPT;
}

export function loadPlanModeSystemNote(cqrRoot: string): string {
  const facts = loadAgentRuntimeFacts(cqrRoot);
  const rel = facts.system_skills?.plan_mode ?? facts.behaviors.plan?.system_skill ?? 'skills/plan-mode.md';
  for (const dir of defaultsDir(cqrRoot)) {
    const fp = path.join(dir, rel);
    if (!existsSync(fp)) continue;
    try {
      return readFileSync(fp, 'utf8').trim();
    } catch {
      /* try next */
    }
  }
  return '';
}
