import type { ChatMode, RouteDecision } from '../router/types.js';
import { SKILL_CHAT_MODES } from '../router/types.js';
import { getSkillSystemPromptByMode } from './skill-registry.js';
import { isOrgSkillMode } from './organization-skill-store.js';
import { isUserSkillMode } from './user-skill-store.js';
import { augmentSkillSystemPrompt } from './skill-routing-augment.js';
import {
  isSelfWorkspace,
  stripCqrSelfSkillSections,
} from '../agent/agent-product-memory.js';
import { existsSync } from 'node:fs';
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

/**
 * Stable pointer to the design-first guide for the selected web_dev skill.
 * The model decides whether to read it; request wording never inlines the guide.
 */
function appendDesignFirstPointer(base: string): string {
  const p = path.join(skillsDefaultsDir(), 'web-design-first-ui.md');
  if (!existsSync(p)) return base;
  return `${base}\n\nDesign-first guide (read with read_file when the request needs a design spec or prompt skeleton first): ${p.split(path.sep).join('/')}`;
}

export function resolveSkillSystemPrompt(
  mode: ChatMode,
  cqrRoot: string,
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
  // Legacy web_landing/prompt_master modes removed — landing-style work runs inside web_dev.
  if (mode === 'web_dev') {
    base = appendDesignFirstPointer(base);
  }
  base = augmentSkillSystemPrompt(mode, base, { selfProductMemory }) ?? base;
  if (isOrgSkillMode(mode)) {
    base = `${base.trim()}

---

## Organization skill turn lock
Ignore prior chat turns that were not produced under this same org skill mode.
Do not continue casual fashion-list / blog-concept formats from earlier messages.
Follow this skill's OUTPUT CONTRACT / CONCEPT_CORE (or equivalent) exactly for this turn.`;
  }
  return base;
}
