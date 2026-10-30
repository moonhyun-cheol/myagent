import { URL } from 'node:url';
import { readFileSync, statSync } from 'node:fs';
import { lookup } from 'node:dns/promises';

export interface UrlGuardOptions {
  /** Allow loopback and private-LAN hosts (local dev). Link-local / unspecified / multicast stay blocked. */
  allowLocalhost?: boolean;
  /** Extra blocklist entries (tests / callers); merged with the configured user blocklist. */
  blockedUrls?: string[];
}

/**
 * Strict host check for server-side downloads (media, provider follow-ups):
 * loopback, private, link-local, CGNAT, unspecified and IPv6 ULA/link-local.
 * Literal-address check only (no DNS resolution).
 */
export function isBlockedNetworkHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  if (h.includes(':')) {
    if (h === '::' || h === '::1') return true;
    if (/^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h)) return true;
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
    if (mapped) return isBlockedNetworkHost(mapped[1]);
    // WHATWG URL normalizes ::ffff:127.0.0.1 → ::ffff:7f00:1
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16);
      const lo = parseInt(mappedHex[2], 16);
      return isBlockedNetworkHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
  }
  return false;
}

/**
 * Hosts never useful for browsing even in local-dev mode: link-local (cloud metadata
 * 169.254.169.254, fe80::/10), unspecified (0.0.0.0, ::) and multicast/reserved.
 */
export function isAlwaysBlockedBrowserHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || (a === 169 && b === 254) || a >= 224;
  }
  if (h.includes(':')) {
    if (h === '::') return true;
    if (/^fe[89ab][0-9a-f]?:/.test(h) || /^ff[0-9a-f]{0,2}:/.test(h)) return true;
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
    if (mapped) return isAlwaysBlockedBrowserHost(mapped[1]);
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16);
      const lo = parseInt(mappedHex[2], 16);
      return isAlwaysBlockedBrowserHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
  }
  return false;
}

// ── User blocklist (`browser_blocked_urls` in user-overrides.json + env) ──────────────

interface BlockEntry {
  raw: string;
  host: string;
  /** `*.example.com` or plain host: both match the host and its subdomains. */
  port: string | null;
  pathPrefix: string;
}

let blocklistFile: string | null = null;
let blocklistCache: { key: string; entries: BlockEntry[] } | null = null;

/** Point the guard at user-overrides.json (`browser_blocked_urls: string[]`). Called once at API start. */
export function configureBrowserUrlBlocklistFile(filePath: string | null): void {
  blocklistFile = filePath;
  blocklistCache = null;
}

