import { existsSync, mkdirSync } from 'node:fs';
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
const TIER1_TEXT_MAX = 12_000;
const SNAPSHOT_NODE_MAX = 160;
const DIAGNOSTIC_ENTRY_MAX = 100;
const DIAGNOSTIC_TEXT_MAX = 1_000;
const WAIT_TIMEOUT_MAX_MS = 30_000;

export type BrowserScrollDirection = 'up' | 'down' | 'to-element' | 'to-text';
export type BrowserWaitState = 'attached' | 'visible' | 'hidden' | 'detached';

export interface BrowserDiagnosticEntry {
  kind: 'console' | 'http' | 'network';
  level: string;
  text: string;
  url?: string;
  at: string;
}

export interface BrowserFindResult {
  found: boolean;
  text: string;
  selector?: string;
  excerpt?: string;
}

export interface BrowserSnapshotResult {
  snapshot_id: string;
  url: string;
  title: string;
  tree: string;
  ref_count: number;
}

/** Thrown when an in-flight browser action is interrupted by the stop button / parent abort. */
export class BrowserAbortError extends Error {
  readonly code = 'BROWSER_ABORTED';
  constructor(message = 'Browser action aborted by user stop') {
    super(message);
    this.name = 'BrowserAbortError';
  }
}

type PwDownload = {
  suggestedFilename(): string;
  saveAs(path: string): Promise<void>;
  failure(): Promise<string | null>;
};

type PwPage = {
  goto(url: string, opts: { waitUntil: string; timeout: number }): Promise<unknown>;
  title(): Promise<string>;
  url(): string;
  evaluate(fn: () => unknown): Promise<unknown>;
  evaluate<T>(fn: (arg: T) => unknown, arg: T): Promise<unknown>;
  screenshot(opts: { path: string; fullPage: boolean; timeout: number }): Promise<unknown>;
  click(selector: string, opts: { timeout: number }): Promise<void>;
  fill(selector: string, value: string, opts: { timeout: number }): Promise<void>;
  selectOption(selector: string, value: string, opts: { timeout: number }): Promise<string[]>;
  press(selector: string, key: string, opts: { timeout: number }): Promise<void>;
  keyboard: { press(key: string): Promise<void> };
  setInputFiles(selector: string, files: string | string[], opts: { timeout: number }): Promise<void>;
  waitForSelector(selector: string, opts: { state: BrowserWaitState; timeout: number }): Promise<unknown>;
  waitForURL(url: string | RegExp, opts: { timeout: number; waitUntil: string }): Promise<void>;
  waitForEvent(event: 'download', opts: { timeout: number }): Promise<PwDownload>;
  goBack(opts: { waitUntil: string; timeout: number }): Promise<unknown>;
  goForward(opts: { waitUntil: string; timeout: number }): Promise<unknown>;
  reload(opts: { waitUntil: string; timeout: number }): Promise<unknown>;
  on(event: string, listener: (...args: any[]) => void): void;
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
  /** Parent/stop-button signal; when it aborts, in-flight actions reject and the session closes. */
  signal?: AbortSignal;
}

export class PlaywrightSession {
  private browser: PwBrowser | null = null;
  private page: PwPage | null = null;
  private snapshotSequence = 0;
  private snapshotRefs = new Map<string, string>();
  private activeSnapshotId = '';
  private readonly diagnostics: BrowserDiagnosticEntry[] = [];
  private readonly headless: boolean;
  private readonly urlGuard: UrlGuardOptions;
  private readonly signal?: AbortSignal;

  constructor(
    private readonly cqrRoot: string,
    opts?: Pick<PlaywrightSessionOptions, 'headless' | 'urlGuard' | 'signal'>,
  ) {
    this.headless = opts?.headless !== false;
    this.urlGuard = opts?.urlGuard ?? {};
    this.signal = opts?.signal;
  }

