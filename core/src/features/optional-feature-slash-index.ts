/**
 * Lightweight optional-feature slash index from the base organization module.
 * Contains prefix → feature_id → guidance only (no workflow / tokens).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveOrganizationModuleRoot } from '../skills/organization-module-root.js';
import { isOrganizationFeatureEnabled, sanitizeFeatureId } from './organization-feature-manager.js';
import type { FeatureRequiredInfo, OptionalFeatureSlashIndexDoc } from './organization-feature-types.js';

const INDEX_FILE = 'optional-feature-slash-index.json';

export function loadOptionalFeatureSlashIndex(cqrRoot: string): OptionalFeatureSlashIndexDoc | null {
  const orgRoot = resolveOrganizationModuleRoot(cqrRoot);
  if (!orgRoot) return null;
  const file = path.join(orgRoot, INDEX_FILE);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as OptionalFeatureSlashIndexDoc;
  } catch {
    return null;
  }
}

/**
 * If slash matches the optional index and the feature is not installed/enabled,
 * return a structured feature_required payload (never send to LLM).
 */
export function matchOptionalFeatureRequired(
  message: string,
  cqrRoot: string,
): FeatureRequiredInfo | null {
  const trimmed = message.trim();
  if (!trimmed.startsWith('/')) return null;
  const index = loadOptionalFeatureSlashIndex(cqrRoot);
  if (!index?.slashes?.length) return null;

  for (const entry of index.slashes) {
    const prefix = String(entry.prefix ?? '').trim();
    const featureId = sanitizeFeatureId(entry.feature_id);
    if (!prefix || !featureId) continue;
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`^${escaped}(?:\\s|$)`, 'i').test(trimmed)) continue;
    if (isOrganizationFeatureEnabled(cqrRoot, featureId)) return null;
    const slash = prefix;
    const messageKo = entry.message_ko?.trim()
      || `이 명령(\`${slash}\`)을 사용하려면 추가 기능 \`${featureId}\` 설치·활성화가 필요합니다. Work Kit을 적용하세요.`;
    return {
      feature_id: featureId,
      slash,
      message: messageKo,
    };
  }
  return null;
}
