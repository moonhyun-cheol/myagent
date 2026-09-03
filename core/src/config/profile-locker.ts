/**
 * Work-kit locker: brand groups + shelves under personal pack / bundled seeds.
 * Layer: config-store only — never harness / agent-run-loop.
 */
import { assertWritablePath } from '../security/path-guard.js';
import { loadDeployDefaults } from './deploy-defaults.js';
import { loadUserOverrides } from './user-overrides.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  cpSync,
} from 'node:fs';

export const SHELF_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const GROUP_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type ShelfPullSlot = 'agent-plugins' | 'skills';
export type ShelfOrigin = 'locker' | 'bundled' | 'catalog';
export type ShelfInstallStatus =
  | 'available'
  | 'installed'
  | 'update_available'
  | 'missing_asset';

export interface WorkKitFeedShelfAsset {
  sequence?: number;
  name?: string;
  size?: number;
  sha256?: string;
  url?: string;
  repository?: string;
  release_tag?: string;
}

export interface WorkKitFeedShelf {
  id: string;
  label: string;
  description?: string;
  pull?: ShelfPullSlot[];
  plugins?: { enable?: Record<string, boolean> };
  hints?: {
    needs_organization_module?: boolean;
  };
  min_core_sequence?: number;
  asset?: WorkKitFeedShelfAsset;
}

export interface WorkKitFeedGroup {
  id: string;
  label: string;
  order?: number;
  shelves?: WorkKitFeedShelf[];
}

export interface WorkKitCatalogFeedDoc {
  channel: string;
  sequence: number;
  groups: WorkKitFeedGroup[];
  feed_url?: string | null;
  cached_at?: string;
}

export interface ShelfGroupMeta {
  id: string;
  label: string;
  order?: number;
}

export interface WorkKitShelf {
  schema_version: 1;
  id: string;
  group: string;
  label: string;
  description?: string;
  pull: ShelfPullSlot[];
  plugins: { enable: Record<string, boolean> };
  hints?: {
    needs_organization_module?: boolean;
  };
  min_core_sequence?: number;
  origin: ShelfOrigin;
  /** Absolute path to shelf directory (locker or seeded copy target). */
  shelf_dir: string;
  install_status?: ShelfInstallStatus;
  feed_asset_sequence?: number;
}

export interface WorkKitCatalogGroup {
  id: string;
  label: string;
  order: number;
  shelves: WorkKitShelf[];
}

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Personal pack / locker root — path only, never a git host URL. */
export function resolveLockerRoot(opts?: {
  override?: string;
  /** From user-overrides or deploy-defaults (filesystem path). */
  configuredRoot?: string;
}): string {
  const override = opts?.override?.trim();
  if (override) return path.resolve(override);
  const fromEnv = (
    process.env.CQR_PERSONAL_PACK?.trim()
    || process.env.MY_AGENT_WORK_KIT_LOCKER?.trim()
    || ''
  );
  if (fromEnv) return path.resolve(fromEnv);
  const configured = opts?.configuredRoot?.trim();
  if (configured && !looksLikeRemoteUrl(configured)) {
    return path.resolve(configured);
  }
  return path.join(os.homedir(), 'Documents', 'MY_AGENT_personal_pack');
}

function looksLikeRemoteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) || /^git@/i.test(value);
}

/** Resolve locker using cqrRoot deploy + user config (host-agnostic). */
export function resolveLockerRootForCqr(
  cqrRoot: string,
  opts?: { override?: string; configPath?: string },
): string {
  let configured: string | undefined;
  try {
    const deploy = loadDeployDefaults(cqrRoot);
    configured = deploy.work_kit_locker_root?.trim() || undefined;
  } catch {
    /* optional */
  }
  try {
    const configPath = opts?.configPath
      ?? path.join(cqrRoot, 'data', 'config', 'user-overrides.json');
    const overrides = loadUserOverrides(configPath);
    if (overrides.work_kit_locker_root?.trim()) {
      configured = overrides.work_kit_locker_root.trim();
    }
  } catch {
    /* optional */
  }
  return resolveLockerRoot({ override: opts?.override, configuredRoot: configured });
}

function lockerRootFromOpts(cqrRoot: string, opts?: { lockerRoot?: string }): string {
  if (opts?.lockerRoot?.trim()) return resolveLockerRoot({ override: opts.lockerRoot });
  return resolveLockerRootForCqr(cqrRoot);
}

export function lockerProfilesRoot(lockerRoot: string): string {
  return path.join(path.resolve(lockerRoot), 'profiles');
}

export function catalogFeedCachePath(lockerRoot: string): string {
  return path.join(path.resolve(lockerRoot), '.catalog-feed.json');
}

export function readCatalogFeedCache(lockerRoot: string): WorkKitCatalogFeedDoc | null {
  return readJson<WorkKitCatalogFeedDoc>(catalogFeedCachePath(lockerRoot));
}

