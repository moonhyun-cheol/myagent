import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { importPlaywright, isPlaywrightAvailable } from '../browser/playwright-probe.js';
import { assertAllowedBrowserUrl } from '../browser/url-guard.js';
import { formatToolSelfCorrection } from '../agent/tool-self-correction.js';

const DEFAULT_MAX_PAGES = 12;
const EXCERPT_MAX = 1200;

export interface CrawlPageResult {
  url: string;
  title: string;
  excerpt: string;
}

export interface WebCrawlResult {
  ok: boolean;
  pages: CrawlPageResult[];
  markdown?: string;
  reportPath?: string;
  error?: string;
  engine: 'playwright';
}

type PwPage = {
  goto(url: string, opts: { waitUntil: string; timeout: number }): Promise<unknown>;
  title(): Promise<string>;
  url(): string;
  evaluate(fn: () => unknown): Promise<unknown>;
  close(): Promise<void>;
};

type PwBrowser = {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
};

function normalizeLink(base: URL, href: string): string | null {
  try {
    const u = new URL(href, base);
    if (!/^https?:$/i.test(u.protocol)) return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
}

async function crawlWithPlaywright(opts: {
  cqrRoot: string;
  startUrl: string;
  maxPages: number;
  allowLocalhost: boolean;
}): Promise<CrawlPageResult[]> {
  const start = assertAllowedBrowserUrl(opts.startUrl, { allowLocalhost: opts.allowLocalhost });
  const pw = await importPlaywright(opts.cqrRoot);
  const browser = (await pw.chromium.launch({ headless: true })) as PwBrowser;
  const pages: CrawlPageResult[] = [];
  const seen = new Set<string>();
  const queue: string[] = [start.toString()];

  try {
    while (queue.length > 0 && pages.length < opts.maxPages) {
      const url = queue.shift()!;
      if (seen.has(url)) continue;
      seen.add(url);

      const page = await browser.newPage();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
        const title = await page.title();
        const bodyText = String(
          await page.evaluate(() => document.body?.innerText ?? ''),
        );
        const excerpt =
          bodyText.length > EXCERPT_MAX
            ? `${bodyText.slice(0, EXCERPT_MAX)}\n…`
            : bodyText;
        pages.push({ url: page.url(), title, excerpt });

        const links = (await page.evaluate(() => {
          return Array.from(document.querySelectorAll('a[href]'))
            .map((a) => (a as HTMLAnchorElement).href)
            .filter(Boolean);
        })) as string[];

        for (const href of links) {
          const abs = normalizeLink(new URL(url), href);
          if (!abs || seen.has(abs) || queue.includes(abs)) continue;
          if (!sameHost(start.toString(), abs)) continue;
          queue.push(abs);
        }
      } catch {
        /* skip broken page */
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }

  return pages;
}

function toMarkdown(pages: CrawlPageResult[], startUrl: string): string {
  const lines = [`# Web crawl: ${startUrl}`, '', `Pages: ${pages.length}`, ''];
  for (const p of pages) {
    lines.push(`## ${p.title || p.url}`, '', `URL: ${p.url}`, '', p.excerpt, '', '---', '');
  }
  return lines.join('\n');
}

export async function runWebCrawl(opts: {
  cqrRoot: string;
  sessionId: string;
  startUrl: string;
  maxPages?: number;
  allowLocalhost?: boolean;
}): Promise<WebCrawlResult> {
  const maxPages = Math.min(30, Math.max(1, opts.maxPages ?? DEFAULT_MAX_PAGES));

  let pages: CrawlPageResult[] = [];

  if (isPlaywrightAvailable(opts.cqrRoot)) {
    try {
      pages = await crawlWithPlaywright({
        cqrRoot: opts.cqrRoot,
        startUrl: opts.startUrl,
        maxPages,
        allowLocalhost: opts.allowLocalhost === true,
      });
    } catch (e: unknown) {
      const detail = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        pages: [],
        error: formatToolSelfCorrection('web_crawl', detail, ['retry', 'smaller maxPages']),
        engine: 'playwright',
      };
    }
  } else {
    return {
      ok: false,
      pages: [],
      error: 'Playwright가 필요합니다. tools\\bootstrap-playwright.ps1 실행 후 다시 시도하세요.',
      engine: 'playwright',
    };
  }

  if (!pages.length) {
    return { ok: false, pages: [], error: '크롤링한 페이지가 없습니다.', engine: 'playwright' };
  }

  const markdown = toMarkdown(pages, opts.startUrl);
  const outDir = path.join(opts.cqrRoot, 'data', 'outputs', 'crawl', opts.sessionId);
  mkdirSync(outDir, { recursive: true });
  const stamp = Date.now();
  const reportRel = `data/outputs/crawl/${opts.sessionId}/crawl-${stamp}.md`;
  const reportAbs = path.join(opts.cqrRoot, reportRel);
  writeFileSync(reportAbs, markdown, 'utf8');

  return {
    ok: true,
    pages,
    markdown,
    reportPath: `/outputs/crawl/${opts.sessionId}/crawl-${stamp}.md`,
    engine: 'playwright',
  };
}
