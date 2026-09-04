import type { ChatMode, RouteDecision } from '../router/types.js';
import { SKILL_CHAT_MODES } from '../router/types.js';
import { getSkillSystemPromptByMode } from './skill-registry.js';
import { isOrgSkillMode } from './organization-skill-store.js';
import { isUserSkillMode } from './user-skill-store.js';
import { shouldIncludeDesignFirst } from './web-landing-bundle.js';
import { augmentSkillSystemPrompt } from './skill-routing-augment.js';
import {
  isSelfWorkspace,
  stripCqrSelfSkillSections,
} from '../agent/agent-product-memory.js';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function isSkillChatMode(mode: ChatMode): boolean {
  return (SKILL_CHAT_MODES as string[]).includes(mode);
}

export function resolveLlmSkillMode(mode: ChatMode): ChatMode | null {
  if (isSkillChatMode(mode)) return mode;
  if (isUserSkillMode(mode)) return mode;
  if (isOrgSkillMode(mode)) return mode;
  return null;
}

/**
 * Skill profile for the workspace agent plane (R-301, RC-013).
 * Use the actual route. Workspace binding must not rewrite `chat` → `web_dev`.
 * Default chat + workspace gate → null (thin agent prompt only).
 * Explicit skill/mode → full skill system prompt.
 */
export function resolveAgentSkillMode(rawRouting: RouteDecision): ChatMode | null {
  return resolveLlmSkillMode(rawRouting.mode);
}

export function isStreamableLlmSkillMode(mode: string): boolean {
  return isSkillChatMode(mode as ChatMode) || isUserSkillMode(mode) || isOrgSkillMode(mode);
}

export type ResolveSkillSystemPromptOptions = {
  /** When set, product-layout skill sections apply only to the product workspace. */
  workspaceRoot?: string;
};

function skillsDefaultsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, '..', '..', 'config', 'defaults', 'skills'),
    path.join(here, '..', 'config', 'defaults', 'skills'),
  ];
  for (const p of candidates) {
    if (existsSync(path.join(p, 'web-design-first-ui.md'))) return p;
  }
  return candidates[0]!;
}

function appendDesignFirstIfNeeded(base: string, userMessage: string): string {
  if (!shouldIncludeDesignFirst(userMessage)) return base;
  const p = path.join(skillsDefaultsDir(), 'web-design-first-ui.md');
  if (!existsSync(p)) return base;
  try {
    const text = readFileSync(p, 'utf8').trim();
    if (!text) return base;
    return `${base}\n\n---\n\n${text}`;
  } catch {
    return base;
  }
}

export function resolveSkillSystemPrompt(
  mode: ChatMode,
  cqrRoot: string,
  userMessage?: string,
  opts?: ResolveSkillSystemPromptOptions,
): string | null {
  let base = getSkillSystemPromptByMode(mode, cqrRoot);
  if (!base) return null;
  const selfProductMemory =
    opts?.workspaceRoot != null
      ? isSelfWorkspace(opts.workspaceRoot, cqrRoot)
      : true;
  if (!selfProductMemory) {
    base = stripCqrSelfSkillSections(base);
  }
  const msg = userMessage?.trim() ?? '';
  // Legacy web_landing/prompt_master modes removed — landing-style work runs inside web_dev.
  // The thin design-first guide is appended only when the request looks like visual/landing work.
  if (mode === 'web_dev' && msg) {
    base = appendDesignFirstIfNeeded(base, msg);
  }
  return augmentSkillSystemPrompt(mode, base, { selfProductMemory });
}