export function writeCatalogFeedCache(lockerRoot: string, doc: WorkKitCatalogFeedDoc): void {
  const file = catalogFeedCachePath(lockerRoot);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

export interface ShelfInstallMeta {
  asset_sequence: number;
  installed_at: string;
}

export function readInstallMeta(shelfDir: string): ShelfInstallMeta | null {
  return readJson<ShelfInstallMeta>(path.join(shelfDir, '.install-meta.json'));
}

export function writeInstallMeta(shelfDir: string, meta: ShelfInstallMeta): void {
  mkdirSync(shelfDir, { recursive: true });
  writeFileSync(path.join(shelfDir, '.install-meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

function isTemplateGroupOrShelf(name: string): boolean {
  return name.startsWith('_') || name.startsWith('.');
}

function bundledShelvesRoot(cqrRoot: string): string {
  const candidates = [
    path.join(cqrRoot, 'core', 'config', 'defaults', 'profile-shelves'),
    path.join(cqrRoot, 'core', 'dist', 'config', 'defaults', 'profile-shelves'),
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'defaults', 'profile-shelves'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0];
}

function normalizePull(raw: unknown): ShelfPullSlot[] {
  if (!Array.isArray(raw)) return [];
  const out: ShelfPullSlot[] = [];
  for (const item of raw) {
    if (item === 'agent-plugins' || item === 'skills') {
      if (!out.includes(item)) out.push(item);
    }
  }
  return out;
}

function normalizeShelf(
  raw: Partial<WorkKitShelf>,
  group: string,
  id: string,
  origin: ShelfOrigin,
  shelfDir: string,
): WorkKitShelf | null {
  if (!GROUP_ID_RE.test(group) || !SHELF_ID_RE.test(id)) return null;
  if (raw.group && String(raw.group) !== group) return null;
  if (raw.id && String(raw.id) !== id) return null;
  const enable: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw.plugins?.enable ?? {})) {
    const pid = String(k).trim();
    if (pid) enable[pid] = v === true;
  }
  const minSeq = raw.min_core_sequence != null ? Number(raw.min_core_sequence) : undefined;
  // Legacy shelf.json may still carry a `ui` hint block; it is ignored (install-only scope).
  return {
    schema_version: 1,
    id,
    group,
    label: String(raw.label ?? id).trim().slice(0, 80) || id,
    description: raw.description ? String(raw.description).trim().slice(0, 400) : undefined,
    pull: normalizePull(raw.pull),
    plugins: { enable },
    hints: raw.hints?.needs_organization_module
      ? { needs_organization_module: true }
      : undefined,
    min_core_sequence:
      minSeq != null && Number.isSafeInteger(minSeq) && minSeq >= 1 ? minSeq : undefined,
    origin,
    shelf_dir: shelfDir,
  };
}

function scanGroupDir(
  groupDir: string,
  groupId: string,
  origin: ShelfOrigin,
): { meta: ShelfGroupMeta; shelves: WorkKitShelf[] } {
  const groupDoc = readJson<Partial<ShelfGroupMeta>>(path.join(groupDir, 'group.json'));
  const meta: ShelfGroupMeta = {
    id: groupId,
    label: String(groupDoc?.label ?? groupId).trim().slice(0, 80) || groupId,
    order: typeof groupDoc?.order === 'number' ? groupDoc.order : 100,
  };
  const shelves: WorkKitShelf[] = [];
  if (!existsSync(groupDir)) return { meta, shelves };
  for (const ent of readdirSync(groupDir, { withFileTypes: true })) {
    if (!ent.isDirectory() || isTemplateGroupOrShelf(ent.name)) continue;
    if (!SHELF_ID_RE.test(ent.name)) continue;
    const shelfDir = path.join(groupDir, ent.name);
    const raw = readJson<Partial<WorkKitShelf>>(path.join(shelfDir, 'shelf.json'));
    if (!raw) continue;
    const shelf = normalizeShelf(raw, groupId, ent.name, origin, shelfDir);
    if (shelf) shelves.push(shelf);
  }
  shelves.sort((a, b) => a.label.localeCompare(b.label, 'ko'));
  return { meta, shelves };
}

function scanProfilesTree(
  profilesRoot: string,
  origin: ShelfOrigin,
): Map<string, { meta: ShelfGroupMeta; shelves: WorkKitShelf[] }> {
  const map = new Map<string, { meta: ShelfGroupMeta; shelves: WorkKitShelf[] }>();
  if (!existsSync(profilesRoot)) return map;
  for (const ent of readdirSync(profilesRoot, { withFileTypes: true })) {
    if (!ent.isDirectory() || isTemplateGroupOrShelf(ent.name)) continue;
    if (!GROUP_ID_RE.test(ent.name)) continue;
    map.set(ent.name, scanGroupDir(path.join(profilesRoot, ent.name), ent.name, origin));
  }
  return map;
}

function feedShelfToCatalogShelf(
  groupId: string,
  feed: WorkKitFeedShelf,
  lockerShelf: WorkKitShelf | null,
  installStatus: ShelfInstallStatus,
): WorkKitShelf {
  const enable: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(feed.plugins?.enable ?? lockerShelf?.plugins.enable ?? {})) {
    const pid = String(k).trim();
    if (pid) enable[pid] = v === true;
  }
  const pull = normalizePull(feed.pull ?? lockerShelf?.pull);
  const origin: ShelfOrigin = lockerShelf ? 'locker' : 'catalog';
  return {
    schema_version: 1,
    id: feed.id,
    group: groupId,
    label: String(feed.label ?? feed.id).trim().slice(0, 80) || feed.id,
    description: feed.description
      ? String(feed.description).trim().slice(0, 400)
      : lockerShelf?.description,
    pull,
    plugins: { enable },
    hints: feed.hints?.needs_organization_module || lockerShelf?.hints?.needs_organization_module
      ? { needs_organization_module: true }
      : undefined,
    min_core_sequence: feed.min_core_sequence ?? lockerShelf?.min_core_sequence,
    origin,
    shelf_dir: lockerShelf?.shelf_dir ?? '',
    install_status: installStatus,
    feed_asset_sequence: feed.asset?.sequence,
  };
}

function computeInstallStatus(
  feedShelf: WorkKitFeedShelf | undefined,
  lockerShelf: WorkKitShelf | null,
): ShelfInstallStatus {
  const lockerDir = lockerShelf?.shelf_dir;
  const hasLocker = Boolean(lockerDir && existsSync(path.join(lockerDir, 'shelf.json')));
  if (!feedShelf?.asset) {
    return hasLocker ? 'installed' : 'missing_asset';
  }
  if (!hasLocker) return 'available';
  const meta = lockerDir ? readInstallMeta(lockerDir) : null;
  const feedSeq = feedShelf.asset.sequence ?? 0;
  const installedSeq = meta?.asset_sequence ?? 0;
  if (feedSeq > installedSeq) return 'update_available';
  return 'installed';
}

/**
 * Catalog = feed cache (authoritative list) merged with locker installs.
 * Bundled `_template` is excluded. Locker-only shelves (no feed) still appear.
 */
export function listWorkKitCatalog(cqrRoot: string, opts?: { lockerRoot?: string }): {
  locker_root: string;
  feed_sequence: number | null;
  groups: WorkKitCatalogGroup[];
} {
  const lockerRoot = lockerRootFromOpts(cqrRoot, opts);
  const lockerMap = scanProfilesTree(lockerProfilesRoot(lockerRoot), 'locker');
  const feed = readCatalogFeedCache(lockerRoot);
  const groupIds = new Set<string>([...lockerMap.keys()]);
  for (const g of feed?.groups ?? []) {
    if (GROUP_ID_RE.test(g.id)) groupIds.add(g.id);
  }

  const groups: WorkKitCatalogGroup[] = [];
  for (const gid of groupIds) {
    const locker = lockerMap.get(gid);
    const feedGroup = feed?.groups.find((g) => g.id === gid);
    const meta: ShelfGroupMeta = {
      id: gid,
      label: String(feedGroup?.label ?? locker?.meta.label ?? gid).trim().slice(0, 80) || gid,
      order: feedGroup?.order ?? locker?.meta.order ?? 100,
    };
    const byId = new Map<string, WorkKitShelf>();

    for (const feedShelf of feedGroup?.shelves ?? []) {
      if (!SHELF_ID_RE.test(feedShelf.id)) continue;
      const lockerShelf = locker?.shelves.find((s) => s.id === feedShelf.id) ?? null;
      const status = computeInstallStatus(feedShelf, lockerShelf);
      byId.set(feedShelf.id, feedShelfToCatalogShelf(gid, feedShelf, lockerShelf, status));
    }

    for (const lockerShelf of locker?.shelves ?? []) {
      if (byId.has(lockerShelf.id)) continue;
      byId.set(lockerShelf.id, {
        ...lockerShelf,
        install_status: 'installed',
      });
    }

    const shelves = [...byId.values()].sort((a, b) => a.label.localeCompare(b.label, 'ko'));
    if (shelves.length === 0) continue;
    groups.push({
      id: meta.id,
      label: meta.label,
      order: meta.order ?? 100,
      shelves,
    });
  }

  groups.sort((a, b) => (a.order - b.order) || a.label.localeCompare(b.label, 'ko'));
  return {
    locker_root: lockerRoot,
    feed_sequence: feed?.sequence ?? null,
    groups,
  };
}

export function findWorkKitShelf(
  cqrRoot: string,
  group: string,
  id: string,
  opts?: { lockerRoot?: string },
): WorkKitShelf | null {
  const { groups } = listWorkKitCatalog(cqrRoot, opts);
  const g = groups.find((x) => x.id === group);
  return g?.shelves.find((s) => s.id === id) ?? null;
}

/** Copy bundled shelf tree into locker (overwrite shelf.json + missing payload dirs). */
export function seedShelfToLocker(
  cqrRoot: string,
  shelf: WorkKitShelf,
  opts?: { lockerRoot?: string },
): string {
  if (shelf.origin !== 'bundled') return shelf.shelf_dir;
  const lockerRoot = lockerRootFromOpts(cqrRoot, opts);
  const dest = path.join(lockerProfilesRoot(lockerRoot), shelf.group, shelf.id);
  mkdirSync(dest, { recursive: true });
  const groupMetaDir = path.join(lockerProfilesRoot(lockerRoot), shelf.group);
  const groupJson = path.join(groupMetaDir, 'group.json');
  if (!existsSync(groupJson)) {
    const bundledGroup = path.join(bundledShelvesRoot(cqrRoot), shelf.group, 'group.json');
    if (existsSync(bundledGroup)) {
      cpSync(bundledGroup, groupJson);
    } else {
      writeFileSync(
        groupJson,
        `${JSON.stringify({ id: shelf.group, label: shelf.group.toUpperCase(), order: 10 }, null, 2)}\n`,
        'utf8',
      );
    }
  }
  // Copy entire bundled shelf dir → locker (files; nested missing handled by pull)
  cpSync(shelf.shelf_dir, dest, { recursive: true });
  return dest;
}

function assertNoEscape(name: string): boolean {
  if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) return false;
  if (path.isAbsolute(name)) return false;
  return SHELF_ID_RE.test(name) || /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name);
}

