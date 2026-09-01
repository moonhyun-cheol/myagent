import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDeployDefaults } from '../config/deploy-defaults.js';
import { UserSkillStore, isUserSkillMode, parseUserSkillId, userSkillMode } from './user-skill-store.js';
import {
  getOrganizationSkillDef,
  parseOrgSkillId,
} from './organization-skill-store.js';

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
  source: 'bundled' | 'user';
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

export function resolveOrganizationModuleRoot(cqrRoot: string): string | null {
  const env = process.env.MY_AGENT_ORGANIZATION_MODULE_ROOT?.trim();
  if (env && existsSync(env)) return path.resolve(env);

  const bundled = path.join(cqrRoot, 'modules', 'organization');
  if (existsSync(bundled)) return path.resolve(bundled);

  const deploy = loadDeployDefaults(cqrRoot);
  const configured = deploy.organization_module_root?.trim();
  if (configured && existsSync(configured)) return path.resolve(configured);

  return null;
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
  const def = getSkillDef(skillId);
  if (!def) return null;

  const { parts } = loadSkillPromptParts(def, cqrRoot);
  if (parts.length === 0) return null;

  let combined = parts.join('\n\n---\n\n');

  if (combined.length > MAX_PROMPT_CHARS) {
    combined = combined.slice(0, MAX_PROMPT_CHARS) + '\n\n[... prompt truncated for context limit ...]';
  }
  return combined;
}

export function getSkillMode(skillId: string): string | null {
  return getSkillDef(skillId)?.mode ?? null;
}

export function listSkillModes(): string[] {
  const manifest = loadManifest();
  return Object.values(manifest.skills).map((s) => s.mode);
}

export function skillIdForMode(mode: string): string | null {
  const manifest = loadManifest();
  for (const [id, def] of Object.entries(manifest.skills)) {
    if (def.mode === mode) return id;
  }
  return null;
}

export function resolvePipelineScript(skillId: string, cqrRoot: string): string | null {
  const def = getSkillDef(skillId);
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
  return [...bundled, ...user];
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
  const orgId = parseOrgSkillId(mode);
  if (orgId) {
    const def = getOrganizationSkillDef(orgId, cqrRoot);
    if (!def) return null;
    const { parts } = loadSkillPromptParts(
      {
        label: def.label,
        mode: def.mode,
        feature: def.feature,
        brand_files: def.brand_files,
        bundle_files: def.bundle_files,
        pipeline_script: def.pipeline_script,
      },
      cqrRoot,
    );
    if (parts.length === 0) return null;
    let combined = parts.join('\n\n---\n\n');
    if (combined.length > MAX_PROMPT_CHARS) {
      combined = combined.slice(0, MAX_PROMPT_CHARS) + '\n\n[... prompt truncated for context limit ...]';
    }
    return combined;
  }
  const skillId = skillIdForMode(mode);
  if (!skillId) return null;
  return getSkillSystemPrompt(skillId, cqrRoot, opts);
}
