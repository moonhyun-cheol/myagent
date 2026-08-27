import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UserSkillStore, isUserSkillMode, parseUserSkillId, userSkillMode } from './user-skill-store.js';
import { resolveOrganizationModuleRoot } from './organization-module-root.js';
import {
  getOrganizationSkillDef,
  isOrgSkillMode,
  listOrganizationSkillDefs,
  overlayBrandFiles,
  parseOrgSkillId,
} from './organization-skill-store.js';

export { resolveOrganizationModuleRoot, resolveOrganizationBrandManualUrl } from './organization-module-root.js';

export interface SkillDef {
  label: string;
  mode: string;
  feature?: string;
  brand_files: string[];
  bundle_files: string[];
  pipeline_script?: string;
}

interface SkillsManifest {
  version: number;
  skills: Record<string, SkillDef>;
}

const MAX_PROMPT_CHARS = 120_000;

export { MAX_PROMPT_CHARS };

export interface SkillListItem {
  id: string;
  label: string;
  mode: string;
  source: 'bundled' | 'user' | 'organization';
  editable: boolean;
  removable?: boolean;
  install_kind?: 'prompt' | 'package';
  description?: string;
  file_count?: number;
  feature?: string;
}

function defaultsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Prefer source tree (core/config/defaults) so skill MD edits apply without full rebuild.
  // Then packaged copy next to dist (core/dist/config/defaults).
  const candidates = [
    path.join(here, '..', '..', 'config', 'defaults'),
    path.join(here, '..', 'config', 'defaults'),
    path.join(here, 'config', 'defaults'),
  ];
  for (const p of candidates) {
    if (existsSync(path.join(p, 'skills', 'manifest.json'))) return p;
  }
  return candidates[0];
}

