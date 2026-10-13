/**
 * Shared persistence for generated media (image + video).
 *
 * - Format is decided by file signature, never by provider Content-Type or extension.
 * - Size is capped per kind; videos are streamed to disk instead of buffered.
 * - Files are written to a temp name and renamed so a partial download never
 *   becomes a visible output.
 * - Path guard (`assertWritablePath`) applies to both temp and final paths.
 *
 * See docs/media-output-persistence-plan.md (P0-2).
 */
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertWritablePath } from '../security/path-guard.js';

export type MediaKind = 'image' | 'video';

/** Persisted on assistant messages (`SessionMessage.media`). */
export interface MediaRecord {
  kind: MediaKind;
  /** Local `/outputs/images|videos/<session>/<file>` URL. */
  url: string;
  mime: string;
  bytes: number;
  sha256: string;
}

export const MEDIA_MAX_BYTES: Record<MediaKind, number> = {
  image: 25 * 1024 * 1024,
  video: 500 * 1024 * 1024,
};

export type MediaValidationCode =
  | 'MEDIA_EMPTY'
  | 'MEDIA_TOO_LARGE'
  | 'MEDIA_UNSUPPORTED_FORMAT'
  | 'MEDIA_KIND_MISMATCH'
  | 'MEDIA_NO_BODY';

export class MediaValidationError extends Error {
  constructor(readonly code: MediaValidationCode, message: string) {
    super(`${code} ${message}`);
    this.name = 'MediaValidationError';
  }
}

export interface SniffedMedia {
  kind: MediaKind;
  mime: string;
  ext: string;
}

const SNIFF_BYTES = 64;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Identify supported media from its first bytes. Returns null for anything else (HTML, JSON, MOV, …). */
export function sniffMedia(head: Buffer): SniffedMedia | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(PNG_SIG)) {
    return { kind: 'image', mime: 'image/png', ext: '.png' };
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { kind: 'image', mime: 'image/jpeg', ext: '.jpg' };
  }
  if (head.length >= 6) {
    const sig = head.subarray(0, 6).toString('latin1');
    if (sig === 'GIF87a' || sig === 'GIF89a') return { kind: 'image', mime: 'image/gif', ext: '.gif' };
  }
  if (
    head.length >= 12
    && head.subarray(0, 4).toString('latin1') === 'RIFF'
    && head.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return { kind: 'image', mime: 'image/webp', ext: '.webp' };
  }
  if (head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = head.subarray(8, 12).toString('latin1');
    // QuickTime (.mov) is outside the supported set.
    if (brand === 'qt  ') return null;
    return { kind: 'video', mime: 'video/mp4', ext: '.mp4' };
  }
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    // EBML container: accept only the WebM doctype, not generic Matroska.
    if (head.subarray(0, SNIFF_BYTES).includes(Buffer.from('webm', 'latin1'))) {
      return { kind: 'video', mime: 'video/webm', ext: '.webm' };
    }
    return null;
  }
  return null;
}

