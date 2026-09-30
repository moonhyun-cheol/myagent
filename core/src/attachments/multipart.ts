import type { IncomingMessage } from 'node:http';

export interface ParsedMultipartFile {
  fieldName: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

/** Minimal multipart/form-data parser (single or multiple file parts). */
export async function parseMultipart(req: IncomingMessage): Promise<ParsedMultipartFile[]> {
  const contentType = req.headers['content-type'] ?? '';
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!match) {
    throw new Error('MULTIPART_BOUNDARY_MISSING');
  }
  const boundary = match[1] ?? match[2];
  const raw = await readRawBody(req);
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = splitBuffers(raw, delimiter).filter((p) => p.length > 0 && !p.equals(Buffer.from('--\r\n')));

  const files: ParsedMultipartFile[] = [];
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const headerText = part.subarray(0, headerEnd).toString('utf8');

    const disposition = parseContentDisposition(headerText);
    const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerText);

    // filename이 없거나 빈 문자열이어도 image/* 파트는 클립보드 붙여넣기로 간주하여 수용
    const detectedType = typeMatch?.[1]?.trim().toLowerCase() ?? '';
    const isImagePart = detectedType.startsWith('image/');
    const rawName = disposition.filename;
    if (!rawName && !isImagePart) continue;

    let body = part.subarray(headerEnd + 4);
    if (body.subarray(-2).equals(Buffer.from('\r\n'))) {
      body = body.subarray(0, body.length - 2);
    }

    const fallbackExt = detectedType.split('/')[1]?.split(';')[0] ?? 'png';
    const filename = rawName || `paste-${Date.now()}.${fallbackExt}`;

    files.push({
      fieldName: disposition.name || 'file',
      filename,
      contentType: typeMatch?.[1]?.trim() ?? (isImagePart ? `image/${fallbackExt}` : 'application/octet-stream'),
      data: body,
    });
  }

  return files;
}

/**
 * Content-Disposition 파라미터 해석.
 * - 따옴표 유무 모두 허용 (.NET MultipartFormDataContent는 `name=file; filename=a.pdf`처럼 따옴표 없이 보냄)
 * - RFC 5987 `filename*=utf-8''…`가 있으면 우선 사용
 * - RFC 2047 `=?utf-8?B?…?=` / `=?utf-8?Q?…?=` 인코딩 이름 복원
 */
export function parseContentDisposition(headerText: string): { name: string; filename: string } {
  const line = headerText
    .split(/\r?\n/)
    .find((l) => /^\s*content-disposition\s*:/i.test(l));
  if (!line) return { name: '', filename: '' };
  const params = new Map<string, string>();
  const paramRe = /;\s*([^=;\s]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/g;
  let m: RegExpExecArray | null;
  while ((m = paramRe.exec(line)) !== null) {
    const key = m[1].toLowerCase();
    const value = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : (m[3] ?? '').trim();
    if (!params.has(key)) params.set(key, value);
  }
  const name = params.get('name') ?? '';
  let filename = '';
  const extended = params.get('filename*');
  if (extended) filename = decodeRfc5987(extended);
  if (!filename) filename = decodeRfc2047(params.get('filename') ?? '');
  return { name: name.trim(), filename: filename.trim() };
}

function decodeRfc5987(value: string): string {
  const m = /^([^']*)'[^']*'(.*)$/.exec(value.trim());
  if (!m) return '';
  const charset = m[1].toLowerCase();
  const encoded = m[2];
  try {
    if (charset === 'utf-8' || charset === 'utf8' || charset === '') {
      return decodeURIComponent(encoded);
    }
    const bytes = Buffer.from(encoded.replace(/%([0-9a-f]{2})/gi, (_s, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1');
    return bytes.toString('latin1');
  } catch {
    return '';
  }
}

function decodeRfc2047(value: string): string {
  if (!value.includes('=?')) return value;
  return value
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (whole, charset: string, enc: string, text: string) => {
      const cs = charset.toLowerCase();
      if (cs !== 'utf-8' && cs !== 'utf8') return whole;
      try {
        if (enc.toLowerCase() === 'b') return Buffer.from(text, 'base64').toString('utf8');
        const qp = text
          .replace(/_/g, ' ')
          .replace(/=([0-9a-f]{2})/gi, (_s, h: string) => String.fromCharCode(parseInt(h, 16)));
        return Buffer.from(qp, 'latin1').toString('utf8');
      } catch {
        return whole;
      }
    });
}

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function splitBuffers(buf: Buffer, sep: Buffer): Buffer[] {
  const result: Buffer[] = [];
  let start = 0;
  let idx = buf.indexOf(sep, start);
  while (idx !== -1) {
    if (idx > start) result.push(buf.subarray(start, idx));
    start = idx + sep.length;
    if (buf.subarray(start, start + 2).equals(Buffer.from('\r\n'))) start += 2;
    idx = buf.indexOf(sep, start);
  }
  if (start < buf.length) result.push(buf.subarray(start));
  return result;
}