function loadManifest(): SkillsManifest {
  const manifestPath = path.join(defaultsDir(), 'skills', 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { version: 1, skills: {} };
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as SkillsManifest;
}

function readPromptFile(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  try {
    return readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
}

export function getSkillDef(skillId: string): SkillDef | null {
  const manifest = loadManifest();
  return manifest.skills[skillId] ?? null;
}

function effectiveBundledDef(skillId: string, cqrRoot: string): SkillDef | null {
  const def = getSkillDef(skillId);
  if (!def) return null;
  const brandFiles = overlayBrandFiles(skillId, cqrRoot);
  if (!brandFiles) return def;
  return { ...def, brand_files: brandFiles };
}

/**
 * Load skill prompt parts with per-slot organization-module → bundle fallback.
 */
export function loadSkillPromptParts(
  def: SkillDef,
  cqrRoot: string,
): { parts: string[]; sources: string[] } {
  const brandRoot = resolveOrganizationModuleRoot(cqrRoot);
  const defaults = defaultsDir();
  const parts: string[] = [];
  const sources: string[] = [];
  const n = Math.max(def.brand_files.length, def.bundle_files.length);

  for (let i = 0; i < n; i++) {
    const brandRel = def.brand_files[i];
    const bundleRel = def.bundle_files[i];
    let text: string | null = null;
    let source = '';

    if (brandRoot && brandRel) {
      const brandPath = path.join(brandRoot, brandRel);
      text = readPromptFile(brandPath);
      if (text) source = `brand:${brandRel}`;
    }
    if (!text && bundleRel) {
      const bundlePath = path.join(defaults, bundleRel);
      text = readPromptFile(bundlePath);
      if (text) source = `bundle:${bundleRel}`;
    }
    if (text) {
      parts.push(text);
      sources.push(source);
    }
  }

  return { parts, sources };
}

export function getSkillSystemPrompt(
  skillId: string,
  cqrRoot: string,
  opts?: { tier?: 'slim' | 'full' },
): string | null {
  const def = effectiveBundledDef(skillId, cqrRoot) ?? getOrganizationSkillDef(skillId, cqrRoot);
  if (!def) return null;

  const { parts } = loadSkillPromptParts(def, cqrRoot);
  if (parts.length === 0) return null;

  let combined = parts.join('\n\n---\n\n');

  // prompt_master: slim tier = context + PRIMACY only (MIDDLE ZONE deferred until target inject).
  if (skillId === 'prompt_master' && (opts?.tier ?? 'slim') === 'slim') {
    combined = trimPromptMasterToPrimary(combined);
  }

  if (combined.length > MAX_PROMPT_CHARS) {
    combined = combined.slice(0, MAX_PROMPT_CHARS) + '\n\n[... prompt truncated for context limit ...]';
  }
  return combined;
}

/** Keep PRIMACY + OUTPUT; drop encyclopedic MIDDLE ZONE tool tables until target detect. */
export function trimPromptMasterToPrimary(md: string): string {
  const text = String(md || '');
  const cut = text.search(/^## MIDDLE ZONE\b/m);
  if (cut < 0) {
    if (text.length > 10_000) {
      return `${text.slice(0, 8_000)}\n\n[... prompt_master middle zone deferred until target detect ...]`;
    }
    return text;
  }
  return text.slice(0, cut).trimEnd();
}

export function getSkillMode(skillId: string): string | null {
  return getSkillDef(skillId)?.mode ?? null;
}

export function listSkillModes(): string[] {
  const manifest = loadManifest();
  return Object.values(manifest.skills).map((s) => s.mode);
}

export function skillIdForMode(mode: string, cqrRoot?: string): string | null {
  const manifest = loadManifest();
  for (const [id, def] of Object.entries(manifest.skills)) {
    if (def.mode === mode) return id;
  }
  if (cqrRoot) {
    const orgId = parseOrgSkillId(mode);
    if (orgId && getOrganizationSkillDef(orgId, cqrRoot)) return orgId;
  }
  return null;
}

export function resolvePipelineScript(skillId: string, cqrRoot: string): string | null {
  const def = getSkillDef(skillId) ?? getOrganizationSkillDef(skillId, cqrRoot);
  if (!def?.pipeline_script) return null;
  const brandRoot = resolveOrganizationModuleRoot(cqrRoot);
  if (!brandRoot) return null;
  const script = path.join(brandRoot, def.pipeline_script);
  return existsSync(script) ? script : null;
}

function userSkillStore(cqrRoot: string): UserSkillStore {
  return new UserSkillStore(path.join(cqrRoot, 'data', 'skills'), cqrRoot);
}

export function listBundledSkills(): SkillListItem[] {
  const manifest = loadManifest();
  return Object.entries(manifest.skills).map(([id, def]) => ({
    id,
    label: def.label,
    mode: def.mode,
    source: 'bundled' as const,
    editable: false,
    feature: def.feature,
  }));
}

export function listAllSkills(cqrRoot: string): SkillListItem[] {
  const bundled = listBundledSkills();
  const organization = listOrganizationSkillDefs(cqrRoot).map(({ id, def }) => ({
    id,
    label: def.label,
    mode: def.mode,
    source: 'organization' as const,
    editable: false,
    removable: false,
    feature: def.feature,
  }));
  const user = userSkillStore(cqrRoot)
    .list()
    .map((rec) => ({
      id: rec.id,
      label: rec.label,
      mode: userSkillMode(rec.id),
      source: 'user' as const,
      editable: rec.install_kind !== 'package',
      removable: true,
      install_kind: rec.install_kind ?? 'prompt',
      description: rec.description,
      file_count: rec.file_count,
    }));
  return [...bundled, ...organization, ...user];
}

export function isBundledSkillId(id: string): boolean {
  return getSkillDef(id) !== null;
}

export function getSkillSystemPromptByMode(
  mode: string,
  cqrRoot: string,
  opts?: { tier?: 'slim' | 'full' },
): string | null {
  if (isUserSkillMode(mode)) {
    const userId = parseUserSkillId(mode);
    if (!userId) return null;
    return userSkillStore(cqrRoot).readPrompt(userId);
  }
  if (isOrgSkillMode(mode)) {
    const orgId = parseOrgSkillId(mode);
    if (!orgId) return null;
    return getSkillSystemPrompt(orgId, cqrRoot, opts);
  }
  const skillId = skillIdForMode(mode, cqrRoot);
  if (!skillId) return null;
  return getSkillSystemPrompt(skillId, cqrRoot, opts);
}