function validateSniff(head: Buffer, expectKind: MediaKind): SniffedMedia {
  const sniffed = sniffMedia(head);
  if (!sniffed) {
    const looksText = /^\s*[<{[]/.test(head.subarray(0, 16).toString('latin1'));
    throw new MediaValidationError(
      'MEDIA_UNSUPPORTED_FORMAT',
      looksText ? '받은 내용이 미디어 파일이 아니라 텍스트(HTML/JSON)입니다.' : '지원하지 않는 파일 형식입니다.',
    );
  }
  if (sniffed.kind !== expectKind) {
    throw new MediaValidationError('MEDIA_KIND_MISMATCH', `${expectKind}를 기대했지만 ${sniffed.mime} 파일입니다.`);
  }
  return sniffed;
}

function safeBaseName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || randomUUID();
}

export interface SaveMediaTarget {
  expectKind: MediaKind;
  /** Absolute directory, e.g. `<imageOut>/<sessionId>`. */
  dir: string;
  /** URL prefix for that directory, e.g. `/outputs/images/<sessionId>`. */
  urlPrefix: string;
  /** File name without extension (the extension comes from the signature). Default: sha256 prefix. */
  baseName?: string;
  cqrRoot: string;
  maxBytes?: number;
}

function finalPaths(target: SaveMediaTarget, ext: string, sha256: string) {
  const base = target.baseName ? safeBaseName(target.baseName) : sha256.slice(0, 32);
  const file = `${base}${ext}`;
  const full = path.join(target.dir, file);
  assertWritablePath(full, target.cqrRoot);
  return { full, url: `${target.urlPrefix.replace(/\/$/, '')}/${file}` };
}

function tempPath(target: SaveMediaTarget): string {
  const tmp = path.join(target.dir, `.partial-${randomUUID()}.tmp`);
  assertWritablePath(tmp, target.cqrRoot);
  return tmp;
}

/** Validate and atomically persist an in-memory media buffer (images, small payloads). */
export function saveMediaBuffer(buffer: Buffer, target: SaveMediaTarget): MediaRecord {
  const max = target.maxBytes ?? MEDIA_MAX_BYTES[target.expectKind];
  if (buffer.length === 0) throw new MediaValidationError('MEDIA_EMPTY', '빈 파일입니다.');
  if (buffer.length > max) {
    throw new MediaValidationError('MEDIA_TOO_LARGE', `${buffer.length}바이트로 상한 ${max}바이트를 넘습니다.`);
  }
  const sniffed = validateSniff(buffer.subarray(0, SNIFF_BYTES), target.expectKind);
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const dest = finalPaths(target, sniffed.ext, sha256);
  const tmp = tempPath(target);
  mkdirSync(target.dir, { recursive: true });
  try {
    writeFileSync(tmp, buffer);
    renameSync(tmp, dest.full);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return { kind: sniffed.kind, url: dest.url, mime: sniffed.mime, bytes: buffer.length, sha256 };
}

/**
 * Stream a download body to disk with a running size cap and hash, then validate
 * the signature and rename into place. The body is never fully buffered.
 */
export async function saveMediaStream(
  body: ReadableStream<Uint8Array> | null | undefined,
  target: SaveMediaTarget & { contentLength?: number | null; signal?: AbortSignal },
): Promise<MediaRecord> {
  if (!body) throw new MediaValidationError('MEDIA_NO_BODY', '응답 본문이 없습니다.');
  const max = target.maxBytes ?? MEDIA_MAX_BYTES[target.expectKind];
  if (target.contentLength != null && Number.isFinite(target.contentLength) && target.contentLength > max) {
    await body.cancel().catch(() => undefined);
    throw new MediaValidationError(
      'MEDIA_TOO_LARGE',
      `Content-Length ${target.contentLength}바이트가 상한 ${max}바이트를 넘습니다.`,
    );
  }
  const tmp = tempPath(target);
  mkdirSync(target.dir, { recursive: true });
  const hash = createHash('sha256');
  const headChunks: Buffer[] = [];
  let headLen = 0;
  let bytes = 0;
  const out = createWriteStream(tmp);
  const writeChunk = (chunk: Buffer) =>
    new Promise<void>((resolve, reject) => {
      out.write(chunk, (err) => (err ? reject(err) : resolve()));
    });
  const reader = body.getReader();
  try {
    while (true) {
      if (target.signal?.aborted) throw new Error('MEDIA_ABORTED');
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      bytes += chunk.length;
      if (bytes > max) throw new MediaValidationError('MEDIA_TOO_LARGE', `상한 ${max}바이트를 넘었습니다.`);
      if (headLen < SNIFF_BYTES) {
        const take = Math.min(chunk.length, SNIFF_BYTES - headLen);
        headChunks.push(Buffer.from(chunk.subarray(0, take)));
        headLen += take;
      }
      hash.update(chunk);
      await writeChunk(chunk);
    }
    await new Promise<void>((resolve, reject) => {
      out.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
    if (bytes === 0) throw new MediaValidationError('MEDIA_EMPTY', '빈 파일입니다.');
    const sniffed = validateSniff(Buffer.concat(headChunks), target.expectKind);
    const sha256 = hash.digest('hex');
    const dest = finalPaths(target, sniffed.ext, sha256);
    renameSync(tmp, dest.full);
    return { kind: sniffed.kind, url: dest.url, mime: sniffed.mime, bytes, sha256 };
  } catch (e) {
    try { await reader.cancel(); } catch { /* keep original error */ }
    if (!out.closed) {
      await new Promise<void>((resolve) => {
        out.once('close', () => resolve());
        out.destroy();
      });
    }
    rmSync(tmp, { force: true });
    throw e;
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}
