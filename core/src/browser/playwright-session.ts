import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { assertPathUnder } from '../security/path-guard.js';
import { resolveDevWorkspaceRelPath } from '../security/dev-workspace-guard.js';
import type { WorkspaceGuardOptions } from '../security/dev-workspace-guard.js';
import { importPlaywright } from './playwright-probe.js';
import { assertAllowedBrowserUrl, type UrlGuardOptions } from './url-guard.js';
import { ensurePlaywrightGitignore } from '../sessions/workspace-scratch-gitignore.js';

const NAVIGATION_TIMEOUT_MS = 20_000;
const ACTION_TIMEOUT_MS = 30_000;
const BODY_EXCERPT_MAX = 4000;

type PwPage = {
  goto(url: string, opts: { waitUntil: string; timeout: number }): Promise<unknown>;
  title(): Promise<string>;
  url(): string;
  evaluate(fn: () => unknown): Promise<unknown>;
  evaluate<T>(fn: (arg: T) => unknown, arg: T): Promise<unknown>;
  screenshot(opts: { path: string; fullPage: boolean; timeout: number }): Promise<unknown>;
  click(selector: string, opts: { timeout: number }): Promise<void>;
  fill(selector: string, value: string, opts: { timeout: number }): Promise<void>;
  close(): Promise<void>;
  setDefaultTimeout(ms: number): void;
  setDefaultNavigationTimeout(ms: number): void;
};

type PwBrowser = {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
};

export interface PlaywrightSessionOptions {
  cqrRoot: string;
  headless?: boolean;
  urlGuard?: UrlGuardOptions;
}

export class PlaywrightSession {
  private browser: PwBrowser | null = null;
  private page: PwPage | null = null;
  private readonly headless: boolean;
  private readonly urlGuard: UrlGuardOptions;

  constructor(
    private readonly cqrRoot: string,
    opts?: Pick<PlaywrightSessionOptions, 'headless' | 'urlGuard'>,
  ) {
    this.headless = opts?.headless !== false;
    this.urlGuard = opts?.urlGuard ?? {};
  }

  static async open(opts: PlaywrightSessionOptions): Promise<PlaywrightSession> {
    const session = new PlaywrightSession(opts.cqrRoot, opts);
    await session.ensureBrowser();
    return session;
  }

  private async ensureBrowser(): Promise<PwPage> {
    if (this.page) return this.page;
    const pw = await importPlaywright(this.cqrRoot);
    this.browser = (await pw.chromium.launch({ headless: this.headless })) as PwBrowser;
    this.page = await this.browser.newPage();
    this.page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    this.page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    return this.page;
  }

  async close(): Promise<void> {
    try {
      await this.page?.close();
    } catch {
      /* ignore */
    }
    try {
      await this.browser?.close();
    } catch {
      /* ignore */
    }
    this.page = null;
    this.browser = null;
  }

  async navigate(url: string): Promise<{ title: string; url: string; excerpt: string }> {
    const parsed = assertAllowedBrowserUrl(url, this.urlGuard);
    const page = await this.ensureBrowser();
    await page.goto(parsed.toString(), { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    const title = await page.title();
    const bodyText = String(
      await page.evaluate(() => {
        return document.body?.innerText ?? '';
      }),
    );
    const excerpt =
      bodyText.length > BODY_EXCERPT_MAX
        ? `${bodyText.slice(0, BODY_EXCERPT_MAX)}\n… (${bodyText.length} chars total)`
        : bodyText;
    return { title, url: page.url(), excerpt };
  }

  async screenshot(
    workspaceRoot: string,
    relPath: string | undefined,
    sessionId: string | undefined,
    guard: WorkspaceGuardOptions,
  ): Promise<{ path: string; relative: string; url?: string }> {
    const page = await this.ensureBrowser();
    const targetRel = relPath?.trim() || defaultScreenshotRel(sessionId);
    const abs = resolveScreenshotPath(workspaceRoot, targetRel, sessionId, this.cqrRoot, guard);
    mkdirSync(path.dirname(abs), { recursive: true });
    await page.screenshot({ path: abs, fullPage: true, timeout: ACTION_TIMEOUT_MS });
    const posixAbs = abs.replace(/\\/g, '/');
    if (posixAbs.includes('/.playwright/') || posixAbs.endsWith('/.playwright')) {
      ensurePlaywrightGitignore(workspaceRoot);
    }
    const publicUrl = publicOutputUrl(abs, this.cqrRoot);
    const relative = publicUrl
      ? publicUrl.replace(/^\//, '')
      : path.relative(workspaceRoot, abs).split(path.sep).join('/');
    return { path: abs, relative, url: publicUrl };
  }

  async click(selector: string): Promise<string> {
    const page = await this.ensureBrowser();
    await page.click(selector, { timeout: ACTION_TIMEOUT_MS });
    return `Clicked selector: ${selector}`;
  }

  async fill(selector: string, value: string): Promise<string> {
    const page = await this.ensureBrowser();
    await page.fill(selector, value, { timeout: ACTION_TIMEOUT_MS });
    return `Filled selector: ${selector}`;
  }

  async evaluate(expression: string): Promise<string> {
    const page = await this.ensureBrowser();
    const result = await page.evaluate(async ({ expr }) => {
      // eslint-disable-next-line no-eval
      const v = eval(expr);
      return v instanceof Promise ? await v : v;
    }, { expr: expression });
    if (typeof result === 'string') return result;
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }
}

function publicOutputUrl(abs: string, cqrRoot: string): string | undefined {
  const rel = path.relative(cqrRoot, abs).split(path.sep).join('/');
  const m = rel.match(/^data\/outputs\/(images|research|browser|crawl|web)\/(.+)$/);
  return m ? `/outputs/${m[1]}/${m[2]}` : undefined;
}

function defaultScreenshotRel(sessionId?: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const sid = (sessionId?.trim() || 'session').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'session';
  return path.posix.join('data', 'outputs', 'browser', sid, `screenshot-${stamp}.png`);
}

function resolveScreenshotPath(
  workspaceRoot: string,
  relPath: string,
  sessionId: string | undefined,
  cqrRoot: string,
  guard: WorkspaceGuardOptions,
): string {
  const normalized = relPath.replace(/\\/g, '/');
  if (normalized.startsWith('.playwright/') || normalized === '.playwright') {
    return resolveDevWorkspaceRelPath(workspaceRoot, normalized, guard);
  }
  if (normalized.startsWith('data/outputs/browser/') || normalized.startsWith('data/outputs/web/')) {
    const abs = path.join(cqrRoot, ...normalized.split('/'));
    assertPathUnder(cqrRoot, abs);
    return abs;
  }
  if (normalized.includes('.playwright')) {
    return resolveDevWorkspaceRelPath(workspaceRoot, normalized, guard);
  }
  const sid = (sessionId?.trim() || 'session').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'session';
  const abs = path.join(cqrRoot, 'data', 'outputs', 'browser', sid, path.posix.basename(normalized));
  assertPathUnder(cqrRoot, abs);
  return abs;
}
