import type {
  BrowserFetchPageResult,
  BrowserNavigateResult,
  BrowserScreenshotResult,
  BrowserServiceOptions,
} from './browser-service.js';
import { PlaywrightMcpSession } from './playwright-mcp-client.js';
import { resolveCqrRoot } from '../bootstrap.js';

let sharedSession: PlaywrightMcpSession | null = null;
let sharedRoot: string | undefined;

export function getPlaywrightMcpAdapter(cqrRoot?: string): PlaywrightMcpSession {
  const root = cqrRoot ?? resolveCqrRoot();
  if (!sharedSession || sharedRoot !== root) {
    void sharedSession?.close();
    sharedSession = new PlaywrightMcpSession(root);
    sharedRoot = root;
  }
  return sharedSession;
}

export async function browserScreenshotViaMcp(
  url: string,
  opts: BrowserServiceOptions & { sessionId?: string },
): Promise<BrowserScreenshotResult> {
  const adapter = getPlaywrightMcpAdapter(opts.cqrRoot);
  if (!adapter.isAvailable()) {
    return { ok: false, error: 'Playwright not installed — run tools/bootstrap-playwright.ps1' };
  }
  try {
    const result = await adapter.callTool('browser_screenshot', {
      url,
      session_id: opts.sessionId,
    });
    return result as unknown as BrowserScreenshotResult;
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function browserNavigateViaMcp(
  url: string,
  opts: BrowserServiceOptions,
): Promise<BrowserNavigateResult> {
  const adapter = getPlaywrightMcpAdapter(opts.cqrRoot);
  if (!adapter.isAvailable()) {
    return { ok: false, error: 'Playwright not installed — run tools/bootstrap-playwright.ps1' };
  }
  try {
    const result = await adapter.callTool('browser_navigate', { url });
    return result as unknown as BrowserNavigateResult;
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function browserFetchPageViaMcp(
  url: string,
  opts: BrowserServiceOptions,
): Promise<BrowserFetchPageResult> {
  const adapter = getPlaywrightMcpAdapter(opts.cqrRoot);
  if (!adapter.isAvailable()) {
    return { ok: false, error: 'PLAYWRIGHT_UNAVAILABLE' };
  }
  try {
    const result = await adapter.callTool('browser_fetch_page', { url });
    return result as unknown as BrowserFetchPageResult;
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function getPlaywrightMcpDiagnostics(cqrRoot?: string): Promise<Record<string, unknown>> {
  const root = cqrRoot ?? resolveCqrRoot();
  const shared = getPlaywrightMcpAdapter(root);
  if (!shared.isAvailable()) {
    return {
      configured: true,
      ok: false,
      first_class: true,
      prefer: 'mcp',
      transport: 'stdio',
      server: shared.mcpEntry(),
      error: 'Playwright runtime or MCP entry missing — run tools/bootstrap-playwright.ps1',
    };
  }
  // A health probe must not leave an MCP child alive: reuse a live session, else spawn a
  // throwaway one and close it, or embedders (verify scripts, CLI) never reach exit.
  const adapter = shared.isConnected() ? shared : new PlaywrightMcpSession(root);
  try {
    const tools = await adapter.listToolNames();
    return {
      configured: true,
      ok: true,
      first_class: true,
      prefer: 'mcp',
      transport: 'stdio',
      server: adapter.mcpEntry(),
      tools,
    };
  } catch (err) {
    return {
      configured: true,
      ok: false,
      first_class: true,
      prefer: 'mcp',
      transport: 'stdio',
      server: adapter.mcpEntry(),
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (adapter !== shared) await adapter.close();
  }
}
