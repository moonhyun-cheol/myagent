/** Allow only http(s) Preview navigations. Accept bare hosts like `example.com`. */

export function normalizeBrowserUrl(value: string): string | null {
  let url = value.trim();
  if (!url) return null;
  if (!/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(url)) {
    url = `https://${url}`;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!parsed.hostname) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/** @deprecated Prefer normalizeBrowserUrl — kept for callers that already pass full http(s). */
export function validHttpUrl(value: string): string | null {
  const url = value.trim();
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/** Local/dev servers can stay in the Preview iframe (device frames). */
export function isLocalPreviewUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return (
      host === 'localhost'
      || host === '127.0.0.1'
      || host === '[::1]'
      || host === '0.0.0.0'
      || host.endsWith('.localhost')
      || host.endsWith('.local')
    );
  } catch {
    return false;
  }
}

export const BROWSER_HISTORY_MAX = 50;
