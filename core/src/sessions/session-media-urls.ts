import type { SessionMessage } from './types.js';

/**
 * Local generated-media URLs that may be carried across sessions
 * (portable import, summary → new session). Only same-origin core output
 * paths are accepted so an imported file cannot inject remote URLs.
 */
const LOCAL_MEDIA_URL_RE = /^\/outputs\/(images|videos)\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/;

export const MAX_CARRIED_MEDIA_URLS = 50;

export function isLocalMediaUrl(url: unknown): url is string {
  return typeof url === 'string' && !url.includes('..') && LOCAL_MEDIA_URL_RE.test(url);
}

export function isLocalVideoUrl(url: string): boolean {
  return isLocalMediaUrl(url) && url.startsWith('/outputs/videos/');
}

/** Keep only safe local media URLs (dedupe, order preserved). */
export function sanitizeLocalMediaUrls(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const url of raw) {
    if (isLocalMediaUrl(url) && !out.includes(url)) out.push(url);
    if (out.length >= MAX_CARRIED_MEDIA_URLS) break;
  }
  return out;
}

/** Collect generated media URLs from a session's messages (oldest first, deduped). */
export function collectSessionMediaUrls(messages: SessionMessage[]): string[] {
  const out: string[] = [];
  for (const msg of messages) {
    for (const url of sanitizeLocalMediaUrls(msg.image_urls)) {
      if (!out.includes(url)) out.push(url);
    }
  }
  return out.slice(-MAX_CARRIED_MEDIA_URLS);
}

/** One-line note appended to the summary so the next turn knows media exists (URLs are not sent to the model). */
export function formatCarriedMediaNote(urls: string[]): string {
  const videos = urls.filter(isLocalVideoUrl).length;
  const images = urls.length - videos;
  const parts: string[] = [];
  if (videos) parts.push(`동영상 ${videos}개`);
  if (images) parts.push(`이미지 ${images}개`);
  return parts.length ? `(이전 대화에서 만든 ${parts.join(', ')}를 아래에 함께 표시합니다.)` : '';
}
