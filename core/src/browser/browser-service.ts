import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isPlaywrightAvailable } from './playwright-probe.js';
import { PlaywrightSession } from './playwright-session.js';

export interface BrowserServiceOptions {
  cqrRoot: string;
  headless?: boolean;
  allowLocalhost?: boolean;
}

export interface BrowserScreenshotResult {
  ok: boolean;
  url?: string;
  path?: string;
  title?: string;
  page_url?: string;
  error?: string;
}

export interface BrowserNavigateResult {
  ok: boolean;
  title?: string;
  url?: string;
  excerpt?: string;
  error?: string;
}

export interface BrowserFetchPageResult {
  ok: boolean;
  url?: string;
  title?: string;
  text?: string;
  error?: string;
}

function browserOutputDir(cqrRoot: string, sessionId?: string): string {
  const sid = sessionId?.trim() || randomUUID().slice(0, 8);
  const dir = path.join(cqrRoot, 'data', 'outputs', 'browser', sid);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Docs/example hosts — never navigate or run tests against these. */
export function isPlaceholderNavUrl(url: string): boolean {
  const raw = String(url || '').trim();
  if (!raw) return true;
  const lower = raw.toLowerCase();
  if (
    /대상\s*-?\s*주소|your[-_.]?domain|changeme|placeholder|example\.com|example\.org|example\.net|test\.local|invalid/i.test(
      lower,
    )
  ) {
    return true;
  }
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
    const host = u.hostname.toLowerCase();
    if (
      host === 'example.com'
      || host === 'example.org'
      || host === 'example.net'
      || host === 'localhost.example'
      || host === 'invalid'
      || host === 'test'
    ) {
      return true;
    }
    if (/대상|placeholder|changeme|yourdomain/i.test(host)) return true;
  } catch {
    /* fall through */
  }
  return false;
}

export function extractUrlFromText(text: string): string | null {
  const re = /https?:\/\/[^\s<>"')\]]+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const url = m[0].replace(/[.,;:!?)]+$/, '');
    if (!isPlaceholderNavUrl(url)) return url;
  }
  return null;
}

/** True when the text contains a non-placeholder http(s) URL. */
export function messageHasActionableHttpUrl(text: string): boolean {
  return extractUrlFromText(text) != null;
}

export async function browserScreenshot(
  url: string,
  opts: BrowserServiceOptions & { sessionId?: string; filename?: string },
): Promise<BrowserScreenshotResult> {
  if (!isPlaywrightAvailable(opts.cqrRoot)) {
    return { ok: false, error: 'Playwright not installed — run tools/bootstrap-playwright.ps1' };
  }
  let session: PlaywrightSession | null = null;
  try {
    session = await PlaywrightSession.open({
      cqrRoot: opts.cqrRoot,
      headless: opts.headless !== false,
      urlGuard: { allowLocalhost: opts.allowLocalhost === true },
    });
    const nav = await session.navigate(url);
    const outDir = browserOutputDir(opts.cqrRoot, opts.sessionId);
    const folder = path.basename(outDir);
    const name = opts.filename?.trim() || `screenshot-${Date.now()}.png`;
    const rel = `data/outputs/browser/${folder}/${path.basename(name)}`;
    const shot = await session.screenshot(opts.cqrRoot, rel, opts.sessionId, {});
    const relUrl = `/outputs/browser/${folder}/${path.basename(shot.path)}`;
    return {
      ok: true,
      url: relUrl,
      path: shot.path,
      title: nav.title,
      page_url: nav.url,
    };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await session?.close();
  }
}

export async function browserNavigate(
  url: string,
  opts: BrowserServiceOptions,
): Promise<BrowserNavigateResult> {
  if (!isPlaywrightAvailable(opts.cqrRoot)) {
    return { ok: false, error: 'Playwright not installed — run tools/bootstrap-playwright.ps1' };
  }
  let session: PlaywrightSession | null = null;
  try {
    session = await PlaywrightSession.open({
      cqrRoot: opts.cqrRoot,
      headless: opts.headless !== false,
      urlGuard: { allowLocalhost: opts.allowLocalhost === true },
    });
    const nav = await session.navigate(url);
    return { ok: true, title: nav.title, url: nav.url, excerpt: nav.excerpt };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await session?.close();
  }
}

/** JS-heavy page text extraction for market-research pipeline fallback. */
export async function browserFetchPageText(
  url: string,
  opts: BrowserServiceOptions,
): Promise<BrowserFetchPageResult> {
  if (!isPlaywrightAvailable(opts.cqrRoot)) {
    return { ok: false, error: 'PLAYWRIGHT_UNAVAILABLE' };
  }
  let session: PlaywrightSession | null = null;
  try {
    session = await PlaywrightSession.open({
      cqrRoot: opts.cqrRoot,
      headless: opts.headless !== false,
      urlGuard: { allowLocalhost: opts.allowLocalhost === true },
    });
    const nav = await session.navigate(url);
    return { ok: true, url: nav.url, title: nav.title, text: nav.excerpt };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await session?.close();
  }
}

export function writeBrowserFetchCache(
  cqrRoot: string,
  url: string,
  result: BrowserFetchPageResult,
): string {
  const cacheDir = path.join(cqrRoot, 'data', 'outputs', 'browser', 'fetch-cache');
  mkdirSync(cacheDir, { recursive: true });
  const safe = Buffer.from(url).toString('base64url').slice(0, 48);
  const file = path.join(cacheDir, `${safe}.json`);
  writeFileSync(file, JSON.stringify({ url, ...result, at: new Date().toISOString() }, null, 2), 'utf8');
  return file;
}
