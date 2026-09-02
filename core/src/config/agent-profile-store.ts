/**
 * Work profiles: local overlay presets (data/profile/*.json) + brand work kits
 * (locker / bundled shelves). Layer: config-store + route + UI only.
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

export interface AgentProfileUi {
  /** Preferred skill/mode chip hint (no automatic session mutation on apply). */
  default_skill_mode?: string;
  /** Kit→N skill pins. Persisted on apply; Settings skills list sorts + shows pin badges from this. */
  pinned_skill_ids: string[];
}

export interface AgentProfile {
  id: string;
  label: string;
  description?: string;
  version: 2;
  ui: AgentProfileUi;
  plugins: {
    /** Only listed plugin ids are toggled on apply; others stay untouched. */
    enable: Record<string, boolean>;
  };
  tools?: {
    /** Display/sort preference metadata only — never forced into tool packs. */
    preferred_plugin_ids: string[];
  };
  created_at: string;
  updated_at: string;
}

export interface AgentProfileAppliedState {
  profile_id: string;
  group?: string;
  kit_id?: string;
  origin?: 'locker' | 'bundled' | 'overlay';
  ui: AgentProfileUi;
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

function normalizeProfile(raw: Partial<AgentProfile>, id: string): AgentProfile {
  const now = new Date().toISOString();
  const enable: Record<string, boolean> = {};
  const rawEnable = raw.plugins?.enable ?? {};
  for (const [key, value] of Object.entries(rawEnable)) {
    const pid = String(key).trim();
    if (pid) enable[pid] = value === true;
  }
  const pinned = Array.isArray(raw.ui?.pinned_skill_ids)
    ? raw.ui.pinned_skill_ids.map((s) => String(s).trim()).filter(Boolean).slice(0, 32)
    : [];
  const preferred = Array.isArray(raw.tools?.preferred_plugin_ids)
    ? raw.tools.preferred_plugin_ids.map((s) => String(s).trim()).filter(Boolean).slice(0, 32)
    : [];
  return {
    id,
    label: String(raw.label ?? id).trim().slice(0, 80) || id,
    description: raw.description ? String(raw.description).trim().slice(0, 400) : undefined,
    version: 2,
    ui: {
      default_skill_mode: raw.ui?.default_skill_mode
        ? String(raw.ui.default_skill_mode).trim().slice(0, 80)
        : undefined,
      pinned_skill_ids: pinned,
    },
    plugins: { enable },
    tools: preferred.length ? { preferred_plugin_ids: preferred } : undefined,
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

function readAppliedDocument(cqrRoot: string): AgentProfileAppliedDocument {
  const file = path.join(profilesRoot(cqrRoot), APPLIED_FILE);
  const raw = readJson<AgentProfileAppliedDocument | AgentProfileAppliedState>(file);
  if (!raw) return { schema_version: 2, entries: [] };
  if (Array.isArray((raw as AgentProfileAppliedDocument).entries)) {
    const doc = raw as AgentProfileAppliedDocument;
    return {
      schema_version: 2,
      entries: doc.entries.filter((entry) => entry && typeof entry.profile_id === 'string'),
    };
  }
  const legacy = raw as AgentProfileAppliedState;
  if (typeof legacy.profile_id === 'string') {
    return { schema_version: 2, entries: [legacy] };
  }
  return { schema_version: 2, entries: [] };
}

function writeAppliedDocument(cqrRoot: string, entries: AgentProfileAppliedState[]): void {
  ensureDir(cqrRoot);
  const doc: AgentProfileAppliedDocument = { schema_version: 2, entries };
  writeJson(cqrRoot, path.join(profilesRoot(cqrRoot), APPLIED_FILE), doc);
}

function mergeAppliedUi(entries: AgentProfileAppliedState[]): AgentProfileUi {
  const pinned: string[] = [];
  const seen = new Set<string>();
  let defaultSkillMode: string | undefined;
  for (const entry of entries) {
    for (const sid of entry.ui.pinned_skill_ids ?? []) {
      if (!seen.has(sid)) {
        seen.add(sid);
        pinned.push(sid);
      }
    }
    if (entry.ui.default_skill_mode) {
      defaultSkillMode = entry.ui.default_skill_mode;
    }
  }
  return {
    pinned_skill_ids: pinned.slice(0, 32),
    default_skill_mode: defaultSkillMode,
  };
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
    ui: mergeAppliedUi(entries),
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
    knownSkillIds?: string[];
    knownSkillModes?: string[];
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

  if (input.knownSkillIds) {
    const known = new Set(input.knownSkillIds);
    for (const sid of normalized.ui.pinned_skill_ids) {
      if (!known.has(sid)) warnings.push(`핀 스킬 없음: ${sid}`);
    }
  }
  if (
    normalized.ui.default_skill_mode
    && input.knownSkillModes
    && !input.knownSkillModes.includes(normalized.ui.default_skill_mode)
  ) {
    warnings.push(`기본 스킬 모드 없음: ${normalized.ui.default_skill_mode}`);
  }

  const applied: AgentProfileAppliedState = {
    profile_id: id,
    origin: 'overlay',
    ui: normalized.ui,
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
    knownSkillIds?: string[];
    knownSkillModes?: string[];
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

  if (input.knownSkillIds) {
    const known = new Set(input.knownSkillIds);
    for (const sid of shelf.ui.pinned_skill_ids) {
      if (!known.has(sid) && !sid.startsWith('org:')) {
        warnings.push(`핀 스킬 없음: ${sid}`);
      }
    }
  }
  if (
    shelf.ui.default_skill_mode
    && input.knownSkillModes
    && !input.knownSkillModes.includes(shelf.ui.default_skill_mode)
  ) {
    warnings.push(`기본 스킬 모드 없음: ${shelf.ui.default_skill_mode}`);
  }

  const profileKey = `${group}/${id}`;
  const applied: AgentProfileAppliedState = {
    profile_id: profileKey,
    group,
    kit_id: id,
    origin,
    ui: shelf.ui,
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
  const restoredEntries = Array.isArray(snapshot.applied_entries)
    ? snapshot.applied_entries
    : snapshot.applied
      ? [snapshot.applied]
      : [];
  if (restoredEntries.length > 0) {
    writeAppliedDocument(cqrRoot, restoredEntries);
  } else if (existsSync(appliedFile)) {
    assertWritablePath(appliedFile, cqrRoot);
    rmSync(appliedFile);
  }
  return { ok: true, profile_id: snapshot.applied?.profile_id ?? '', toggled, warnings };
}
