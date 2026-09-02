import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 50 * 1024 * 1024;
const MAX_ENTRIES = 512;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export interface SkillPackageArchive {
  id: string;
  label: string;
  description: string;
  files: Array<{ path: string; content: Buffer }>;
}

export class SkillPackageError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SkillPackageError';
  }
}

export function readSkillPackageArchive(zipPath: string): SkillPackageArchive {
  const resolved = path.resolve(zipPath.trim());
  if (!resolved.toLowerCase().endsWith('.zip')) {
    throw new SkillPackageError('SKILL_ZIP_REQUIRED', 'ZIP 파일 경로를 입력하세요.');
  }
  let size = 0;
  try {
    size = statSync(resolved).size;
  } catch {
    throw new SkillPackageError('SKILL_ZIP_NOT_FOUND', `ZIP 파일을 찾을 수 없습니다: ${resolved}`);
  }
  if (size <= 0 || size > MAX_ARCHIVE_BYTES) {
    throw new SkillPackageError('SKILL_ZIP_TOO_LARGE', `ZIP 파일은 ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB 이하여야 합니다.`);
  }

  const zip = readFileSync(resolved);
  const entries = extractEntries(zip);
  const normalized = stripSingleWrapperDirectory(entries);
  const skillMd = normalized.find((entry) => entry.path.toLowerCase() === 'skill.md');
  if (!skillMd) {
    throw new SkillPackageError('SKILL_MD_REQUIRED', 'ZIP 루트에는 SKILL.md가 있어야 합니다.');
  }

  const frontmatter = parseSkillFrontmatter(skillMd.content.toString('utf8'));
  const id = /^[a-z0-9-]{1,63}$/.test(frontmatter.name) ? frontmatter.name : null;
  if (!id) {
    throw new SkillPackageError('INVALID_ID', 'SKILL.md name은 소문자 영문, 숫자, 하이픈만 사용할 수 있습니다.');
  }
  const agentMetadata = normalized.find((entry) => entry.path.toLowerCase() === 'agents/openai.yaml');
  const displayName = agentMetadata
    ? readYamlScalar(agentMetadata.content.toString('utf8'), 'display_name')
    : null;

  return {
    id,
    label: (displayName || id).slice(0, 64),
    description: frontmatter.description.slice(0, 500),
    files: normalized,
  };
}

export function readInstalledSkillPackageMeta(packageDir: string): {
  id: string;
  label: string;
  description: string;
  file_count: number;
} | null {
  const skillMdPath = path.join(packageDir, 'SKILL.md');
  if (!existsSync(skillMdPath)) return null;
  try {
    const frontmatter = parseSkillFrontmatter(readFileSync(skillMdPath, 'utf8'));
    const id = /^[a-z0-9-]{1,63}$/.test(frontmatter.name) ? frontmatter.name : null;
    if (!id) return null;
    const yamlPath = path.join(packageDir, 'agents', 'openai.yaml');
    const displayName = existsSync(yamlPath)
      ? readYamlScalar(readFileSync(yamlPath, 'utf8'), 'display_name')
      : null;
    const files = readdirSync(packageDir, { recursive: true, withFileTypes: true });
    const fileCount = files.filter((entry) => entry.isFile()).length;
    return {
      id,
      label: (displayName || id).slice(0, 64),
      description: frontmatter.description.slice(0, 500),
      file_count: fileCount,
    };
  } catch {
    return null;
  }
}