  /**
   * Race a playwright operation against the abort signal. On abort we close the
   * session, which forces the pending playwright promise to reject ("Target closed"),
   * and we surface a BrowserAbortError immediately instead of waiting for the
   * 20s/30s playwright timeout.
   */
  private raceAbort<T>(op: Promise<T>): Promise<T> {
    const signal = this.signal;
    if (!signal) return op;
    if (signal.aborted) {
      void this.close();
      // Swallow the eventual rejection of the abandoned op so it is not unhandled.
      void op.catch(() => {});
      return Promise.reject(new BrowserAbortError());
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        void this.close();
        reject(new BrowserAbortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      op.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
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
    this.attachDiagnostics(this.page);
    return this.page;
  }

  private pushDiagnostic(entry: Omit<BrowserDiagnosticEntry, 'at'>): void {
    this.diagnostics.push({
      ...entry,
      text: entry.text.slice(0, DIAGNOSTIC_TEXT_MAX),
      url: entry.url?.slice(0, DIAGNOSTIC_TEXT_MAX),
      at: new Date().toISOString(),
    });
    if (this.diagnostics.length > DIAGNOSTIC_ENTRY_MAX) {
      this.diagnostics.splice(0, this.diagnostics.length - DIAGNOSTIC_ENTRY_MAX);
    }
  }

  private attachDiagnostics(page: PwPage): void {
    page.on('console', (message: { type(): string; text(): string }) => {
      const level = message.type();
      if (level === 'error' || level === 'warning') {
        this.pushDiagnostic({ kind: 'console', level, text: message.text() });
      }
    });
    page.on('response', (response: { status(): number; url(): string }) => {
      const status = response.status();
      if (status >= 400) {
        this.pushDiagnostic({ kind: 'http', level: String(status), text: `HTTP ${status}`, url: response.url() });
      }
    });
    page.on('requestfailed', (request: { url(): string; failure(): { errorText?: string } | null }) => {
      this.pushDiagnostic({
        kind: 'network',
        level: 'failed',
        text: request.failure()?.errorText ?? 'Request failed',
        url: request.url(),
      });
    });
  }

  private invalidateSnapshot(): void {
    this.snapshotRefs.clear();
    this.activeSnapshotId = '';
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
    this.invalidateSnapshot();
  }

  async navigate(url: string): Promise<{ title: string; url: string; excerpt: string }> {
    this.invalidateSnapshot();
    const parsed = assertAllowedBrowserUrl(url, this.urlGuard);
    const page = await this.ensureBrowser();
    return this.raceAbort(
      (async () => {
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
      })(),
    );
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
    await this.raceAbort(page.screenshot({ path: abs, fullPage: true, timeout: ACTION_TIMEOUT_MS }));
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
    await this.raceAbort(page.click(selector, { timeout: ACTION_TIMEOUT_MS }));
    this.invalidateSnapshot();
    return `Clicked selector: ${selector}`;
  }

  async clickRef(ref: string, snapshotId?: string): Promise<string> {
    const normalized = ref.trim();
    if (!normalized) throw new Error('BROWSER_REF_REQUIRED');
    if (snapshotId && snapshotId !== this.activeSnapshotId) throw new Error('BROWSER_SNAPSHOT_STALE');
    const selector = this.snapshotRefs.get(normalized);
    if (!selector) throw new Error('BROWSER_REF_NOT_FOUND');
    return this.click(selector);
  }

  async fill(selector: string, value: string): Promise<string> {
    const page = await this.ensureBrowser();
    await this.raceAbort(page.fill(selector, value, { timeout: ACTION_TIMEOUT_MS }));
    this.invalidateSnapshot();
    return `Filled selector: ${selector}`;
  }

  async waitFor(opts: {
    selector?: string;
    url?: string;
    state?: BrowserWaitState;
    timeoutMs?: number;
  }): Promise<string> {
    const page = await this.ensureBrowser();
    const timeout = Math.max(100, Math.min(WAIT_TIMEOUT_MAX_MS, opts.timeoutMs ?? ACTION_TIMEOUT_MS));
    if (opts.selector?.trim()) {
      const selector = opts.selector.trim();
      await this.raceAbort(page.waitForSelector(selector, { state: opts.state ?? 'visible', timeout }));
      return `Waited for selector: ${selector}`;
    }
    if (opts.url?.trim()) {
      const url = opts.url.trim();
      await this.raceAbort(page.waitForURL(url, { timeout, waitUntil: 'domcontentloaded' }));
      return `Waited for URL: ${url}`;
    }
    throw new Error('BROWSER_WAIT_TARGET_REQUIRED');
  }

  async select(selector: string, value: string): Promise<string> {
    const page = await this.ensureBrowser();
    const selected = await this.raceAbort(page.selectOption(selector, value, { timeout: ACTION_TIMEOUT_MS }));
    this.invalidateSnapshot();
    return `Selected ${selected.join(', ') || value} in ${selector}`;
  }

  async pressKey(key: string, selector?: string): Promise<string> {
    const normalized = key.trim();
    if (!normalized || normalized.length > 80) throw new Error('BROWSER_KEY_INVALID');
    const page = await this.ensureBrowser();
    if (selector?.trim()) {
      await this.raceAbort(page.press(selector.trim(), normalized, { timeout: ACTION_TIMEOUT_MS }));
    } else {
      await this.raceAbort(page.keyboard.press(normalized));
    }
    this.invalidateSnapshot();
    return `Pressed ${normalized}${selector?.trim() ? ` on ${selector.trim()}` : ''}`;
  }

  async history(action: 'back' | 'forward' | 'reload'): Promise<{ title: string; url: string }> {
    const page = await this.ensureBrowser();
    this.invalidateSnapshot();
    if (action === 'back') await this.raceAbort(page.goBack({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS }));
    else if (action === 'forward') await this.raceAbort(page.goForward({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS }));
    else await this.raceAbort(page.reload({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS }));
    return { title: await this.raceAbort(page.title()), url: page.url() };
  }

  async uploadFile(selector: string, filePath: string): Promise<string> {
    const absolute = path.resolve(filePath);
    assertPathUnder(this.cqrRoot, absolute);
    if (!existsSync(absolute)) throw new Error('BROWSER_UPLOAD_FILE_NOT_FOUND');
    const page = await this.ensureBrowser();
    await this.raceAbort(page.setInputFiles(selector, absolute, { timeout: ACTION_TIMEOUT_MS }));
    this.invalidateSnapshot();
    return `Uploaded ${path.basename(absolute)} to ${selector}`;
  }

  async download(selector: string, sessionId?: string): Promise<{ path: string; relative: string; filename: string }> {
    const page = await this.ensureBrowser();
    const [download] = await this.raceAbort(Promise.all([
      page.waitForEvent('download', { timeout: ACTION_TIMEOUT_MS }),
      page.click(selector, { timeout: ACTION_TIMEOUT_MS }),
    ]));
    const failure = await this.raceAbort(download.failure());
    if (failure) throw new Error(`BROWSER_DOWNLOAD_FAILED: ${failure}`);
    const safeName = path.basename(download.suggestedFilename()).replace(/[^a-zA-Z0-9._-]/g, '_') || `download-${Date.now()}`;
    const sid = (sessionId?.trim() || 'session').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'session';
    const absolute = path.join(this.cqrRoot, 'data', 'outputs', 'browser', sid, 'downloads', safeName);
    assertPathUnder(this.cqrRoot, absolute);
    mkdirSync(path.dirname(absolute), { recursive: true });
    await this.raceAbort(download.saveAs(absolute));
    this.invalidateSnapshot();
    return {
      path: absolute,
      relative: path.relative(this.cqrRoot, absolute).split(path.sep).join('/'),
      filename: safeName,
    };
  }

  getConsoleLogs(clear = false): BrowserDiagnosticEntry[] {
    const result = this.diagnostics.map((entry) => ({ ...entry }));
    if (clear) this.diagnostics.length = 0;
    return result;
  }

  async findInPage(text: string): Promise<BrowserFindResult> {
    const query = text.trim();
    if (!query) throw new Error('BROWSER_FIND_TEXT_REQUIRED');
    const page = await this.ensureBrowser();
    return this.raceAbort(page.evaluate(({ needle }) => {
      const stableSelector = (element: Element): string => {
        const html = element as HTMLElement;
        if (html.id) return `#${CSS.escape(html.id)}`;
        const name = element.getAttribute('name');
        if (name) return `${element.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
        const testId = element.getAttribute('data-testid');
        if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
        const parts: string[] = [];
        let current: Element | null = element;
        while (current && current !== document.body && parts.length < 5) {
          const tag = current.tagName.toLowerCase();
          const parent: Element | null = current.parentElement;
          if (!parent) break;
          const peers = Array.from(parent.children).filter((child: Element) => child.tagName === current?.tagName);
          const index = peers.indexOf(current) + 1;
          parts.unshift(peers.length > 1 ? `${tag}:nth-of-type(${index})` : tag);
          current = parent;
        }
        return `body > ${parts.join(' > ')}`;
      };
      const normalized = needle.toLocaleLowerCase();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let current = walker.nextNode() as Element | null;
      while (current) {
        const style = getComputedStyle(current);
        const textValue = (current.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (style.display !== 'none' && style.visibility !== 'hidden' && textValue.toLocaleLowerCase().includes(normalized)) {
          const childHasMatch = Array.from(current.children).some((child: Element) =>
            (child.textContent ?? '').toLocaleLowerCase().includes(normalized));
          if (!childHasMatch) {
            current.scrollIntoView({ block: 'center', inline: 'nearest' });
            const html = current as HTMLElement;
            const previous = html.style.outline;
            html.style.outline = '3px solid #0f8f83';
            window.setTimeout(() => { html.style.outline = previous; }, 1800);
            const at = textValue.toLocaleLowerCase().indexOf(normalized);
            return {
              found: true,
              text: needle,
              selector: stableSelector(current),
              excerpt: textValue.slice(Math.max(0, at - 120), at + needle.length + 240),
            };
          }
        }
        current = walker.nextNode() as Element | null;
      }
      return { found: false, text: needle };
    }, { needle: query }) as Promise<BrowserFindResult>);
  }

  async scroll(opts: {
    direction: BrowserScrollDirection;
    amount?: number;
    selector?: string;
    text?: string;
  }): Promise<string> {
    const page = await this.ensureBrowser();
    const amount = Math.max(100, Math.min(4000, Math.abs(opts.amount ?? 700)));
    if (opts.direction === 'to-element') {
      if (!opts.selector?.trim()) throw new Error('BROWSER_SCROLL_SELECTOR_REQUIRED');
      await this.raceAbort(page.evaluate(({ selector }) => {
        const node = document.querySelector(selector);
        if (!node) throw new Error(`Element not found: ${selector}`);
        node.scrollIntoView({ block: 'center', inline: 'nearest' });
      }, { selector: opts.selector.trim() }));
      return `Scrolled to selector: ${opts.selector.trim()}`;
    }
    if (opts.direction === 'to-text') {
      const found = await this.findInPage(opts.text ?? '');
      if (!found.found) throw new Error(`Text not found: ${opts.text ?? ''}`);
      return `Scrolled to text: ${opts.text}`;
    }
    const delta = opts.direction === 'up' ? -amount : amount;
    const position = await this.raceAbort(page.evaluate(({ y }) => {
      window.scrollBy({ top: y, behavior: 'instant' });
      return { x: window.scrollX, y: window.scrollY };
    }, { y: delta })) as { x: number; y: number };
    return `Scrolled ${opts.direction} to (${position.x}, ${position.y})`;
  }

  async readText(selector?: string, mode: 'text' | 'table' = 'text'): Promise<string> {
    const page = await this.ensureBrowser();
    const result = await this.raceAbort(page.evaluate(({ css, extractionMode, maxChars }) => {
      const root = css ? document.querySelector(css) : document.body;
      if (!root) throw new Error(`Element not found: ${css}`);
      if (extractionMode === 'table') {
        const tables = root.matches('table') ? [root] : Array.from(root.querySelectorAll('table'));
        const rows = tables.flatMap((table: Element, tableIndex: number) =>
          Array.from(table.querySelectorAll('tr')).map((row: Element) => ({
            table: tableIndex + 1,
            cells: Array.from(row.querySelectorAll('th,td')).map((cell: Element) =>
              (cell.textContent ?? '').replace(/\s+/g, ' ').trim()),
          })));
        return JSON.stringify(rows).slice(0, maxChars);
      }
      return ((root as HTMLElement).innerText ?? root.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxChars);
    }, { css: selector?.trim() || '', extractionMode: mode, maxChars: TIER1_TEXT_MAX }));
    return String(result);
  }

  async snapshot(): Promise<BrowserSnapshotResult> {
    const page = await this.ensureBrowser();
    const rows = await this.raceAbort(page.evaluate(({ maxNodes }) => {
      const stableSelector = (element: Element): string => {
        const html = element as HTMLElement;
        if (html.id) return `#${CSS.escape(html.id)}`;
        const name = element.getAttribute('name');
        if (name) return `${element.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
        const testId = element.getAttribute('data-testid');
        if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
        const parts: string[] = [];
        let current: Element | null = element;
        while (current && current !== document.body && parts.length < 5) {
          const tag = current.tagName.toLowerCase();
          const parent: Element | null = current.parentElement;
          if (!parent) break;
          const peers = Array.from(parent.children).filter((child: Element) => child.tagName === current?.tagName);
          const index = peers.indexOf(current) + 1;
          parts.unshift(peers.length > 1 ? `${tag}:nth-of-type(${index})` : tag);
          current = parent;
        }
        return `body > ${parts.join(' > ')}`;
      };
      const roleFor = (element: Element): string => {
        const explicit = element.getAttribute('role');
        if (explicit) return explicit;
        const tag = element.tagName.toLowerCase();
        if (/^h[1-6]$/.test(tag)) return 'heading';
        if (tag === 'a') return 'link';
        if (tag === 'button') return 'button';
        if (tag === 'input') return (element.getAttribute('type') || 'textbox').toLowerCase();
        if (tag === 'select') return 'combobox';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'img') return 'img';
        return tag;
      };
      const candidates = Array.from(document.querySelectorAll(
        'a,button,input,select,textarea,summary,[role],h1,h2,h3,h4,h5,h6,img,table',
      )).slice(0, maxNodes);
      return candidates.flatMap((element: Element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0) return [];
        const name = (
          element.getAttribute('aria-label')
          || element.getAttribute('alt')
          || element.getAttribute('title')
          || (element.textContent ?? '')
          || element.getAttribute('value')
          || ''
        ).replace(/\s+/g, ' ').trim().slice(0, 180);
        return [{ role: roleFor(element), name, selector: stableSelector(element) }];
      });
    }, { maxNodes: SNAPSHOT_NODE_MAX })) as Array<{ role: string; name: string; selector: string }>;

    this.snapshotRefs.clear();
    this.snapshotSequence += 1;
    this.activeSnapshotId = `isolated-${this.snapshotSequence}`;
    const tree = rows.map((row, index) => {
      const ref = `e${index + 1}`;
      this.snapshotRefs.set(ref, row.selector);
      return `[ref=${ref}] ${row.role}${row.name ? ` "${row.name}"` : ''}`;
    }).join('\n');
    return {
      snapshot_id: this.activeSnapshotId,
      url: page.url(),
      title: await this.raceAbort(page.title()),
      tree: tree || '(no accessible elements)',
      ref_count: rows.length,
    };
  }

  async handoffState(): Promise<{ url: string; title: string } | null> {
    const page = this.page;
    if (!page) return null;
    const url = page.url();
    if (!/^https?:\/\//i.test(url)) return null;
    return { url, title: await this.raceAbort(page.title()) };
  }

  async evaluate(expression: string): Promise<string> {
    const page = await this.ensureBrowser();
    const result = await this.raceAbort(page.evaluate(async ({ expr }) => {
      // eslint-disable-next-line no-eval
      const v = eval(expr);
      return v instanceof Promise ? await v : v;
    }, { expr: expression }));
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
