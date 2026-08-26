import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { pythonFileRoot, resolveAutomatonPython, resolveAutomatonRoot } from './paths.js';
import { resolveAutomatonToolTimeoutMs } from './timeouts.js';

const MAX_RECONNECT_ATTEMPTS = 3;

function isMcpTimeoutError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /-32001|timed out|timeout/i.test(msg);
}

function isRecoverableTransportError(err: unknown): boolean {
  if (isMcpTimeoutError(err)) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return /transport|connection|closed|econnreset|broken pipe|spawn/i.test(msg);
}

export class AutomatonMcpSession {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private readonly configuredRoot?: string;

  constructor(configuredRoot?: string) {
    this.configuredRoot = configuredRoot;
  }

  isConfigured(): boolean {
    return resolveAutomatonRoot(this.configuredRoot) !== null
      && resolveAutomatonPython(resolveAutomatonRoot(this.configuredRoot)!) !== null;
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  async connect(): Promise<Client> {
    if (this.client) return this.client;

    const root = resolveAutomatonRoot(this.configuredRoot);
    if (!root) {
      throw new Error('LIVE_AUTOMATON_ROOT not found (00_python_file missing)');
    }
    const python = resolveAutomatonPython(root);
    if (!python) {
      throw new Error('automaton python.exe not found');
    }

    this.transport = new StdioClientTransport({
      command: python,
      args: ['-m', '_80_mcp.server'],
      cwd: pythonFileRoot(root),
      env: {
        ...process.env,
        LIVE_AUTOMATON_ROOT: root,
        LIVE_AUTOMATON_PYTHON: python,
        PYTHONIOENCODING: 'utf-8',
        OPENCLAW_MCP_FRONTEND_NORMALIZE: '1',
      },
      stderr: 'pipe',
    });

    this.client = new Client({ name: 'cqr-pa', version: '0.1.0' }, { capabilities: {} });
    await this.client.connect(this.transport);
    return this.client;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    const timeoutMs = options?.timeoutMs ?? resolveAutomatonToolTimeoutMs(name);
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS; attempt += 1) {
      try {
        const client = await this.connect();
        const result = await client.callTool(
          { name, arguments: args },
          undefined,
          { timeout: timeoutMs, resetTimeoutOnProgress: true },
        );
        const content = Array.isArray(result.content) ? result.content : [];
        const text = content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text' && 'text' in c)
          .map((c) => c.text)
          .join('\n');
        if (!text) {
          return { status: 'failed', error: 'empty tool result', tool: name };
        }
        try {
          return JSON.parse(text) as Record<string, unknown>;
        } catch {
          return {
            status: result.isError ? 'failed' : 'success',
            raw_text: text,
            is_error: result.isError,
            tool: name,
          };
        }
      } catch (err) {
        lastError = err;
        if (isMcpTimeoutError(err)) {
          await this.close();
          break;
        }
        await this.close();
        if (!isRecoverableTransportError(err) || attempt >= MAX_RECONNECT_ATTEMPTS - 1) break;
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      }
    }

    return {
      status: isMcpTimeoutError(lastError) ? 'mcp_timeout' : 'mcp_transport_error',
      tool: name,
      message: lastError instanceof Error ? lastError.message : String(lastError),
      recoverable: isRecoverableTransportError(lastError),
    };
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
