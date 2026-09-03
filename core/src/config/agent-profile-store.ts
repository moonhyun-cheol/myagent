/**
 * Work profiles: local overlay presets (data/profile/*.json) + brand work kits
 * (locker / bundled shelves). Layer: config-store + route + UI only.
 *
 * Install-only scope: a profile/kit copies its plugin + skill packages and toggles
 * `plugins.enable`. It carries no runtime hints (no pinned skills / default mode) —
 * the agent uses the installed skill registry and plugin list natively.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { assertWritablePath } from '../security/path-guard.js';
import {
  invalidateAgentPluginCache,
  listAgentPlugins,
  setAgentPluginEnabled,
} from '../agent/agent-plugin-store.js';
import {
  findWorkKitShelf,
  listWorkKitCatalog,
  pullShelfSlots,
  readCoreUpdateSequence,
  type WorkKitCatalogGroup,
  type WorkKitShelf,
} from './profile-locker.js';

export interface AgentProfile {
  id: string;
  label: string;
  description?: string;
  version: 2;
  plugins: {
    /** Only listed plugin ids are toggled on apply; others stay untouched. */
    enable: Record<string, boolean>;
  };
  created_at: string;
  updated_at: string;
}

export interface AgentProfileAppliedState {
  profile_id: string;
  group?: string;
  kit_id?: string;
  origin?: 'locker' | 'bundled' | 'overlay';
  applied_at: string;
}

interface AgentProfileAppliedDocument {
  schema_version: 2;
  entries: AgentProfileAppliedState[];
}

interface ProfileLastState {
  saved_at: string;
  plugins: Record<string, boolean>;
  /** @deprecated single-entry snapshot; use applied_entries */
  applied: AgentProfileAppliedState | null;
  applied_entries?: AgentProfileAppliedState[];
}

export interface ProfileApplyResult {
  ok: boolean;
  profile_id: string;
  group?: string;
  kit_id?: string;
  toggled: Array<{ id: string; enabled: boolean }>;
  pulled_plugins?: string[];
  pulled_skills?: string[];
  warnings: string[];
}

export class AgentProfileError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const APPLIED_FILE = '.applied.json';
const LAST_STATE_FILE = '.last-state.json';

export function profilesRoot(cqrRoot: string): string {
  return path.join(path.resolve(cqrRoot), 'data', 'profile');
}

