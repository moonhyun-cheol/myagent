/**
 * Download a remote http(s) file into data/outputs/web/<sessionId>/.
 * Session-temp GC owns this folder — not the user workspace.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertWritablePath } from '../security/path-guard.js';
import { assertAllowedBrowserUrl } from '../browser/url-guard.js';

export const WEB_ASSET_MAX_BYTES = 20 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

export interface SaveWebAssetResult {
  ok: boolean;
  path?: string;
  url?: string;
  bytes?: number;
  contentType?: string;
  error?: string;
}

function safeFilename(raw: string): string {
  const base = path.basename(raw.replace(/\\/g, '/')).replace(/[^a-zA-Z0-9._-]/g, '_');
  const trimmed = base.replace(/^\.+/, '') || 'download';
  return trimmed.slice(0, 120);
}

function filenameFromUrl(href: string, contentType: string | null): string {
  try {
    const u = new URL(href);
    const fromPath = path.posix.basename(u.pathname);
    if (fromPath && fromPath !== '/' && fromPath.includes('.')) return safeFilename(fromPath);
  } catch {
    /* ignore */
  }
  const ext =
    contentType?.includes('png')
      ? '.png'
      : contentType?.includes('jpeg') || contentType?.includes('jpg')
        ? '.jpg'
        : contentType?.includes('webp')
          ? '.webp'
          : contentType?.includes('gif')
            ? '.gif'
            : contentType?.includes('pdf')
              ? '.pdf'
              : contentType?.includes('json')
                ? '.json'
                : contentType?.startsWith('text/')
                  ? '.txt'
                  : '.bin';
  return `download-${Date.now()}${ext}`;
}

export async function saveWebAsset(opts: {
  cqrRoot: string;
  sessionId: string;
  sourceUrl: string;
  filename?: string;
  allowLocalhost?: boolean;
}): Promise<SaveWebAssetResult> {
  const sid = opts.sessionId.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (!sid) return { ok: false, error: 'sessionId required' };

  let parsed: URL;
  try {
    parsed = assertAllowedBrowserUrl(opts.sourceUrl, { allowLocalhost: opts.allowLocalhost === true });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  let res: Response;
  try {
    res = await fetch(parsed.href, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
      headers: { 'User-Agent': 'CQR-PA/session-temp' },
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > WEB_ASSET_MAX_BYTES) {
    return { ok: false, error: `FILE_TOO_LARGE: max ${WEB_ASSET_MAX_BYTES} bytes` };
  }
  if (!buf.length) return { ok: false, error: 'empty body' };

  const contentType = res.headers.get('content-type');
  const name = opts.filename?.trim()
    ? safeFilename(opts.filename)
    : filenameFromUrl(parsed.href, contentType);
  const dir = path.join(opts.cqrRoot, 'data', 'outputs', 'web', sid);
  mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, name);
  assertWritablePath(abs, opts.cqrRoot);
  writeFileSync(abs, buf);
  return {
    ok: true,
    path: abs,
    url: `/outputs/web/${sid}/${name}`,
    bytes: buf.length,
    contentType: contentType ?? undefined,
  };
}
