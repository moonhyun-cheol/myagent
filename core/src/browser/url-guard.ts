import { URL } from 'node:url';

export interface UrlGuardOptions {
  allowLocalhost?: boolean;
}

const PRIVATE_IPV4 =
  /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;

function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h.endsWith('.localhost');
}

function isPrivateIpv4(hostname: string): boolean {
  return PRIVATE_IPV4.test(hostname);
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

export function assertAllowedBrowserUrl(rawUrl: string, opts: UrlGuardOptions = {}): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`INVALID_URL: ${rawUrl}`);
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error(`BLOCKED_PROTOCOL: only http/https allowed (got ${protocol})`);
  }

  if (!opts.allowLocalhost) {
    if (isLocalHost(parsed.hostname) || isPrivateIpv4(parsed.hostname)) {
      throw new Error(
        `BLOCKED_HOST: ${parsed.hostname} is not allowed. Enable playwright_allow_localhost in user settings for local dev.`,
      );
    }
  }

  return parsed;
}
