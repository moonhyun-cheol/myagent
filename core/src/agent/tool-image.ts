import { openSync, closeSync, fstatSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { resolveDevWorkspaceReadPath } from '../security/dev-workspace-guard.js';

export const TOOL_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const TOOL_IMAGE_MAX_COUNT = 4;
const MAX_PIXELS = 25_000_000;

/** Header validation only; never execute SVG or trust a file extension/MCP MIME. */
export function toolImageDataUrl(bytes: Buffer, declaredMime?: string): string {
  if (!bytes.length || bytes.length > TOOL_IMAGE_MAX_BYTES) throw new Error('IMAGE_SIZE_LIMIT: 이미지는 8MB 이하여야 합니다.');
  let mime = '';
  let width = 0;
  let height = 0;
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    && bytes.toString('ascii', 12, 16) === 'IHDR') {
    mime = 'image/png'; width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (bytes.length >= 13 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) {
    mime = 'image/gif'; width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8);
  } else if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    mime = 'image/webp';
    const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8X') { width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3); }
    else if (kind === 'VP8L' && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21); width = 1 + (bits & 0x3fff); height = 1 + ((bits >>> 14) & 0x3fff);
    } else if (kind === 'VP8 ' && bytes.subarray(23, 26).equals(Buffer.from([0x9d, 1, 0x2a]))) {
      width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff;
    }
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    mime = 'image/jpeg';
    for (let i = 2; i + 3 < bytes.length;) {
      if (bytes[i++] !== 0xff) break;
      while (bytes[i] === 0xff) i++;
      const marker = bytes[i++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (i + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(i);
      if (length < 2 || i + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
        height = bytes.readUInt16BE(i + 3); width = bytes.readUInt16BE(i + 5); break;
      }
      i += length;
    }
  }
  if (!mime || !width || !height) throw new Error('IMAGE_FORMAT_REJECTED: 유효한 PNG/JPEG/GIF/WebP 이미지 헤더가 필요합니다. SVG는 지원하지 않습니다.');
  if (width * height > MAX_PIXELS || width > 16_384 || height > 16_384) throw new Error('IMAGE_DIMENSION_LIMIT: 이미지를 축소한 뒤 다시 조회하세요.');
  if (declaredMime && declaredMime.toLowerCase() !== mime) throw new Error('IMAGE_MIME_MISMATCH');
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

export function toolImageFromBase64(data: string, mime?: string): string {
  if (data.length > Math.ceil(TOOL_IMAGE_MAX_BYTES / 3) * 4 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new Error('IMAGE_BASE64_REJECTED');
  }
  return toolImageDataUrl(Buffer.from(data, 'base64'), mime);
}

function within(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

/** Same explicit absolute/UNC read policy as read_file, with product session-data isolation. */
export function readToolImage(workspaceRoot: string, input: string, context?: { cqrRoot?: string; sessionId?: string }): string {
  if (!input.trim() || /^[a-z]+:\/\//i.test(input) || input.startsWith('data:')) throw new Error('IMAGE_LOCAL_PATH_REQUIRED');
  const absolute = resolveDevWorkspaceReadPath(workspaceRoot, input);
  const resolved = realpathSync(absolute);
  if (context?.cqrRoot) {
    const root = realpathSync(context.cqrRoot);
    const dataRoot = path.join(root, 'data');
    // Check both lexical and resolved paths, including symlink targets.
    if (within(dataRoot, absolute) || within(dataRoot, resolved)) {
      const raw = context.sessionId?.trim() || '';
      const browserSid = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      const webSid = raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
      const allowed = raw && [['browser', browserSid], ['web', webSid]].some(([kind, sid]) => {
        const dir = path.join(dataRoot, 'outputs', kind, sid);
        return within(dir, absolute) && within(dir, resolved) && realpathSync(dir) === dir;
      });
      if (!allowed) throw new Error('IMAGE_SESSION_SCOPE_REJECTED: 다른 대화 또는 내부 데이터는 조회할 수 없습니다.');
    }
  }
  const fd = openSync(resolved, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > TOOL_IMAGE_MAX_BYTES) throw new Error('IMAGE_SIZE_LIMIT');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!read) throw new Error('IMAGE_READ_INCOMPLETE');
      offset += read;
    }
    return toolImageDataUrl(bytes);
  } finally { closeSync(fd); }
}
