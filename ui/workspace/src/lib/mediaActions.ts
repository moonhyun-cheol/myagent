/** Clipboard / download helpers for chat + canvas media. */
import { buildWorkspaceRawUrl } from './mediaUrl';

export async function copyText(text: string): Promise<void> {
  const t = text.trim();
  if (!t) throw new Error('텍스트 없음');
  await navigator.clipboard.writeText(t);
}

export async function copyImageUrl(url: string): Promise<void> {
  const u = url.trim();
  if (!u) throw new Error('주소 없음');
  await navigator.clipboard.writeText(u);
}

async function blobFromImageUrl(url: string): Promise<Blob> {
  const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!res.ok) throw new Error(`이미지를 불러오지 못했습니다 (${res.status})`);
  return res.blob();
}

/** Best-effort image copy (ClipboardItem). Falls back to URL copy. */
export async function copyImageToClipboard(url: string): Promise<'image' | 'url'> {
  const blob = await blobFromImageUrl(url);
  const type = blob.type || 'image/png';
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ [type]: blob })]);
      return 'image';
    } catch {
      /* fall through — some hosts block image clipboard */
    }
  }
  await navigator.clipboard.writeText(url);
  return 'url';
}

export function downloadImageUrl(url: string, filename?: string): void {
  const resolvedName = sanitizeMediaFilename(filename || guessImageFilename(undefined, url));
  const a = document.createElement('a');
  a.href = url;
  a.download = resolvedName;
  a.rel = 'noopener';
  a.target = '_blank';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const KNOWN_MEDIA_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|ico|svg|mp4|webm)$/i;

function extractExtFromUrl(url?: string): string | null {
  if (!url) return null;
  if (url.startsWith('data:image/')) {
    const m = url.match(/^data:image\/([a-z0-9+.-]+);/i);
    if (m) {
      const sub = m[1].toLowerCase();
      if (sub === 'jpeg') return 'jpg';
      if (sub === 'svg+xml') return 'svg';
      if (sub === 'x-icon' || sub === 'vnd.microsoft.icon') return 'ico';
      return sub;
    }
  }
  if (url.startsWith('/fs/workspace-raw')) {
    try {
      const parsed = new URL(url, 'http://localhost');
      const rel = parsed.searchParams.get('path') || '';
      const extMatch = rel.match(KNOWN_MEDIA_EXT_RE);
      if (extMatch) return extMatch[1].toLowerCase();
    } catch {
      /* ignore */
    }
  }
  const direct = url.match(/\.(png|jpe?g|webp|gif|bmp|ico|svg|mp4|webm)(?:$|[?#])/i);
  if (direct) return direct[1].toLowerCase();
  if (url.startsWith('/outputs/videos/')) return 'mp4';
  return null;
}

export function sanitizeMediaFilename(raw: string, fallback = 'my-agent-image.png'): string {
  const cleaned = raw
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, '-')
    .replace(/_+/g, '_')
    .slice(0, 96);
  return cleaned || fallback;
}

export function guessImageFilename(title?: string, url?: string, sourcePath?: string): string {
  const pathBase = sourcePath?.trim().split(/[\\/]/).pop() || '';
  const trimmedTitle = (title || pathBase || '').trim();
  const titleExtMatch = trimmedTitle.match(KNOWN_MEDIA_EXT_RE);
  const pathExtMatch = pathBase.match(KNOWN_MEDIA_EXT_RE);
  const urlExt = extractExtFromUrl(url);
  const ext = (titleExtMatch?.[1] || pathExtMatch?.[1] || urlExt || 'png').toLowerCase();
  const baseRaw = titleExtMatch
    ? trimmedTitle.slice(0, trimmedTitle.length - titleExtMatch[0].length)
    : trimmedTitle;
  const base = sanitizeMediaFilename(baseRaw || 'my-agent-media', 'my-agent-media').slice(0, 64);
  return `${base}.${ext}`;
}

export function guessVideoFilename(title?: string, url?: string, sourcePath?: string): string {
  const pathBase = sourcePath?.trim().split(/[\\/]/).pop() || '';
  const trimmedTitle = (title || pathBase || '').trim();
  const titleExtMatch = trimmedTitle.match(/\.(mp4|webm)$/i);
  const pathExtMatch = pathBase.match(/\.(mp4|webm)$/i);
  const urlExt = extractExtFromUrl(url);
  const ext = (titleExtMatch?.[1] || pathExtMatch?.[1] || (urlExt === 'webm' ? 'webm' : 'mp4')).toLowerCase();
  const baseRaw = titleExtMatch
    ? trimmedTitle.slice(0, trimmedTitle.length - titleExtMatch[0].length)
    : trimmedTitle;
  const base = sanitizeMediaFilename(baseRaw || 'my-agent-video', 'my-agent-video').slice(0, 64);
  return `${base}.${ext}`;
}

export async function downloadMediaItem(opts: {
  url?: string;
  sourcePath?: string;
  filename?: string;
  sessionId?: string | null;
}): Promise<boolean> {
  let targetUrl = opts.url?.trim() || '';
  if (!targetUrl && opts.sourcePath?.trim()) {
    const clean = opts.sourcePath.replace(/\\/g, '/').replace(/^\.\//, '').trim();
    // Same query contract as the core route (`path`, `session`).
    targetUrl = buildWorkspaceRawUrl(clean, opts.sessionId);
  }
  if (!targetUrl) return false;
  downloadImageUrl(targetUrl, opts.filename || guessImageFilename(undefined, targetUrl, opts.sourcePath));
  return true;
}
