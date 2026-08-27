import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { sanitizeSkillId } from './user-skill-store.js';
import { resolveOrganizationModuleRoot } from './organization-module-root.js';

export interface OrganizationSkillDef {
  label: string;
  mode: string;
  feature?: string;
  brand_files: string[];
  bundle_files: string[];
  pipeline_script?: string;
}

export interface OrganizationSkillsManifest {
  version: number;
  overlays?: Record<string, { brand_files?: string[] }>;
  skills?: Record<string, Partial<OrganizationSkillDef> & { label: string; mode: string }>;
}

export function orgSkillMode(id: string): string {
  return `org:${id}`;
}

export function parseOrgSkillId(mode: string): string | null {
  if (!mode.startsWith('org:')) return null;
  return sanitizeSkillId(mode.slice(4));
}

export function isOrgSkillMode(mode: string): boolean {
  return parseOrgSkillId(mode) !== null;
}

export function loadOrganizationSkillsManifest(cqrRoot: string): OrganizationSkillsManifest | null {
  const brandRoot = resolveOrganizationModuleRoot(cqrRoot);
  if (!brandRoot) return null;
  const manifestPath = path.join(brandRoot, 'skills', 'manifest.json');
  if (!existsSync(manifestPath)) return null;
  try {
    const doc = JSON.parse(readFileSync(manifestPath, 'utf8')) as OrganizationSkillsManifest;
    if (!doc || typeof doc !== 'object') return null;
    return doc;
  } catch {
    return null;
  }
}

export function listOrganizationSkillDefs(cqrRoot: string): Array<{ id: string; def: OrganizationSkillDef }> {
  const manifest = loadOrganizationSkillsManifest(cqrRoot);
  if (!manifest?.skills) return [];
  const out: Array<{ id: string; def: OrganizationSkillDef }> = [];
  for (const [id, raw] of Object.entries(manifest.skills)) {
    const safeId = sanitizeSkillId(id);
    if (!safeId || !raw) continue;
    out.push({
      id: safeId,
      def: {
        label: raw.label,
        mode: raw.mode === orgSkillMode(safeId) ? raw.mode : orgSkillMode(safeId),
        feature: raw.feature,
        brand_files: Array.isArray(raw.brand_files) ? raw.brand_files : [],
        bundle_files: Array.isArray(raw.bundle_files) ? raw.bundle_files : [],
        pipeline_script: raw.pipeline_script,
      },
    });
  }
  return out;
}

export function getOrganizationSkillDef(skillId: string, cqrRoot: string): OrganizationSkillDef | null {
  return listOrganizationSkillDefs(cqrRoot).find((item) => item.id === skillId)?.def ?? null;
}

export function overlayBrandFiles(skillId: string, cqrRoot: string): string[] | null {
  const overlay = loadOrganizationSkillsManifest(cqrRoot)?.overlays?.[skillId];
  if (!overlay?.brand_files?.length) return null;
  return overlay.brand_files;
}