export interface ShelfPullResult {
  pulled_plugins: string[];
  pulled_skills: string[];
  warnings: string[];
}

/** Missing-only copy of pull slots into data/. */
export function pullShelfSlots(
  cqrRoot: string,
  shelfDir: string,
  pull: ShelfPullSlot[],
): ShelfPullResult {
  const warnings: string[] = [];
  const pulled_plugins: string[] = [];
  const pulled_skills: string[] = [];
  const root = path.resolve(cqrRoot);

  for (const slot of pull) {
    if (slot === 'agent-plugins') {
      const src = path.join(shelfDir, 'agent-plugins');
      const dest = path.join(root, 'data', 'agent-plugins');
      if (!existsSync(src)) {
        warnings.push('pull 슬롯 없음: agent-plugins');
        continue;
      }
      try {
        for (const ent of readdirSync(src, { withFileTypes: true })) {
          if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
          if (!assertNoEscape(ent.name)) {
            warnings.push(`거부된 플러그인 id: ${ent.name}`);
            continue;
          }
          const from = path.join(src, ent.name);
          const to = path.join(dest, ent.name);
          if (existsSync(to)) continue;
          if (!existsSync(path.join(from, 'tool.json'))) {
            warnings.push(`tool.json 없음: ${ent.name}`);
            continue;
          }
          assertWritablePath(to, cqrRoot);
          mkdirSync(dest, { recursive: true });
          cpSync(from, to, { recursive: true });
          pulled_plugins.push(ent.name);
        }
      } catch (e) {
        warnings.push(`agent-plugins pull 실패: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else if (slot === 'skills') {
      const src = path.join(shelfDir, 'skills');
      const destPackages = path.join(root, 'data', 'skills', 'packages');
      if (!existsSync(src)) {
        warnings.push('pull 슬롯 없음: skills');
        continue;
      }
      try {
        for (const ent of readdirSync(src, { withFileTypes: true })) {
          if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
          if (!assertNoEscape(ent.name)) {
            warnings.push(`거부된 스킬 id: ${ent.name}`);
            continue;
          }
          const from = path.join(src, ent.name);
          const to = path.join(destPackages, ent.name);
          if (existsSync(to)) continue;
          assertWritablePath(to, cqrRoot);
          mkdirSync(destPackages, { recursive: true });
          cpSync(from, to, { recursive: true });
          pulled_skills.push(ent.name);
        }
      } catch (e) {
        warnings.push(`skills pull 실패: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  return { pulled_plugins, pulled_skills, warnings };
}

export function readCoreUpdateSequence(cqrRoot: string): number {
  const candidates = [
    path.join(cqrRoot, 'manifest.json'),
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'manifest.json'),
  ];
  for (const p of candidates) {
    const doc = readJson<{ update_sequence?: number }>(p);
    const n = Number(doc?.update_sequence);
    if (Number.isSafeInteger(n) && n >= 1) return n;
  }
  return 1;
}
