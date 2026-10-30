import type { IncomingMessage } from 'node:http';

/**
 * Local API request guard (browser-originated abuse only).
 *
 * The API listens on 127.0.0.1 without authentication. Browsers are the remaining remote
 * path into it: a foreign page can fire simple `text/plain` POSTs (CSRF) or rebind its own
 * DNS name to 127.0.0.1. This guard rejects those before dispatch:
 *  - Host must be a loopback name (DNS rebinding keeps the attacker's hostname in Host).
 *  - State-changing methods with an Origin header must come from the app's own origin
 *    (or the Vite dev server). `Origin: null` (sandboxed/form posts) is rejected.
 *  - `Sec-Fetch-Site: cross-site` subresource requests are rejected for every method.
 *
 * Requests without Origin/Sec-Fetch headers (the WPF shell's HttpClient, local scripts)
 * are allowed: other local processes are outside this guard's scope.
 */

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Vite dev server (ui/workspace/vite.config.ts) proxies the API from this port. */
const DEV_UI_PORTS = ['5174'];

export type LocalApiGuardVerdict =
  | { ok: true }
  | { ok: false; reason: 'host_not_loopback' | 'origin_not_allowed' | 'cross_site_request'; detail: string };

function headerValue(req: Pick<IncomingMessage, 'headers'>, name: string): string | undefined {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw[0];
  return typeof raw === 'string' ? raw : undefined;
}

function hostnameOf(hostHeader: string): string {
  const value = hostHeader.trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 0 ? value.slice(0, end + 1) : value;
  }
  const colon = value.lastIndexOf(':');
  return colon >= 0 ? value.slice(0, colon) : value;
}

export function allowedLocalApiOrigins(port: number, env: NodeJS.ProcessEnv = process.env): Set<string> {
  const origins = new Set<string>();
  for (const p of [String(port), ...DEV_UI_PORTS]) {
    origins.add(`http://127.0.0.1:${p}`);
    origins.add(`http://localhost:${p}`);
  }
  for (const extra of String(env.MY_AGENT_ALLOWED_ORIGINS ?? '').split(',')) {
    const value = extra.trim().replace(/\/+$/, '').toLowerCase();
    if (/^https?:\/\/[^/\s]+$/.test(value)) origins.add(value);
  }
  return origins;
}

export function checkLocalApiRequest(
  req: Pick<IncomingMessage, 'headers' | 'method'>,
  port: number,
  env: NodeJS.ProcessEnv = process.env,
): LocalApiGuardVerdict {
  if (env.MY_AGENT_LOCAL_API_GUARD === '0') return { ok: true };

  const host = headerValue(req, 'host');
  // HTTP/1.1 clients always send Host; an absent one is not a browser.
  if (host && !LOOPBACK_HOSTNAMES.has(hostnameOf(host))) {
    return { ok: false, reason: 'host_not_loopback', detail: host.slice(0, 120) };
  }

  const method = String(req.method ?? 'GET').toUpperCase();
  const origin = headerValue(req, 'origin');
  if (origin !== undefined && !SAFE_METHODS.has(method)) {
    const normalized = origin.trim().replace(/\/+$/, '').toLowerCase();
    if (!allowedLocalApiOrigins(port, env).has(normalized)) {
      return { ok: false, reason: 'origin_not_allowed', detail: origin.slice(0, 120) };
    }
  }

  const fetchSite = headerValue(req, 'sec-fetch-site')?.toLowerCase();
  const fetchMode = headerValue(req, 'sec-fetch-mode')?.toLowerCase();
  // Top-level navigations (a user opening an /outputs link) stay allowed; embedded or
  // scripted cross-site requests do not.
  if (fetchSite === 'cross-site' && fetchMode !== 'navigate') {
    return { ok: false, reason: 'cross_site_request', detail: `${method} ${fetchMode ?? ''}`.trim() };
  }
  if (fetchSite === 'cross-site' && !SAFE_METHODS.has(method)) {
    return { ok: false, reason: 'cross_site_request', detail: `${method} navigate` };
  }
  return { ok: true };
}
