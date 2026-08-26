import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { resolveCqrRoot } from '../bootstrap.js';
import {
  browserFetchPageText,
  browserNavigate,
  browserScreenshot,
} from '../browser/browser-service.js';
import { isPlaywrightAvailable } from '../browser/playwright-probe.js';
import { loadUserOverrides, userConfigPath } from '../config/user-overrides.js';

function cqrRoot(): string {
  return resolveCqrRoot();
}

function browserOpts() {
  const cfg = loadUserOverrides(userConfigPath(path.join(cqrRoot(), 'data')));
  return {
    cqrRoot: cqrRoot(),
    headless: cfg.playwright_headless !== false,
    allowLocalhost: cfg.playwright_allow_localhost === true,
  };
}

const TOOLS = [
  {
    name: 'browser_navigate',
    description: 'Open a URL in headless Chromium and return title + text excerpt',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Navigate to URL and save a full-page PNG under data/outputs/browser/',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        session_id: { type: 'string' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_fetch_page',
    description: 'Fetch rendered page text (JS-heavy sites) for research pipeline fallback',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
] as const;

export async function startPlaywrightMcpServer(): Promise<void> {
  const root = cqrRoot();
  const server = new Server(
    { name: 'cqr-pa-playwright', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (!isPlaywrightAvailable(root)) {
      return {
        content: [
          {
            type: 'text',
            text: 'Playwright not available. Run tools/bootstrap-playwright.ps1 in MY Agent root.',
          },
        ],
        isError: true,
      };
    }

    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const opts = browserOpts();

    try {
      if (name === 'browser_navigate') {
        const url = String(args.url ?? '');
        const result = await browserNavigate(url, opts);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      if (name === 'browser_screenshot') {
        const url = String(args.url ?? '');
        const sessionId = typeof args.session_id === 'string' ? args.session_id : undefined;
        const result = await browserScreenshot(url, { ...opts, sessionId });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      if (name === 'browser_fetch_page') {
        const url = String(args.url ?? '');
        const result = await browserFetchPageText(url, opts);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: 'text', text: msg }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
