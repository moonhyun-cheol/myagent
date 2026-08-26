import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertPathUnder, assertWritablePath } from '../security/path-guard.js';
import { readSkillPackageArchive, SkillPackageError } from './skill-package-zip.js';

export const MAX_USER_SKILL_PROMPT_CHARS = 120_000;
const ID_RE = /^[a-z0-9_-]{1,48}$/;

export interface UserSkillRecord {
  id: string;
  label: string;
  anchors_ko?: string[];
  anchors_en?: string[];
  install_kind?: 'prompt' | 'package';
  description?: string;
  file_count?: number;
  created_at: string;
  updated_at: string;
}

interface UserSkillIndex {
  version: number;
  skills: UserSkillRecord[];
}

export class UserSkillStore {
  private readonly skillsDir: string;
  private readonly indexPath: string;

  constructor(skillsDir: string, private readonly cqrRoot: string) {
    this.skillsDir = skillsDir;
    this.indexPath = path.join(skillsDir, 'index.json');
  }

  list(): UserSkillRecord[] {
    return this.loadIndex().skills.sort((a, b) => a.label.localeCompare(b.label));
  }

  get(id: string): (UserSkillRecord & { prompt: string }) | null {
    const safe = sanitizeSkillId(id);
    if (!safe) return null;
    const rec = this.loadIndex().skills.find((s) => s.id === safe);
    if (!rec) return null;
    const prompt = this.readPrompt(safe);
    if (prompt === null) return null;
    return { ...rec, prompt };
  }

  create(input: {
    id: string;
    label: string;
    prompt: string;
    anchors_ko?: string[];
    anchors_en?: string[];
  }): UserSkillRecord {
    const id = sanitizeSkillId(input.id);
    if (!id) throw new UserSkillError('INVALID_ID', 'Skill id must be 1-48 chars: a-z, 0-9, _, -');
    const label = (input.label?.trim() || id).slice(0, 64);
    const prompt = validatePrompt(input.prompt);
    const index = this.loadIndex();
    if (index.skills.some((s) => s.id === id)) {
      throw new UserSkillError('DUPLICATE_ID', `Skill already exists: ${id}`);
    }
    const now = new Date().toISOString();
    const rec: UserSkillRecord = {
      id,
      label,
      anchors_ko: normalizeAnchors(input.anchors_ko),
      anchors_en: normalizeAnchors(input.anchors_en),
      install_kind: 'prompt',
      created_at: now,
      updated_at: now,
    };
    this.writePrompt(id, prompt);
    index.skills.push(rec);
    this.saveIndex(index);
    return rec;
  }

