import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readInstalledOrganizationModule } from '../updates/organization-module-installer.js';

/**
 * Core-owned video generation catalog. The organization module does not list
 * models; it only decides access (installed module ⇒ organization user).
 */
export interface VideoModelDef {
  id: string;
  label: string;
  duration: number;
  resolution: string;
  aspect_ratio: string;
  generate_audio: boolean;
}

interface VideoModelCatalog {
  version: number;
  models: VideoModelDef[];
}

let cached: VideoModelCatalog | null = null;

function catalogPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, '..', '..', 'config', 'defaults', 'video-models.json'),
    path.join(here, '..', 'config', 'defaults', 'video-models.json'),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

function sanitizeModel(raw: unknown): VideoModelDef | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const id = typeof m.id === 'string' ? m.id.trim() : '';
  if (!id || !id.includes('/')) return null;
  return {
    id,
    label: typeof m.label === 'string' && m.label.trim() ? m.label.trim() : id,
    duration: typeof m.duration === 'number' && m.duration > 0 ? m.duration : 4,
    resolution: typeof m.resolution === 'string' && m.resolution ? m.resolution : '720p',
    aspect_ratio: typeof m.aspect_ratio === 'string' && m.aspect_ratio ? m.aspect_ratio : '16:9',
    generate_audio: m.generate_audio === true,
  };
}

export function loadVideoModelCatalog(force = false): VideoModelCatalog {
  if (cached && !force) return cached;
  try {
    const doc = JSON.parse(readFileSync(catalogPath(), 'utf8')) as { version?: number; models?: unknown[] };
    const models = (Array.isArray(doc.models) ? doc.models : [])
      .map(sanitizeModel)
      .filter((m): m is VideoModelDef => m !== null);
    cached = { version: typeof doc.version === 'number' ? doc.version : 1, models };
  } catch {
    cached = { version: 0, models: [] };
  }
  return cached;
}

/** Catalog lookup only — does not check organization access. */
export function findVideoModel(modelId: string | undefined | null): VideoModelDef | null {
  const id = modelId?.trim();
  if (!id) return null;
  return loadVideoModelCatalog().models.find((m) => m.id === id) ?? null;
}

/** Organization users = an organization module is installed (signed-pack install path). */
export function hasOrganizationVideoAccess(cqrRoot: string): boolean {
  return readInstalledOrganizationModule(cqrRoot) !== null;
}

export function availableVideoModels(cqrRoot: string): VideoModelDef[] {
  return hasOrganizationVideoAccess(cqrRoot) ? loadVideoModelCatalog().models : [];
}
