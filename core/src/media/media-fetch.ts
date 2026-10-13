import { isBlockedNetworkHost } from '../browser/url-guard.js';

/**
 * Guarded fetch for provider follow-ups (poll / download of generated media).
 *
 * - The configured provider origin is trusted (may be http/localhost for custom
 *   providers) and is the only origin that receives credentials.
 * - Any other origin must be https and must not be a loopback/private/link-local
 *   literal address; credentials are never sent there.
 * - Redirects are followed manually (each hop re-checked), at most `maxRedirects`.
 */
export interface GuardedMediaFetchOptions {
  doFetch: typeof fetch;
  trustedOrigin: string;
  /** Sent only to `trustedOrigin`. */
  authHeaders?: Record<string, string>;
  signal?: AbortSignal;
  maxRedirects?: number;
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);

export class MediaFetchBlockedError extends Error {
  constructor(message: string) {
    super(`MEDIA_FETCH_BLOCKED ${message}`);
    this.name = 'MediaFetchBlockedError';
  }
}

export function checkMediaFetchUrl(rawUrl: string, trustedOrigin: string): { url: URL; trusted: boolean } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new MediaFetchBlockedError(`invalid url`);
  }
  if (url.origin === trustedOrigin) return { url, trusted: true };
  if (url.protocol !== 'https:') throw new MediaFetchBlockedError(`non-https host ${url.host}`);
  if (url.username || url.password) throw new MediaFetchBlockedError(`credentials in url`);
  if (isBlockedNetworkHost(url.hostname)) throw new MediaFetchBlockedError(`private host ${url.hostname}`);
  return { url, trusted: false };
}

export async function guardedMediaFetch(rawUrl: string, opts: GuardedMediaFetchOptions): Promise<Response> {
  const max = opts.maxRedirects ?? 3;
  let current = rawUrl;
  for (let hop = 0; ; hop++) {
    const { url, trusted } = checkMediaFetchUrl(current, opts.trustedOrigin);
    const res = await opts.doFetch(url.toString(), {
      headers: trusted ? opts.authHeaders : undefined,
      redirect: 'manual',
      signal: opts.signal,
    });
    if (!REDIRECT.has(res.status)) return res;
    const location = res.headers.get('location');
    await res.body?.cancel().catch(() => undefined);
    if (!location) throw new MediaFetchBlockedError(`redirect without location`);
    if (hop >= max) throw new MediaFetchBlockedError(`too many redirects (>${max})`);
    current = new URL(location, url).toString();
  }
}