  installPackage(zipPath: string, isReservedId?: (id: string) => boolean): UserSkillRecord {
    let archive;
    let indexSaved = false;
    try {
      archive = readSkillPackageArchive(zipPath);
    } catch (error) {
      if (error instanceof SkillPackageError) throw new UserSkillError(error.code, error.message);
      throw error;
    }
    if (isReservedId?.(archive.id)) {
      throw new UserSkillError('BUNDLED_SKILL_ID', `기본 제공 스킬 ID는 덮어쓸 수 없습니다: ${archive.id}`);
    }
    const index = this.loadIndex();
    if (index.skills.some((skill) => skill.id === archive.id)) {
      throw new UserSkillError('DUPLICATE_ID', `이미 설치된 스킬입니다: ${archive.id}`);
    }

    const packagesDir = path.join(this.skillsDir, 'packages');
    const targetDir = path.join(packagesDir, archive.id);
    const stagingDir = path.join(packagesDir, `.install-${archive.id}-${randomUUID()}`);
    assertWritablePath(targetDir, this.cqrRoot);
    assertWritablePath(stagingDir, this.cqrRoot);
    if (existsSync(targetDir)) {
      throw new UserSkillError('DUPLICATE_ID', `스킬 폴더가 이미 존재합니다: ${archive.id}`);
    }

    try {
      mkdirSync(stagingDir, { recursive: true });
      for (const file of archive.files) {
        const destination = path.join(stagingDir, ...file.path.split('/'));
        assertPathUnder(stagingDir, destination);
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, file.content);
      }
      renameSync(stagingDir, targetDir);
      const now = new Date().toISOString();
      const rec: UserSkillRecord = {
        id: archive.id,
        label: archive.label,
        description: archive.description,
        install_kind: 'package',
        file_count: archive.files.length,
        created_at: now,
        updated_at: now,
      };
      index.skills.push(rec);
      this.saveIndex(index);
      indexSaved = true;
      return rec;
    } catch (error) {
      if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });
      if (!indexSaved && existsSync(targetDir)) {
        rmSync(targetDir, { recursive: true, force: true });
      }
      throw error;
    }
  }

  update(
    id: string,
    input: { label?: string; prompt?: string; anchors_ko?: string[]; anchors_en?: string[] },
  ): UserSkillRecord {
    const safe = sanitizeSkillId(id);
    if (!safe) throw new UserSkillError('INVALID_ID', 'Invalid skill id');
    const index = this.loadIndex();
    const idx = index.skills.findIndex((s) => s.id === safe);
    if (idx < 0) throw new UserSkillError('NOT_FOUND', `Skill not found: ${safe}`);
    const rec = index.skills[idx];
    if (rec.install_kind === 'package') {
      throw new UserSkillError('PACKAGE_READONLY', 'ZIP으로 설치한 스킬은 수정할 수 없습니다. 삭제 후 다시 설치하세요.');
    }
    if (input.label !== undefined) rec.label = (input.label.trim() || rec.id).slice(0, 64);
    if (input.anchors_ko !== undefined) rec.anchors_ko = normalizeAnchors(input.anchors_ko);
    if (input.anchors_en !== undefined) rec.anchors_en = normalizeAnchors(input.anchors_en);
    if (input.prompt !== undefined) this.writePrompt(safe, validatePrompt(input.prompt));
    rec.updated_at = new Date().toISOString();
    index.skills[idx] = rec;
    this.saveIndex(index);
    return rec;
  }

  delete(id: string): boolean {
    const safe = sanitizeSkillId(id);
    if (!safe) return false;
    const index = this.loadIndex();
    const rec = index.skills.find((skill) => skill.id === safe);
    const next = index.skills.filter((s) => s.id !== safe);
    if (next.length === index.skills.length) return false;
    index.skills = next;
    this.saveIndex(index);
    const promptPath = this.promptPath(safe);
    if (existsSync(promptPath)) {
      assertWritablePath(promptPath, this.cqrRoot);
      unlinkSync(promptPath);
    }
    if (rec?.install_kind === 'package') {
      const packagePath = this.packagePath(safe);
      assertWritablePath(packagePath, this.cqrRoot);
      assertPathUnder(path.join(this.skillsDir, 'packages'), packagePath);
      if (existsSync(packagePath)) rmSync(packagePath, { recursive: true, force: true });
    }
    return true;
  }

  readPrompt(id: string): string | null {
    const safe = sanitizeSkillId(id);
    if (!safe) return null;
    const rec = this.loadIndex().skills.find((skill) => skill.id === safe);
    const promptPath = rec?.install_kind === 'package'
      ? path.join(this.packagePath(safe), 'SKILL.md')
      : this.promptPath(safe);
    if (!existsSync(promptPath)) return null;
    try {
      return readFileSync(promptPath, 'utf8').trim();
    } catch {
      return null;
    }
  }

  private promptPath(id: string): string {
    return path.join(this.skillsDir, `${id}.md`);
  }

  private packagePath(id: string): string {
    return path.join(this.skillsDir, 'packages', id);
  }

  private writePrompt(id: string, prompt: string): void {
    const promptPath = this.promptPath(id);
    assertWritablePath(promptPath, this.cqrRoot);
    writeFileSync(promptPath, prompt.trim() + '\n', 'utf8');
  }

  private loadIndex(): UserSkillIndex {
    if (!existsSync(this.indexPath)) {
      return { version: 1, skills: [] };
    }
    try {
      const doc = JSON.parse(readFileSync(this.indexPath, 'utf8')) as UserSkillIndex;
      return { version: 1, skills: Array.isArray(doc.skills) ? doc.skills : [] };
    } catch {
      return { version: 1, skills: [] };
    }
  }

  private saveIndex(index: UserSkillIndex): void {
    assertWritablePath(this.indexPath, this.cqrRoot);
    writeFileSync(this.indexPath, JSON.stringify(index, null, 2) + '\n', 'utf8');
  }
}

export class UserSkillError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'UserSkillError';
  }
}

export function sanitizeSkillId(id: string): string | null {
  const safe = id.trim().toLowerCase();
  if (!ID_RE.test(safe)) return null;
  return safe;
}

export function userSkillMode(id: string): string {
  return `user:${id}`;
}

export function parseUserSkillId(mode: string): string | null {
  if (!mode.startsWith('user:')) return null;
  const id = mode.slice(5);
  return sanitizeSkillId(id);
}

export function isUserSkillMode(mode: string): boolean {
  return parseUserSkillId(mode) !== null;
}

function validatePrompt(prompt: string): string {
  const text = (prompt ?? '').trim();
  if (!text) throw new UserSkillError('PROMPT_EMPTY', 'Prompt cannot be empty');
  if (text.length > MAX_USER_SKILL_PROMPT_CHARS) {
    throw new UserSkillError('PROMPT_TOO_LARGE', `Prompt exceeds ${MAX_USER_SKILL_PROMPT_CHARS} chars`);
  }
  return text;
}

function normalizeAnchors(values?: string[]): string[] | undefined {
  if (!values?.length) return undefined;
  const out = values.map((v) => v.trim()).filter(Boolean).slice(0, 20);
  return out.length ? out : undefined;
}
