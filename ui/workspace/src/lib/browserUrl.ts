/** Allow only http(s) Preview navigations. Preserve the typed string (query/hash intact). */
export function validHttpUrl(value: string): string | null {
  const url = value.trim();
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

export const BROWSER_HISTORY_MAX = 50;