export function parseBrowserBlockEntry(raw: string): BlockEntry | null {
  let s = String(raw ?? '').trim().toLowerCase();
  if (!s || s.startsWith('#')) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  const slash = s.indexOf('/');
  const authority = slash >= 0 ? s.slice(0, slash) : s;
  let pathPrefix = slash >= 0 ? s.slice(slash) : '';
  pathPrefix = pathPrefix.replace(/\*+$/, '');
  if (pathPrefix === '/') pathPrefix = '';
  const hostPort = authority.replace(/^[^@]*@/, '');
  const m = /^(\*\.)?(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(hostPort);
  if (!m || !m[2]) return null;
  return { raw: String(raw).trim(), host: m[2].replace(/^\[|\]$/g, ''), port: m[3] ?? null, pathPrefix };
}

function envBlocklist(): string[] {
  return (process.env.MY_AGENT_BROWSER_BLOCKED_URLS ?? '')
    .split(/[,\n;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function fileBlocklist(): string[] {
  if (!blocklistFile) return [];
  try {
    const doc = JSON.parse(readFileSync(blocklistFile, 'utf8')) as { browser_blocked_urls?: unknown };
    return Array.isArray(doc.browser_blocked_urls)
      ? doc.browser_blocked_urls.filter((v): v is string => typeof v === 'string')
      : [];
  } catch {
    return [];
  }
}

function configuredBlocklist(): BlockEntry[] {
  let stamp = 'none';
  if (blocklistFile) {
    try {
      const st = statSync(blocklistFile);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      stamp = 'missing';
    }
  }
  const key = `${blocklistFile ?? ''}|${stamp}|${process.env.MY_AGENT_BROWSER_BLOCKED_URLS ?? ''}`;
  if (blocklistCache?.key === key) return blocklistCache.entries;
  const entries = [...fileBlocklist(), ...envBlocklist()]
    .map(parseBrowserBlockEntry)
    .filter((e): e is BlockEntry => e !== null);
  blocklistCache = { key, entries };
  return entries;
}

function effectivePort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '';
}

function matchBlockEntry(url: URL, entry: BlockEntry): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host !== entry.host && !host.endsWith(`.${entry.host}`)) return false;
  if (entry.port && entry.port !== effectivePort(url)) return false;
  if (entry.pathPrefix && !decodeURIComponentSafe(url.pathname).toLowerCase().startsWith(entry.pathPrefix)) return false;
  return true;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function userBlockedEntry(url: URL, extra?: string[]): BlockEntry | null {
  const entries = [
    ...configuredBlocklist(),
    ...(extra ?? []).map(parseBrowserBlockEntry).filter((e): e is BlockEntry => e !== null),
  ];
  return entries.find((e) => matchBlockEntry(url, e)) ?? null;
}

function hostBlockReason(hostname: string, opts: UrlGuardOptions): string | null {
  if (isAlwaysBlockedBrowserHost(hostname)) {
    return `BLOCKED_HOST: ${hostname} (link-local/unspecified/multicast) is never allowed.`;
  }
  if (!opts.allowLocalhost && isBlockedNetworkHost(hostname)) {
    return `BLOCKED_HOST: ${hostname} is a local/private address. Enable playwright_allow_localhost in user settings for local dev.`;
  }
  return null;
}

/** Non-throwing check used for redirects, sub-requests and post-navigation URLs. */
export function browserUrlBlockReason(rawUrl: string, opts: UrlGuardOptions = {}): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return `INVALID_URL: ${rawUrl}`;
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    return `BLOCKED_PROTOCOL: only http/https allowed (got ${protocol})`;
  }
  const hostReason = hostBlockReason(parsed.hostname, opts);
  if (hostReason) return hostReason;
  const entry = userBlockedEntry(parsed, opts.blockedUrls);
  if (entry) {
    return `BLOCKED_BY_USER_POLICY: ${parsed.host}${parsed.pathname} matches browser_blocked_urls entry "${entry.raw}". Do not retry or work around it; tell the user.`;
  }
  return null;
}

/**
 * The visible browser can reach a blocked page through a click/redirect the core cannot
 * pre-check. Returns an app-authored ERROR (content withheld) when a shell result's
 * `url` / `page_url` is blocked, else null.
 */
export function visibleBlockedOutput(result: unknown, allowLocalhost: boolean): string | null {
  const rec = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
  const url = typeof rec.url === 'string' ? rec.url : typeof rec.page_url === 'string' ? rec.page_url : '';
  if (!/^https?:/i.test(url)) return null;
  const reason = browserUrlBlockReason(url, { allowLocalhost });
  if (!reason) return null;
  return `ERROR: BLOCKED_PAGE — the visible browser is on a blocked URL (${url.slice(0, 200)}). ${reason} Page content was withheld. Do not interact with this page; tell the user.`;
}

export function assertAllowedBrowserUrl(rawUrl: string, opts: UrlGuardOptions = {}): URL {
  const reason = browserUrlBlockReason(rawUrl, opts);
  if (reason) throw new Error(reason);
  return new URL(rawUrl);
}

/**
 * Literal checks cannot see hostnames that resolve to private space (e.g. `127.0.0.1.nip.io`).
 * Resolve once before a top-level navigation / download. Lookup failures are left to the
 * browser/fetch to report. (DNS rebinding after this check is out of scope.)
 */
export async function assertBrowserUrlResolvesAllowed(
  rawUrl: string,
  opts: UrlGuardOptions = {},
  resolver: (host: string) => Promise<Array<{ address: string }>> = (host) => lookup(host, { all: true }),
): Promise<void> {
  const parsed = assertAllowedBrowserUrl(rawUrl, opts);
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')) return;
  let addresses: Array<{ address: string }>;
  try {
    addresses = await resolver(host);
  } catch {
    return;
  }
  for (const { address } of addresses) {
    const reason = hostBlockReason(address, opts);
    if (reason) throw new Error(`${reason} (${parsed.hostname} resolves to ${address})`);
  }
}