function extractEntries(zip: Buffer): Array<{ path: string; content: Buffer }> {
  const eocdOffset = findEndOfCentralDirectory(zip);
  const entryCount = zip.readUInt16LE(eocdOffset + 10);
  const centralOffset = zip.readUInt32LE(eocdOffset + 16);
  if (entryCount < 1 || entryCount > MAX_ENTRIES) {
    throw new SkillPackageError('SKILL_ZIP_ENTRY_LIMIT', `ZIP 항목은 1-${MAX_ENTRIES}개여야 합니다.`);
  }

  const files: Array<{ path: string; content: Buffer }> = [];
  const seenPaths = new Set<string>();
  let cursor = centralOffset;
  let expandedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > zip.length || zip.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new SkillPackageError('SKILL_ZIP_INVALID', 'ZIP 중앙 디렉터리가 손상되었습니다.');
    }
    const flags = zip.readUInt16LE(cursor + 8);
    const method = zip.readUInt16LE(cursor + 10);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const uncompressedSize = zip.readUInt32LE(cursor + 24);
    const fileNameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const externalAttributes = zip.readUInt32LE(cursor + 38);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + fileNameLength;
    if (nameEnd > zip.length) throw new SkillPackageError('SKILL_ZIP_INVALID', 'ZIP 파일명이 손상되었습니다.');
    const rawName = zip.subarray(nameStart, nameEnd).toString((flags & 0x800) !== 0 ? 'utf8' : 'utf8');
    cursor = nameEnd + extraLength + commentLength;

    const safePath = normalizeArchivePath(rawName);
    if (!safePath || rawName.endsWith('/') || rawName.endsWith('\\')) continue;
    const pathKey = safePath.toLowerCase();
    if (seenPaths.has(pathKey)) {
      throw new SkillPackageError('SKILL_ZIP_DUPLICATE_PATH', `ZIP에 중복된 파일 경로가 있습니다: ${safePath}`);
    }
    seenPaths.add(pathKey);
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0xf000) === 0xa000) {
      throw new SkillPackageError('SKILL_ZIP_SYMLINK', `심볼릭 링크는 허용되지 않습니다: ${safePath}`);
    }
    if ((flags & 0x1) !== 0) {
      throw new SkillPackageError('SKILL_ZIP_ENCRYPTED', '암호화된 ZIP은 설치할 수 없습니다.');
    }
    if (method !== 0 && method !== 8) {
      throw new SkillPackageError('SKILL_ZIP_METHOD', `지원하지 않는 ZIP 압축 방식입니다: ${method}`);
    }
    expandedBytes += uncompressedSize;
    if (expandedBytes > MAX_EXPANDED_BYTES) {
      throw new SkillPackageError('SKILL_ZIP_EXPANDED_LIMIT', `압축 해제 크기는 ${MAX_EXPANDED_BYTES / 1024 / 1024}MB 이하여야 합니다.`);
    }
    if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new SkillPackageError('SKILL_ZIP_INVALID', `ZIP 항목이 손상되었습니다: ${safePath}`);
    }
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > zip.length) throw new SkillPackageError('SKILL_ZIP_INVALID', `ZIP 데이터가 손상되었습니다: ${safePath}`);
    const compressed = zip.subarray(dataStart, dataEnd);
    const remainingBytes = Math.max(1, MAX_EXPANDED_BYTES - (expandedBytes - uncompressedSize));
    const content = method === 0
      ? Buffer.from(compressed)
      : inflateRawSync(compressed, { maxOutputLength: remainingBytes });
    if (content.length !== uncompressedSize) {
      throw new SkillPackageError('SKILL_ZIP_INVALID', `압축 해제 크기가 일치하지 않습니다: ${safePath}`);
    }
    files.push({ path: safePath, content });
  }
  return files;
}

function findEndOfCentralDirectory(zip: Buffer): number {
  const lowerBound = Math.max(0, zip.length - 65_557);
  for (let offset = zip.length - 22; offset >= lowerBound; offset -= 1) {
    if (zip.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new SkillPackageError('SKILL_ZIP_INVALID', '유효한 ZIP 파일이 아닙니다.');
}

function normalizeArchivePath(raw: string): string {
  if (raw.includes('\0')) throw new SkillPackageError('SKILL_ZIP_PATH', 'ZIP 파일명에 NUL 문자를 사용할 수 없습니다.');
  const normalized = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || /^[a-z]:\//i.test(normalized)) {
    throw new SkillPackageError('SKILL_ZIP_PATH', `절대 경로는 허용되지 않습니다: ${raw}`);
  }
  const parts = normalized.split('/').filter((part) => part && part !== '.');
  if (parts.some((part) => part === '..')) {
    throw new SkillPackageError('SKILL_ZIP_PATH', `상위 경로 이동은 허용되지 않습니다: ${raw}`);
  }
  return parts.join('/');
}

function stripSingleWrapperDirectory(
  entries: Array<{ path: string; content: Buffer }>,
): Array<{ path: string; content: Buffer }> {
  if (entries.some((entry) => entry.path.toLowerCase() === 'skill.md')) return entries;
  const roots = new Set(entries.map((entry) => entry.path.split('/')[0]).filter(Boolean));
  if (roots.size !== 1) return entries;
  const root = [...roots][0];
  return entries.map((entry) => ({ ...entry, path: entry.path.slice(root.length + 1) }));
}

function parseSkillFrontmatter(text: string): { name: string; description: string } {
  const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/);
  if (!match) throw new SkillPackageError('SKILL_FRONTMATTER_REQUIRED', 'SKILL.md에 YAML frontmatter가 필요합니다.');
  const name = readYamlScalar(match[1], 'name');
  const description = readYamlScalar(match[1], 'description');
  if (!name || !description) {
    throw new SkillPackageError('SKILL_METADATA_REQUIRED', 'SKILL.md frontmatter에 name과 description이 필요합니다.');
  }
  return { name, description };
}

function readYamlScalar(text: string, key: string): string | null {
  const match = text.match(new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, 'm'));
  if (!match) return null;
  const value = match[1].trim();
  if (value === '|' || value === '>') return null;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).trim();
  }
  return value;
}
