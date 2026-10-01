/**
 * Organization release mirrors (Gitea primary + GitHub mirror, same signed artifacts).
 *
 * The signed feed/asset documents are immutable and may name either repository
 * (seq ≤19/5 were signed as GitHub `moonhyun-cheol/myagent-org`, newer ones as Gitea
 * `ins78516/myagent-org`). Every repository listed here is treated as the same release
 * set, so a feed or asset is fetched from the mirrors in configured order.
 *
 * Fallback happens only for transport failures (network error, attempt timeout,
 * 404/408/429/5xx). A successful response that fails size/SHA-256/signature checks is
 * never retried on another mirror — callers stop and report it.
 */
import { loadDeployDefaults } from '../config/deploy-defaults.js';

export interface ReleaseMirror {
  id: string;
  /** owner/name as written in signed feeds. */
  repository: string;
  /** Raw file base, ending with `/` (e.g. `.../raw/branch/main/`). */
  raw_base_url: string;
  /** Release download base, ending with `/` (`{base}{tag}/{name}`). */
  release_download_base_url: string;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function normalizeBase(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:') return null;
    const text = url.href;
    return text.endsWith('/') ? text : `${text}/`;
  } catch {
    return null;
  }
}

export function parseReleaseMirrors(raw: unknown): ReleaseMirror[] {
  if (!Array.isArray(raw)) return [];
  const out: ReleaseMirror[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const doc = item as Record<string, unknown>;
    const repository = typeof doc.repository === 'string' ? doc.repository.trim() : '';
    const rawBase = normalizeBase(doc.raw_base_url);
    const assetBase = normalizeBase(doc.release_download_base_url);
    if (!REPO_RE.test(repository) || !rawBase || !assetBase) continue;
    out.push({
      id: typeof doc.id === 'string' && doc.id.trim() ? doc.id.trim() : repository,
      repository,
      raw_base_url: rawBase,
      release_download_base_url: assetBase,
    });
  }
  return out;
}

/** Mirrors from deploy-defaults. `MY_AGENT_UPDATE_MIRRORS=0` disables (single-URL behavior). */
export function loadReleaseMirrors(cqrRoot: string): ReleaseMirror[] {
  const flag = String(process.env.MY_AGENT_UPDATE_MIRRORS ?? '').trim().toLowerCase();
  if (flag === '0' || flag === 'off' || flag === 'false') return [];
  try {
    return parseReleaseMirrors(loadDeployDefaults(cqrRoot).organization_release_mirrors);
  } catch {
    return [];
  }
}

export function mirrorHosts(mirrors: readonly ReleaseMirror[]): string[] {
  const hosts = new Set<string>();
  for (const m of mirrors) {
    hosts.add(new URL(m.raw_base_url).hostname.toLowerCase());
    hosts.add(new URL(m.release_download_base_url).hostname.toLowerCase());
  }
  return [...hosts];
}

/**
 * Feed URL → ordered candidates. A URL under any mirror raw base is rewritten to the
 * same relative path on every mirror (configured order). Other URLs stay single.
 */
export function feedUrlCandidates(feedUrl: string, mirrors: readonly ReleaseMirror[]): string[] {
  const text = feedUrl.trim();
  for (const m of mirrors) {
    if (text.toLowerCase().startsWith(m.raw_base_url.toLowerCase())) {
      const rel = text.slice(m.raw_base_url.length);
      return [...new Set(mirrors.map((x) => `${x.raw_base_url}${rel}`))];
    }
  }
  return [text];
}

/** True when the signed repository is one of the mirrored repositories. */
export function isMirroredRepository(repository: string, mirrors: readonly ReleaseMirror[]): boolean {
  const repo = repository.trim().toLowerCase();
  return mirrors.some((m) => m.repository.toLowerCase() === repo);
}

/** Ordered release-asset URLs for a mirrored repository (empty when not mirrored). */
export function mirrorAssetUrls(
  input: { repository: string; releaseTag: string; name: string },
  mirrors: readonly ReleaseMirror[],
): URL[] {
  if (!isMirroredRepository(input.repository, mirrors)) return [];
  const tag = encodeURIComponent(String(input.releaseTag ?? ''));
  const name = encodeURIComponent(String(input.name ?? ''));
  if (!tag || !name) return [];
  const seen = new Set<string>();
  const out: URL[] = [];
  for (const m of mirrors) {
    const url = new URL(`${m.release_download_base_url}${tag}/${name}`);
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    out.push(url);
  }
  return out;
}

export function isMirrorFallbackStatus(status: number): boolean {
  return status === 404 || status === 408 || status === 429 || status >= 500;
}

export interface MirrorFetchAttempt {
  url: string;
  status?: number;
  error?: string;
}

export interface MirrorFetchResult {
  response: Response;
  url: URL;
  attempts: MirrorFetchAttempt[];
}

/**
 * Fetch the first mirror that answers. Returns the last response when every mirror
 * answered with a fallback status (callers keep their own 404/HTTP handling).
 * Throws the last network error when no mirror answered. Outer abort is never retried.
 */
export async function fetchFromMirrors(
  urls: readonly URL[],
  opts: {
    headers: Record<string, string>;
    signal?: AbortSignal;
    /** Per-attempt timeout until response headers arrive. */
    attemptTimeoutMs: number;
    /** Throws when the URL must not be fetched (host policy). */
    validate: (url: URL) => void;
  },
): Promise<MirrorFetchResult> {
  if (!urls.length) throw new Error('no mirror URL');
  const attempts: MirrorFetchAttempt[] = [];
  let lastError: unknown = null;
  for (let i = 0; i < urls.length; i += 1) {
    const url = urls[i];
    const isLast = i === urls.length - 1;
    opts.validate(url);
    if (opts.signal?.aborted) throw opts.signal.reason ?? new DOMException('Aborted', 'AbortError');
    const attempt = new AbortController();
    const timer = setTimeout(
      () => attempt.abort(new DOMException('Mirror attempt timed out', 'TimeoutError')),
      opts.attemptTimeoutMs,
    );
    const signal = opts.signal ? AbortSignal.any([opts.signal, attempt.signal]) : attempt.signal;
    try {
      const response = await fetch(url, { redirect: 'follow', headers: opts.headers, signal });
      clearTimeout(timer);
      attempts.push({ url: url.href, status: response.status });
      if (!isLast && isMirrorFallbackStatus(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        continue;
      }
      return { response, url, attempts };
    } catch (error) {
      clearTimeout(timer);
      if (opts.signal?.aborted) throw error;
      attempts.push({ url: url.href, error: error instanceof Error ? error.message : String(error) });
      lastError = error;
      if (isLast) throw error;
    }
  }
  throw lastError ?? new Error('mirror fetch failed');
}
