import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertWritablePath } from '../security/path-guard.js';
import type { ProviderStore } from '../providers/provider-store.js';

export interface IngestOwuiImagesOpts {
  content: string;
  providerStore: ProviderStore;
  providerId: string;
  sessionId: string;
  imageOutDir: string;
  cqrRoot: string;
  /** Cap ingested images (e.g. image_gen should return one preview). */
  maxImages?: number;
}

export interface IngestOwuiImagesResult {
  content: string;
  imageUrls: string[];
}

const OWUI_FILE_ID_RE = /\/api\/v1\/files\/([a-f0-9-]+)\/content/i;
const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;

export function owuiFileIdFromUrl(url: string): string | null {
  const trimmed = url.trim();
  try {
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      const u = new URL(trimmed);
      const m = u.pathname.match(OWUI_FILE_ID_RE);
      return m?.[1] ?? null;
    }
  } catch {
    /* ignore */
  }
  const m = trimmed.match(OWUI_FILE_ID_RE);
  return m?.[1] ?? null;
}

export function findOwuiFileIds(content: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  for (const m of content.matchAll(MD_IMAGE_RE)) {
    const id = owuiFileIdFromUrl(m[2]);
    if (id) add(id);
  }
  for (const m of content.matchAll(/\/api\/v1\/files\/([a-f0-9-]+)\/content/gi)) {
    add(m[1]);
  }
  return ids;
}

export function findDataUrlImages(content: string): string[] {
  const urls: string[] = [];
  for (const m of content.matchAll(/!\[[^\]]*\]\((data:image\/[^)]+)\)/gi)) {
    urls.push(m[1]);
  }
  return urls;
}

export function stripOwuiImageMarkdown(content: string): string {
  let s = content
    .replace(MD_IMAGE_RE, (full, _alt: string, rawUrl: string) => {
      const url = String(rawUrl || '').trim();
      return /^data:image\//i.test(url) || owuiFileIdFromUrl(url) ? '' : full;
    })
    .replace(/\/api\/v1\/files\/[a-f0-9-]+\/content/gi, '');
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s || '이미지를 생성했습니다.';
}

function owuiOriginFromBaseUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/$/, '');
  try {
    const u = new URL(base);
    return u.origin;
  } catch {
    return base.replace(/\/api(\/v1)?$/i, '');
  }
}

function extFromMime(mime: string): string {
  const m = mime.split(';')[0].trim().toLowerCase();
  if (m === 'image/jpeg' || m === 'image/jpg') return '.jpg';
  if (m === 'image/webp') return '.webp';
  if (m === 'image/gif') return '.gif';
  return '.png';
}

async function fetchOwuiFile(
  origin: string,
  apiKey: string,
  fileId: string,
): Promise<{ buffer: Buffer; mime: string }> {
  const url = `${origin}/api/v1/files/${fileId}/content`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OWUI_FILE_${res.status}: ${text.slice(0, 120)}`);
  }
  const mime = res.headers.get('content-type') ?? 'image/png';
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length === 0) throw new Error('OWUI_FILE_EMPTY');
  return { buffer, mime };
}

export async function ingestOwuiChatImages(opts: IngestOwuiImagesOpts): Promise<IngestOwuiImagesResult> {
  const fileIds = findOwuiFileIds(opts.content);
  const dataUrls = findDataUrlImages(opts.content);
  if (!fileIds.length && !dataUrls.length) {
    return { content: opts.content, imageUrls: [] };
  }

  const resolved = opts.providerStore.resolveProvider(opts.providerId);
  if (!resolved?.secret.api_key || resolved.secret.api_key.startsWith('stub:')) {
    return { content: opts.content, imageUrls: [] };
  }

  const origin = owuiOriginFromBaseUrl(resolved.baseUrl);
  const sessionDir = path.join(opts.imageOutDir, opts.sessionId);
  mkdirSync(sessionDir, { recursive: true });

  const imageUrls: string[] = [];
  const seenHashes = new Set<string>();
  let idx = 0;

  const rememberBuffer = (buffer: Buffer): boolean => {
    const hash = createHash('sha256').update(buffer).digest('hex');
    if (seenHashes.has(hash)) return false;
    seenHashes.add(hash);
    return true;
  };

  const cap = opts.maxImages != null && opts.maxImages > 0 ? opts.maxImages : Infinity;
  const canAddMore = () => imageUrls.length < cap;

  // OWUI multimodal replies often include both a file reference (markdown) and an inline
  // data URL for the same image; prefer file refs and skip redundant data URLs.
  const dataUrlsToSave = fileIds.length > 0 ? [] : dataUrls;
  for (const dataUrl of dataUrlsToSave) {
    if (!canAddMore()) break;
    try {
      const m = dataUrl.match(/^data:(image\/[^;]+);base64,([\s\S]+)$/i);
      if (!m) continue;
      const buffer = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
      if (!rememberBuffer(buffer)) continue;
      const filename = `inline-${idx++}.png`;
      const outputPath = path.join(sessionDir, filename);
      assertWritablePath(outputPath, opts.cqrRoot);
      writeFileSync(outputPath, buffer);
      imageUrls.push(`/outputs/images/${opts.sessionId}/${filename}`);
    } catch {
      /* skip failed data url */
    }
  }

  for (const fileId of fileIds) {
    if (!canAddMore()) break;
    try {
      const { buffer, mime } = await fetchOwuiFile(origin, resolved.secret.api_key, fileId);
      if (!rememberBuffer(buffer)) continue;
      const ext = extFromMime(mime);
      const filename = `${fileId}${ext}`;
      const outputPath = path.join(sessionDir, filename);
      assertWritablePath(outputPath, opts.cqrRoot);
      writeFileSync(outputPath, buffer);
      imageUrls.push(`/outputs/images/${opts.sessionId}/${filename}`);
    } catch {
      /* skip failed owui file fetch */
    }
  }

  if (!imageUrls.length) {
    return { content: opts.content, imageUrls: [] };
  }

  return {
    content: stripOwuiImageMarkdown(opts.content),
    imageUrls,
  };
}
