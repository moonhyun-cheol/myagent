import { readFileSync, statSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { OrganizationModuleError } from './organization-module-crypto.js';

const MAX_ARCHIVE_BYTES = 80 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 200 * 1024 * 1024;
const MAX_ENTRIES = 4096;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export interface ZipEntry {
  path: string;
  content: Buffer;
}

export function readZipEntries(zipPath: string): ZipEntry[] {
  let size = 0;
  try {
    size = statSync(zipPath).size;
  } catch {
    throw new OrganizationModuleError('MODULE_ZIP_NOT_FOUND', `ZIP 파일을 찾을 수 없습니다: ${zipPath}`);
  }
  if (size <= 0 || size > MAX_ARCHIVE_BYTES) {
    throw new OrganizationModuleError(
      'MODULE_ZIP_TOO_LARGE',
      `모듈 ZIP은 ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB 이하여야 합니다.`,
    );
  }
  return extractEntries(readFileSync(zipPath));
}

function extractEntries(zip: Buffer): ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(zip);
  const entryCount = zip.readUInt16LE(eocdOffset + 10);
  const centralOffset = zip.readUInt32LE(eocdOffset + 16);
  if (entryCount < 1 || entryCount > MAX_ENTRIES) {
    throw new OrganizationModuleError('MODULE_ZIP_ENTRY_LIMIT', `ZIP 항목은 1-${MAX_ENTRIES}개여야 합니다.`);
  }

  const files: ZipEntry[] = [];
  const seenPaths = new Set<string>();
  let cursor = centralOffset;
  let expandedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > zip.length || zip.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new OrganizationModuleError('MODULE_ZIP_INVALID', 'ZIP 중앙 디렉터리가 손상되었습니다.');
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
    if (nameEnd > zip.length) throw new OrganizationModuleError('MODULE_ZIP_INVALID', 'ZIP 파일명이 손상되었습니다.');
    const rawName = zip.subarray(nameStart, nameEnd).toString('utf8');
    cursor = nameEnd + extraLength + commentLength;

    const safePath = normalizeArchivePath(rawName);
    if (!safePath || rawName.endsWith('/') || rawName.endsWith('\\')) continue;
    const pathKey = safePath.toLowerCase();
    if (seenPaths.has(pathKey)) {
      throw new OrganizationModuleError('MODULE_ZIP_DUPLICATE', `ZIP에 중복된 경로가 있습니다: ${safePath}`);
    }
    seenPaths.add(pathKey);
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0xf000) === 0xa000) {
      throw new OrganizationModuleError('MODULE_ZIP_SYMLINK', `심볼릭 링크는 허용되지 않습니다: ${safePath}`);
    }
    if ((flags & 0x1) !== 0) {
      throw new OrganizationModuleError('MODULE_ZIP_ENCRYPTED', '암호화된 ZIP은 설치할 수 없습니다.');
    }
    if (method !== 0 && method !== 8) {
      throw new OrganizationModuleError('MODULE_ZIP_METHOD', `지원하지 않는 ZIP 압축 방식입니다: ${method}`);
    }
    expandedBytes += uncompressedSize;
    if (expandedBytes > MAX_EXPANDED_BYTES) {
      throw new OrganizationModuleError(
        'MODULE_ZIP_EXPANDED_LIMIT',
        `압축 해제 크기는 ${MAX_EXPANDED_BYTES / 1024 / 1024}MB 이하여야 합니다.`,
      );
    }
    if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new OrganizationModuleError('MODULE_ZIP_INVALID', `ZIP 항목이 손상되었습니다: ${safePath}`);
    }
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > zip.length) {
      throw new OrganizationModuleError('MODULE_ZIP_INVALID', `ZIP 데이터가 손상되었습니다: ${safePath}`);
    }
    const compressed = zip.subarray(dataStart, dataEnd);
    const remainingBytes = Math.max(1, MAX_EXPANDED_BYTES - (expandedBytes - uncompressedSize));
    const content = method === 0
      ? Buffer.from(compressed)
      : inflateRawSync(compressed, { maxOutputLength: remainingBytes });
    if (content.length !== uncompressedSize) {
      throw new OrganizationModuleError('MODULE_ZIP_INVALID', `압축 해제 크기가 일치하지 않습니다: ${safePath}`);
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
  throw new OrganizationModuleError('MODULE_ZIP_INVALID', '유효한 ZIP 파일이 아닙니다.');
}

function normalizeArchivePath(raw: string): string {
  if (raw.includes('\0')) {
    throw new OrganizationModuleError('MODULE_ZIP_PATH', 'ZIP 파일명에 NUL 문자를 사용할 수 없습니다.');
  }
  const normalized = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || /^[a-z]:\//i.test(normalized)) {
    throw new OrganizationModuleError('MODULE_ZIP_PATH', `절대 경로는 허용되지 않습니다: ${raw}`);
  }
  const parts = normalized.split('/').filter((part) => part && part !== '.');
  if (parts.some((part) => part === '..')) {
    throw new OrganizationModuleError('MODULE_ZIP_PATH', `상위 경로 이동은 허용되지 않습니다: ${raw}`);
  }
  return parts.join('/');
}
