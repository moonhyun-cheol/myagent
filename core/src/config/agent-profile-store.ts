/**
 * Work profiles (작업 프로필): data/profile/{id}.json — local presets that
 * bundle skill pins (UI) + agent plugin enable states. Survives delta updates
 * (data/ preserved). Local preset layer — NOT the signed organization module.
 *
 * Layer: config-store + route + UI. Never enters agent run-loop / tool-pack
 * harness; tools.preferred_plugin_ids is display metadata only.
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
  listAgentPlugins,
  setAgentPluginEnabled,
} from '../agent/agent-plugin-store.js';

export interface AgentProfileUi {
  /** Default skill/mode chip for new chats (informational — no session mutation). */
  default_skill_mode?: string;
  /** Skill ids pinned to the top of the skills page after apply. */
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
  ui: AgentProfileUi;
  applied_at: string;
}

interface ProfileLastState {
  saved_at: string;
  /** Full plugin enabled map at snapshot time. */
  plugins: Record<string, boolean>;
  /** Applied-profile state before this apply (null = none). */
  applied: AgentProfileAppliedState | null;
}

export interface ProfileApplyResult {
  ok: boolean;
  profile_id: string;
  toggled: Array<{ id: string; enabled: boolean }>;
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

export function getAppliedProfileState(cqrRoot: string): AgentProfileAppliedState | null {
  return readJson<AgentProfileAppliedState>(
    path.join(profilesRoot(cqrRoot), APPLIED_FILE),
  );
}

export function hasProfileLastState(cqrRoot: string): boolean {
  return existsSync(path.join(profilesRoot(cqrRoot), LAST_STATE_FILE));
}

/**
 * Apply a profile: snapshot current state to .last-state.json, then toggle
 * only the plugin ids listed in profile.plugins.enable. Missing ids become
 * warnings (never silent). Consent stays with the existing HITL flow — the
 * route requires confirm=true from an explicit user click.
 */
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
  const records = listAgentPlugins(cqrRoot, { useCache: false });
  const currentEnabled: Record<string, boolean> = {};
  for (const rec of records) currentEnabled[rec.id] = rec.enabled;

  // Snapshot BEFORE mutating (되돌리기 지원).
  ensureDir(cqrRoot);
  const snapshot: ProfileLastState = {
    saved_at: new Date().toISOString(),
    plugins: { ...currentEnabled },
    applied: getAppliedProfileState(cqrRoot),
  };
  writeJson(cqrRoot, path.join(profilesRoot(cqrRoot), LAST_STATE_FILE), snapshot);

  const warnings: string[] = [];
  const toggled: Array<{ id: string; enabled: boolean }> = [];
  for (const [pid, want] of Object.entries(normalized.plugins.enable)) {
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
    ui: normalized.ui,
    applied_at: new Date().toISOString(),
  };
  writeJson(cqrRoot, path.join(profilesRoot(cqrRoot), APPLIED_FILE), applied);

  return { ok: true, profile_id: id, toggled, warnings };
}

/** Restore plugin enabled map + applied marker from the last apply snapshot. */
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
  if (snapshot.applied) writeJson(cqrRoot, appliedFile, snapshot.applied);
  else if (existsSync(appliedFile)) {
    assertWritablePath(appliedFile, cqrRoot);
    rmSync(appliedFile);
  }
  return { ok: true, profile_id: snapshot.applied?.profile_id ?? '', toggled, warnings };
}
