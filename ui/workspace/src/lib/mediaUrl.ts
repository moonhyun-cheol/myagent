/**
 * Generated-media kind detection for chat turns.
 *
 * Core stores verified videos under `/outputs/videos/` and images under
 * `/outputs/images/` (signature-checked, see core media-store). The directory is
 * the kind; the extension check only covers legacy/foreign URLs.
 */
export function isVideoMediaUrl(url: string): boolean {
  if (url.startsWith('/outputs/videos/')) return true;
  if (url.startsWith('/outputs/images/')) return false;
  if (url.startsWith('/fs/workspace-raw')) {
    try {
      const parsed = new URL(url, 'http://localhost');
      const p = parsed.searchParams.get('path') || '';
      if (/\.(mp4|webm)$/i.test(p)) return true;
    } catch {
      /* ignore */
    }
  }
  return /\.(mp4|webm)(?:$|[?#])/i.test(url);
}

export function buildWorkspaceRawUrl(relPath: string, sessionId?: string | null): string {
  const params = new URLSearchParams({ path: relPath });
  if (sessionId?.trim()) {
    params.set('session', sessionId.trim());
  }
  return `/fs/workspace-raw?${params.toString()}`;
}
