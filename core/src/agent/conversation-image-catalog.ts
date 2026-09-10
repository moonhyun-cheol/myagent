/**
 * CQR_PA port #5 — model-driven historical image context.
 *
 * Builds a bounded, lightweight catalog of images already supplied in a
 * conversation so the model stays aware they exist without replaying every
 * image or applying any local relevance heuristics. The catalog carries
 * metadata only (attachment id, message position/time, filename, MIME, and a
 * short excerpt of the originating user message). The model decides whether to
 * fetch an original by id via the `conversation_image_get` tool; retrieval is
 * scoped to images linked to the same session and rejects SVG, oversized,
 * missing, or foreign attachments.
 *
 * There is intentionally NO keyword matching, similarity scoring, or automatic
 * reattachment here. Selection is the model's job.
 */
import type { SessionMessage } from '../sessions/types.js';

export interface ConversationImageCatalogEntry {
  attachment_id: string;
  /** 0-based index of the originating message within durable session history. */
  message_index: number;
  /** ISO timestamp of the originating message, when known. */
  at?: string;
  role: 'user' | 'assistant';
  filename: string;
  mime: string;
  /** Short excerpt of the originating message text (no full replay). */
  excerpt: string;
}

/** Upper bound so long conversations cannot balloon the system prompt. */
export const CONVERSATION_IMAGE_CATALOG_MAX = 16;
/** Retrieval size guard mirrors the default attachment upload ceiling. */
export const CONVERSATION_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const EXCERPT_MAX = 140;

/** Images the model may fetch. SVG is excluded (script/vector, not pixels). */
export function isCatalogEligibleImageMime(mime: string): boolean {
  const m = (mime || '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!m.startsWith('image/')) return false;
  return m !== 'image/svg+xml';
}

function excerptOf(content: string): string {
  const text = (content ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= EXCERPT_MAX) return text;
  return `${text.slice(0, EXCERPT_MAX)}…`;
}

/**
 * Scan durable session messages and return the most recent image attachments as
 * catalog metadata. Bounded to {@link CONVERSATION_IMAGE_CATALOG_MAX} newest.
 */
export function buildConversationImageCatalog(
  messages: SessionMessage[] | undefined | null,
  max: number = CONVERSATION_IMAGE_CATALOG_MAX,
): ConversationImageCatalogEntry[] {
  const entries: ConversationImageCatalogEntry[] = [];
  const list = Array.isArray(messages) ? messages : [];
  list.forEach((message, index) => {
    const attachments = message.attachments ?? [];
    for (const att of attachments) {
      if (!att || typeof att.id !== 'string') continue;
      if (!isCatalogEligibleImageMime(att.mime)) continue;
      entries.push({
        attachment_id: att.id,
        message_index: index,
        at: message.at,
        role: message.role,
        filename: att.name || att.id,
        mime: (att.mime || '').split(';')[0]?.trim() || 'image/*',
        excerpt: excerptOf(message.content),
      });
    }
  });
  // Keep the newest N in chronological order.
  if (entries.length <= max) return entries;
  return entries.slice(entries.length - max);
}

/**
 * System note describing the catalog. States plainly that it holds metadata,
 * not pixels, and that the model must call the retrieval tool before implying
 * it inspected an image's contents.
 */
export function formatConversationImageCatalogNote(
  entries: ConversationImageCatalogEntry[],
): string {
  if (!entries.length) return '';
  const lines = entries.map(
    (e) =>
      `- id=${e.attachment_id} · msg#${e.message_index} (${e.role}${e.at ? `, ${e.at}` : ''}) · ${e.filename} · ${e.mime}${e.excerpt ? ` · "${e.excerpt}"` : ''}`,
  );
  return [
    '## Conversation image catalog (metadata only — not pixels)',
    'These images were supplied earlier in THIS conversation. The list is metadata,',
    'not the image contents. Do not claim to see or describe a specific image unless',
    'you fetch it: call `conversation_image_get` with its id to load one original as',
    'a multimodal image for your next step. Retrieval is limited to this session and',
    'rejects SVG, oversized, missing, or foreign attachments. No automatic reattachment',
    'or keyword matching is performed — choose by id when a past image is relevant.',
    ...lines,
  ].join('\n');
}

export interface ConversationImageValidation {
  ok: boolean;
  reason?: 'missing' | 'foreign' | 'not_image' | 'svg_rejected' | 'too_large';
  detail?: string;
}

/**
 * Validate a resolved attachment record for retrieval. `sessionId` scoping is
 * enforced by the caller (AttachmentService.get(id, sessionId)); a null record
 * means missing or foreign to the session.
 */
export function validateConversationImage(
  rec: { mime: string; size_bytes: number } | null,
  maxBytes: number = CONVERSATION_IMAGE_MAX_BYTES,
): ConversationImageValidation {
  if (!rec) return { ok: false, reason: 'missing', detail: 'attachment not found in this session' };
  const mime = (rec.mime || '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (mime === 'image/svg+xml') return { ok: false, reason: 'svg_rejected', detail: 'SVG is not retrievable' };
  if (!mime.startsWith('image/')) return { ok: false, reason: 'not_image', detail: `not an image: ${mime || 'unknown'}` };
  if (rec.size_bytes > maxBytes) {
    return { ok: false, reason: 'too_large', detail: `${rec.size_bytes} bytes exceeds ${maxBytes}` };
  }
  return { ok: true };
}
