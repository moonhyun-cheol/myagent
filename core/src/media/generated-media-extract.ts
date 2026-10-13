/**
 * Extract model-generated images from provider payloads (Responses `output[]`,
 * Responses stream items, Chat Completions `message.images` / `delta.images`).
 *
 * Only inline base64 / data: URLs are accepted here. Remote URLs and non-image
 * results are counted as `unsupported` so the caller can report them as
 * "확인 안 됨" instead of success. Remote download (SSRF guard) is P1.
 *
 * See docs/media-output-persistence-plan.md (P0-3).
 */
import { createHash } from 'node:crypto';

export interface GeneratedImagePayload {
  /** Declared MIME when available; the stored format is still decided by signature. */
  mime?: string;
  base64: string;
}

export interface GeneratedMedia {
  images: GeneratedImagePayload[];
  /** Results that looked like generated media but cannot be stored (remote URL, video, unknown shape). */
  unsupported: number;
}

const MAX_GENERATED_IMAGES = 16;

export function emptyGeneratedMedia(): GeneratedMedia {
  return { images: [], unsupported: 0 };
}

export function hasGeneratedMedia(media: GeneratedMedia | undefined): boolean {
  return Boolean(media && (media.images.length > 0 || media.unsupported > 0));
}

function cleanBase64(value: string): string {
  return value.replace(/\s/g, '');
}

function looksBase64(value: string): boolean {
  return value.length >= 16 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(value);
}

/** `data:image/png;base64,...` → payload. Non-image data URLs return null. */
export function parseImageDataUrl(url: string): GeneratedImagePayload | null {
  const m = /^data:(image\/[A-Za-z0-9.+-]+)(?:;[^,]*)?;base64,([\s\S]+)$/i.exec(url.trim());
  if (!m) return null;
  const base64 = cleanBase64(m[2]);
  return looksBase64(base64) ? { mime: m[1].toLowerCase(), base64 } : null;
}

function mimeFromFormat(format: unknown): string | undefined {
  if (typeof format !== 'string') return undefined;
  const f = format.toLowerCase();
  if (f === 'png' || f === 'jpeg' || f === 'webp' || f === 'gif') return `image/${f}`;
  if (f === 'jpg') return 'image/jpeg';
  return undefined;
}

type Sink = { add: (payload: GeneratedImagePayload) => void; unsupported: () => void };

function readImageRef(value: unknown, sink: Sink, mimeHint?: string): boolean {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^data:/i.test(trimmed)) {
      const parsed = parseImageDataUrl(trimmed);
      if (parsed) sink.add(parsed);
      else sink.unsupported();
      return true;
    }
    if (/^https?:\/\//i.test(trimmed)) {
      sink.unsupported();
      return true;
    }
    const b64 = cleanBase64(trimmed);
    if (looksBase64(b64)) {
      sink.add({ mime: mimeHint, base64: b64 });
      return true;
    }
    return false;
  }
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    if (typeof rec.url === 'string') return readImageRef(rec.url, sink, mimeHint);
  }
  return false;
}

/** One content part / image entry (`output_image`, `image_url`, `{b64_json}` …). */
function readImagePart(part: unknown, sink: Sink): void {
  if (!part || typeof part !== 'object') return;
  const rec = part as Record<string, unknown>;
  const type = typeof rec.type === 'string' ? rec.type : '';
  const mime = mimeFromFormat(rec.output_format) ?? (typeof rec.mime_type === 'string' ? rec.mime_type : undefined);
  if (typeof rec.b64_json === 'string' && readImageRef(rec.b64_json, sink, mime)) return;
  if (type === 'output_image' || type === 'image' || type === 'image_url') {
    if (readImageRef(rec.image_url, sink, mime)) return;
    if (readImageRef(rec.url, sink, mime)) return;
    if (readImageRef(rec.data, sink, mime)) return;
    if (readImageRef(rec.image_base64, sink, mime)) return;
    sink.unsupported();
    return;
  }
  if (/video/i.test(type)) sink.unsupported();
}

function collector(): { sink: Sink; result: GeneratedMedia } {
  const result = emptyGeneratedMedia();
  const seen = new Set<string>();
  const sink: Sink = {
    add: (payload) => {
      const key = createHash('sha256').update(payload.base64).digest('hex');
      if (seen.has(key)) return;
      seen.add(key);
      if (result.images.length < MAX_GENERATED_IMAGES) result.images.push(payload);
    },
    unsupported: () => {
      result.unsupported += 1;
    },
  };
  return { sink, result };
}

/** Responses API output items (completed document `output[]` or streamed `output_item.done` items). */
export function collectFromResponsesOutput(items: unknown[] | undefined): GeneratedMedia {
  const { sink, result } = collector();
  for (const item of items ?? []) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const type = typeof rec.type === 'string' ? rec.type : '';
    if (type === 'image_generation_call') {
      const mime = mimeFromFormat(rec.output_format);
      if (!readImageRef(rec.result, sink, mime)) {
        // A call without a final image (failed / still partial) is not success.
        if (rec.status !== 'in_progress' && rec.status !== 'generating') sink.unsupported();
      }
      continue;
    }
    if (type === 'message') {
      const content = Array.isArray(rec.content) ? rec.content : [];
      for (const part of content) readImagePart(part, sink);
      continue;
    }
    if (/video/i.test(type)) sink.unsupported();
  }
  return result;
}

/** Chat Completions `message` or stream `delta` (OpenRouter `images[]` + multimodal `content[]`). */
export function collectFromChatMessage(message: unknown): GeneratedMedia {
  const { sink, result } = collector();
  if (!message || typeof message !== 'object') return result;
  const rec = message as Record<string, unknown>;
  if (Array.isArray(rec.images)) {
    for (const img of rec.images) readImagePart({ type: 'image_url', ...(img as object) }, sink);
  }
  if (Array.isArray(rec.content)) {
    for (const part of rec.content) readImagePart(part, sink);
  }
  return result;
}

/** Merge (dedupe by payload) — e.g. stream items + terminal document. */
export function mergeGeneratedMedia(...parts: Array<GeneratedMedia | undefined>): GeneratedMedia {
  const { sink, result } = collector();
  let unsupported = 0;
  for (const part of parts) {
    if (!part) continue;
    for (const img of part.images) sink.add(img);
    unsupported = Math.max(unsupported, part.unsupported);
  }
  // Same result seen through two channels must not double-count.
  result.unsupported = unsupported;
  return result;
}
