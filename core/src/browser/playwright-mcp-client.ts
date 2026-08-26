import { existsSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolveCqrRoot } from '../bootstrap.js';
import { isPlaywrightAvailable } from './playwright-probe.js';

const DEFAULT_TIMEOUT_MS = 120_000;

function parseToolJson(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'invalid MCP tool JSON', raw_text: text };
  }
}

export class PlaywrightMcpSession {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  readonly cqrRoot: string;

  constructor(cqrRoot?: string) {
    this.cqrRoot = cqrRoot ?? resolveCqrRoot();
  }

  mcpEntry(): string {
    return path.join(this.cqrRoot, 'tools', 'mcp-playwright.mjs');
  }

  isAvailable(): boolean {
    return isPlaywrightAvailable(this.cqrRoot) && existsSync(this.mcpEntry());
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  async connect(): Promise<Client> {
    if (this.client) return this.client;

    const entry = this.mcpEntry();
    if (!existsSync(entry)) {
      throw new Error('tools/mcp-playwright.mjs not found');
    }

    this.transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry, '--skip-build'],
      cwd: this.cqrRoot,
      env: { ...process.env, MY_AGENT_ROOT: this.cqrRoot },
      stderr: 'pipe',
    });

    this.client = new Client({ name: 'cqr-pa-playwright-client', version: '0.1.0' }, { capabilities: {} });
    await this.client.connect(this.transport);
    return this.client;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    const client = await this.connect();
    const result = await client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    );
    const text = (Array.isArray(result.content) ? result.content : [])
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text' && 'text' in c)
      .map((c) => c.text)
      .join('\n');
    if (!text) {
      return { ok: false, error: 'empty MCP tool result', tool: name };
    }
    const doc = parseToolJson(text);
    if (result.isError && doc.ok !== false) {
      return { ok: false, error: text, tool: name };
    }
    return doc;
  }

  async listToolNames(): Promise<string[]> {
    const client = await this.connect();
    const tools = await client.listTools();
    return tools.tools.map((t) => t.name);
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
    this.transport = null;
  }
}