function ensureDir(cqrRoot: string): string {
  const dir = profilesRoot(cqrRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function profilePath(cqrRoot: string, id: string): string {
  return path.join(profilesRoot(cqrRoot), `${id}.json`);
}

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJson(cqrRoot: string, file: string, doc: unknown): void {
  assertWritablePath(file, cqrRoot);
  writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
}

/**
 * Normalize a stored/incoming profile. Legacy hint blocks (`ui`, `tools`) from older
 * profile JSON are ignored rather than rejected, so existing files keep loading.
 */
function normalizeProfile(raw: Partial<AgentProfile>, id: string): AgentProfile {
  const now = new Date().toISOString();
  const enable: Record<string, boolean> = {};
  const rawEnable = raw.plugins?.enable ?? {};
  for (const [key, value] of Object.entries(rawEnable)) {
    const pid = String(key).trim();
    if (pid) enable[pid] = value === true;
  }
  return {
    id,
    label: String(raw.label ?? id).trim().slice(0, 80) || id,
    description: raw.description ? String(raw.description).trim().slice(0, 400) : undefined,
    version: 2,
    plugins: { enable },
    created_at: raw.created_at ?? now,
    updated_at: now,
  };
}

export function listAgentProfiles(cqrRoot: string): AgentProfile[] {
  const dir = profilesRoot(cqrRoot);
  if (!existsSync(dir)) return [];
  const out: AgentProfile[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    const doc = readJson<AgentProfile>(path.join(dir, name));
    if (doc && typeof doc.id === 'string' && PROFILE_ID_RE.test(doc.id)) {
      out.push(normalizeProfile(doc, doc.id));
    }
  }
  return out.sort((a, b) => a.label.localeCompare(b.label, 'ko'));
}

export function listWorkKitProfileCatalog(
  cqrRoot: string,
  opts?: { lockerRoot?: string },
): {
  locker_root: string;
  feed_sequence: number | null;
  groups: WorkKitCatalogGroup[];
  overlays: AgentProfile[];
  applied: AgentProfileAppliedState | null;
  applied_kits: AgentProfileAppliedState[];
  can_restore: boolean;
} {
  const cat = listWorkKitCatalog(cqrRoot, opts);
  const appliedKits = getAppliedProfileStates(cqrRoot);
  return {
    locker_root: cat.locker_root,
    feed_sequence: cat.feed_sequence,
    groups: cat.groups,
    overlays: listAgentProfiles(cqrRoot),
    applied: getAppliedProfileState(cqrRoot),
    applied_kits: appliedKits,
    can_restore: hasProfileLastState(cqrRoot),
  };
}

export function saveAgentProfile(
  cqrRoot: string,
  input: Partial<AgentProfile> & { id: string },
): AgentProfile {
  const id = String(input.id ?? '').trim();
  if (!PROFILE_ID_RE.test(id)) {
    throw new AgentProfileError(
      'PROFILE_INVALID_ID',
      '프로필 id는 소문자/숫자/-/_ 1~64자여야 합니다.',
    );
  }
  ensureDir(cqrRoot);
  const existing = readJson<AgentProfile>(profilePath(cqrRoot, id));
  const doc = normalizeProfile(
    { ...input, created_at: existing?.created_at },
    id,
  );
  writeJson(cqrRoot, profilePath(cqrRoot, id), doc);
  return doc;
}

export function deleteAgentProfile(cqrRoot: string, id: string): boolean {
  if (!PROFILE_ID_RE.test(String(id ?? ''))) return false;
  const file = profilePath(cqrRoot, id);
  if (!existsSync(file)) return false;
  assertWritablePath(file, cqrRoot);
  rmSync(file);
  return true;
}

export function getAppliedProfileStates(cqrRoot: string): AgentProfileAppliedState[] {
  return readAppliedDocument(cqrRoot).entries;
}

/**
 * Keep only install-state fields. Older `.applied.json` / `.last-state.json` entries
 * carried a `ui` hint block; it is dropped here so it disappears on the next write.
 */
function normalizeAppliedEntry(raw: unknown): AgentProfileAppliedState | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Partial<AgentProfileAppliedState>;
  if (typeof rec.profile_id !== 'string' || !rec.profile_id) return null;
  const origin = rec.origin === 'locker' || rec.origin === 'bundled' || rec.origin === 'overlay'
    ? rec.origin
    : undefined;
  const entry: AgentProfileAppliedState = {
    profile_id: rec.profile_id,
    applied_at: typeof rec.applied_at === 'string' && rec.applied_at
      ? rec.applied_at
      : new Date().toISOString(),
  };
  if (typeof rec.group === 'string' && rec.group) entry.group = rec.group;
  if (typeof rec.kit_id === 'string' && rec.kit_id) entry.kit_id = rec.kit_id;
  if (origin) entry.origin = origin;
  return entry;
}

function normalizeAppliedEntries(raw: unknown[]): AgentProfileAppliedState[] {
  return raw
    .map(normalizeAppliedEntry)
    .filter((entry): entry is AgentProfileAppliedState => entry !== null);
}

function readAppliedDocument(cqrRoot: string): AgentProfileAppliedDocument {
  const file = path.join(profilesRoot(cqrRoot), APPLIED_FILE);
  const raw = readJson<{ entries?: unknown } | Record<string, unknown>>(file);
  if (!raw) return { schema_version: 2, entries: [] };
  const entries = (raw as { entries?: unknown }).entries;
  if (Array.isArray(entries)) {
    return { schema_version: 2, entries: normalizeAppliedEntries(entries) };
  }
  const legacy = normalizeAppliedEntry(raw);
  return { schema_version: 2, entries: legacy ? [legacy] : [] };
}

function writeAppliedDocument(cqrRoot: string, entries: AgentProfileAppliedState[]): void {
  ensureDir(cqrRoot);
  const doc: AgentProfileAppliedDocument = { schema_version: 2, entries };
  writeJson(cqrRoot, path.join(profilesRoot(cqrRoot), APPLIED_FILE), doc);
}

export function isWorkKitApplied(
  cqrRoot: string,
  group: string,
  id: string,
): boolean {
  const g = String(group ?? '').trim();
  const kitId = String(id ?? '').trim();
  return getAppliedProfileStates(cqrRoot).some(
    (entry) => entry.group === g && entry.kit_id === kitId,
  );
}

export function getAppliedProfileState(cqrRoot: string): AgentProfileAppliedState | null {
  const entries = getAppliedProfileStates(cqrRoot);
  if (entries.length === 0) return null;
  if (entries.length === 1) return entries[0];
  const last = entries[entries.length - 1];
  return {
    profile_id: entries.map((entry) => entry.profile_id).join(' + '),
    group: last.group,
    kit_id: last.kit_id,
    origin: last.origin,
    applied_at: last.applied_at,
  };
}

export function hasProfileLastState(cqrRoot: string): boolean {
  return existsSync(path.join(profilesRoot(cqrRoot), LAST_STATE_FILE));
}

function snapshotBeforeApply(cqrRoot: string): void {
  const records = listAgentPlugins(cqrRoot, { useCache: false });
  const currentEnabled: Record<string, boolean> = {};
  for (const rec of records) currentEnabled[rec.id] = rec.enabled;
  const entries = getAppliedProfileStates(cqrRoot);
  ensureDir(cqrRoot);
  const snapshot: ProfileLastState = {
    saved_at: new Date().toISOString(),
    plugins: { ...currentEnabled },
    applied: getAppliedProfileState(cqrRoot),
    applied_entries: entries,
  };
  writeJson(cqrRoot, path.join(profilesRoot(cqrRoot), LAST_STATE_FILE), snapshot);
}

function toggleEnables(
  cqrRoot: string,
  enable: Record<string, boolean>,
): { toggled: Array<{ id: string; enabled: boolean }>; warnings: string[] } {
  invalidateAgentPluginCache(cqrRoot);
  const records = listAgentPlugins(cqrRoot, { useCache: false });
  const currentEnabled: Record<string, boolean> = {};
  for (const rec of records) currentEnabled[rec.id] = rec.enabled;
  const warnings: string[] = [];
  const toggled: Array<{ id: string; enabled: boolean }> = [];
  for (const [pid, want] of Object.entries(enable)) {
    if (!(pid in currentEnabled)) {
      warnings.push(`플러그인 없음(건너뜀): ${pid}`);
      continue;
    }
    if (currentEnabled[pid] === want) continue;
    const raw = setAgentPluginEnabled(cqrRoot, { id: pid, enabled: want, confirm: true });
    const doc = JSON.parse(raw) as { ok?: boolean; error?: string };
    if (doc.ok === true) toggled.push({ id: pid, enabled: want });
    else warnings.push(`플러그인 토글 실패: ${pid} (${doc.error ?? 'unknown'})`);
  }
  return { toggled, warnings };
}

export function applyAgentProfile(
  cqrRoot: string,
  input: {
    id: string;
    confirm?: boolean;
  },
): ProfileApplyResult {
  if (input.confirm !== true) {
    throw new AgentProfileError('PROFILE_CONFIRM_REQUIRED', 'apply에는 confirm=true가 필요합니다.');
  }
  const id = String(input.id ?? '').trim();
  const profile = readJson<AgentProfile>(profilePath(cqrRoot, id));
  if (!profile || !PROFILE_ID_RE.test(id)) {
    throw new AgentProfileError('PROFILE_NOT_FOUND', `프로필을 찾을 수 없습니다: ${id}`);
  }
  const normalized = normalizeProfile(profile, id);
  snapshotBeforeApply(cqrRoot);
  const { toggled, warnings } = toggleEnables(cqrRoot, normalized.plugins.enable);

  const applied: AgentProfileAppliedState = {
    profile_id: id,
    origin: 'overlay',
    applied_at: new Date().toISOString(),
  };
  writeAppliedDocument(cqrRoot, [applied]);

  return { ok: true, profile_id: id, toggled, warnings };
}

export function applyWorkKit(
  cqrRoot: string,
  input: {
    group: string;
    id: string;
    confirm?: boolean;
    lockerRoot?: string;
  },
): ProfileApplyResult {
  if (input.confirm !== true) {
    throw new AgentProfileError('PROFILE_CONFIRM_REQUIRED', 'apply에는 confirm=true가 필요합니다.');
  }
  const group = String(input.group ?? '').trim();
  const id = String(input.id ?? '').trim();
  if (isWorkKitApplied(cqrRoot, group, id)) {
    return {
      ok: true,
      profile_id: `${group}/${id}`,
      group,
      kit_id: id,
      toggled: [],
      warnings: [],
    };
  }

  let shelf: WorkKitShelf | null = findWorkKitShelf(cqrRoot, group, id, {
    lockerRoot: input.lockerRoot,
  });
  if (!shelf) {
    throw new AgentProfileError('PROFILE_NOT_FOUND', `작업 키트를 찾을 수 없습니다: ${group}/${id}`);
  }
  if (
    shelf.install_status !== 'installed'
    && shelf.install_status !== 'update_available'
  ) {
    throw new AgentProfileError(
      'PROFILE_NOT_INSTALLED',
      `작업 키트가 설치되지 않았습니다. 먼저 받기를 실행하세요: ${group}/${id}`,
    );
  }
  if (!shelf.shelf_dir || !existsSync(path.join(shelf.shelf_dir, 'shelf.json'))) {
    throw new AgentProfileError(
      'PROFILE_NOT_INSTALLED',
      `작업 키트 파일이 없습니다. 다시 받기를 실행하세요: ${group}/${id}`,
    );
  }

  const coreSeq = readCoreUpdateSequence(cqrRoot);
  if (shelf.min_core_sequence != null && coreSeq < shelf.min_core_sequence) {
    throw new AgentProfileError(
      'PROFILE_CORE_TOO_OLD',
      `이 키트는 코어 update_sequence >= ${shelf.min_core_sequence} 가 필요합니다 (현재 ${coreSeq}).`,
    );
  }

  snapshotBeforeApply(cqrRoot);

  const warnings: string[] = [];
  const shelfDir = shelf.shelf_dir;
  const origin = shelf.origin === 'catalog' ? 'locker' : shelf.origin;

  const pull = pullShelfSlots(cqrRoot, shelfDir, shelf.pull);
  warnings.push(...pull.warnings);
  if (shelf.hints?.needs_organization_module) {
    warnings.push('이 키트는 조직 모듈 스킬을 사용합니다. 설정 → 스킬 → 모듈에서 설치·적용하세요.');
  }
  invalidateAgentPluginCache(cqrRoot);

  const { toggled, warnings: toggleWarn } = toggleEnables(cqrRoot, shelf.plugins.enable);
  warnings.push(...toggleWarn);

  const profileKey = `${group}/${id}`;
  const applied: AgentProfileAppliedState = {
    profile_id: profileKey,
    group,
    kit_id: id,
    origin,
    applied_at: new Date().toISOString(),
  };
  const nextEntries = getAppliedProfileStates(cqrRoot).filter(
    (entry) => !(entry.origin === 'overlay' && !entry.group),
  );
  nextEntries.push(applied);
  writeAppliedDocument(cqrRoot, nextEntries);

  return {
    ok: true,
    profile_id: profileKey,
    group,
    kit_id: id,
    toggled,
    pulled_plugins: pull.pulled_plugins,
    pulled_skills: pull.pulled_skills,
    warnings,
  };
}

export function restoreAgentProfileLastState(
  cqrRoot: string,
  input: { confirm?: boolean },
): ProfileApplyResult {
  if (input.confirm !== true) {
    throw new AgentProfileError('PROFILE_CONFIRM_REQUIRED', 'restore에는 confirm=true가 필요합니다.');
  }
  const file = path.join(profilesRoot(cqrRoot), LAST_STATE_FILE);
  const snapshot = readJson<ProfileLastState>(file);
  if (!snapshot) {
    throw new AgentProfileError('PROFILE_NO_LAST_STATE', '되돌릴 스냅샷이 없습니다.');
  }
  const records = listAgentPlugins(cqrRoot, { useCache: false });
  const warnings: string[] = [];
  const toggled: Array<{ id: string; enabled: boolean }> = [];
  for (const rec of records) {
    const want = snapshot.plugins[rec.id];
    if (typeof want !== 'boolean' || want === rec.enabled) continue;
    const raw = setAgentPluginEnabled(cqrRoot, { id: rec.id, enabled: want, confirm: true });
    const doc = JSON.parse(raw) as { ok?: boolean; error?: string };
    if (doc.ok === true) toggled.push({ id: rec.id, enabled: want });
    else warnings.push(`플러그인 복원 실패: ${rec.id} (${doc.error ?? 'unknown'})`);
  }
  const appliedFile = path.join(profilesRoot(cqrRoot), APPLIED_FILE);
  const restoredEntries = normalizeAppliedEntries(
    Array.isArray(snapshot.applied_entries)
      ? snapshot.applied_entries
      : snapshot.applied
        ? [snapshot.applied]
        : [],
  );
  if (restoredEntries.length > 0) {
    writeAppliedDocument(cqrRoot, restoredEntries);
  } else if (existsSync(appliedFile)) {
    assertWritablePath(appliedFile, cqrRoot);
    rmSync(appliedFile);
  }
  return { ok: true, profile_id: snapshot.applied?.profile_id ?? '', toggled, warnings };
}

export interface AppliedWorkKitSummary {
  label: string | null;
  group: string | null;
  kit_id: string | null;
  install_status: string | null;
  kits: Array<{
    label: string;
    group: string;
    kit_id: string;
    install_status: string | null;
  }>;
}

/** For API (`GET /profiles` → `applied_work_kit`): applied kits + catalog install status. */
export function summarizeAppliedWorkKit(
  cqrRoot: string,
  opts?: { lockerRoot?: string },
): AppliedWorkKitSummary {
  const all = getAppliedProfileStates(cqrRoot);
  const entries = all.filter((entry) => entry.group && entry.kit_id);
  if (entries.length === 0) {
    const fallback = all[0];
    return {
      label: fallback?.profile_id ?? null,
      group: fallback?.group ?? null,
      kit_id: fallback?.kit_id ?? null,
      install_status: null,
      kits: [],
    };
  }
  const { groups } = listWorkKitCatalog(cqrRoot, opts);
  const kits = entries.map((entry) => {
    const g = groups.find((x) => x.id === entry.group);
    const shelf = g?.shelves.find((s) => s.id === entry.kit_id);
    return {
      label: shelf?.label ?? `${entry.group}/${entry.kit_id}`,
      group: entry.group!,
      kit_id: entry.kit_id!,
      install_status: shelf?.install_status ?? null,
    };
  });
  const last = kits[kits.length - 1];
  return {
    label: kits.map((kit) => kit.label).join(', '),
    group: last.group,
    kit_id: last.kit_id,
    install_status: last.install_status,
    kits,
  };
}
