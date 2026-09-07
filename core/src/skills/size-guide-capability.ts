import { getOrganizationSkillDef } from './organization-skill-store.js';

/**
 * Ambient size-guide intent (parallel to brand-manual keyword inject).
 * Not slash-gated — plain questions should activate org:size_guide when installed.
 * Keep focused to avoid stealing unrelated chat (R-301 workspace_behavior is separate).
 */
const SIZE_GUIDE_INTENT_RE =
  /샘플\s*사이즈|사이즈\s*차트|사이즈\s*표|사이즈\s*추천|사이즈\s*가이드|맞는\s*사이즈|몇\s*사이즈|사이즈\s*(?:뭐|골라|추천|알려)|size\s*chart|sample\s*size|inseam|(?:허리|인심)\s*(?:사이즈|치수|몇|매칭)|fit\s*(?:size|chart)|오버\s*팬츠\s*사이즈/i;

export function matchSizeGuideIntent(message: string): boolean {
  const text = message.trim();
  if (!text || text.startsWith('/')) return false;
  return SIZE_GUIDE_INTENT_RE.test(text);
}

/** True when org module has size_guide and the user message looks like a size ask. */
export function shouldAutoRouteSizeGuide(message: string, cqrRoot: string): boolean {
  if (!matchSizeGuideIntent(message)) return false;
  return getOrganizationSkillDef('size_guide', cqrRoot) !== null;
}
