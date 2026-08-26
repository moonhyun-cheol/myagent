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
