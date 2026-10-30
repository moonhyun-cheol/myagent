/**
 * User-configured remote MCP servers over Streamable HTTP.
 * Config: data/config/user-mcp-servers.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AgentToolDefinition } from './agent-tool-types.js';
import { TOOL_IMAGE_MAX_BYTES, TOOL_IMAGE_MAX_COUNT, toolImageFromBase64 } from './tool-image.js';

export type UserMcpServerConfig = {
  id: string;
  url: string;
  authToken?: string;
  enabled?: boolean;
};

export type UserMcpConfigFile = {
  version: 3;
  servers: UserMcpServerConfig[];
};

const sessions = new Map<string, { client: Client; transport: StreamableHTTPClientTransport }>();

function configPath(cqrRoot: string): string {
  return path.join(path.resolve(cqrRoot), 'data', 'config', 'user-mcp-servers.json');
}

function normalizeId(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
}

function parseServers(raw: { servers?: unknown[] } | null | undefined): UserMcpServerConfig[] {
  const servers: unknown[] = Array.isArray(raw?.servers) ? raw.servers : [];
  return servers
    .filter((server): server is Record<string, unknown> => Boolean(server) && typeof server === 'object')
    .map((server) => ({
      id: normalizeId(String(server.id ?? '')),
      url: String(server.url ?? '').trim(),
      authToken: typeof server.authToken === 'string' ? server.authToken.trim() : undefined,
      enabled: server.enabled !== false,
    }))
    .filter((server) => server.id && server.url);
}

export function loadUserMcpConfig(cqrRoot: string): UserMcpConfigFile {
  const p = configPath(cqrRoot);
  if (!existsSync(p)) return { version: 3, servers: [] };
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as { servers?: unknown[] };
    return { version: 3, servers: parseServers(raw) };
  } catch {
    return { version: 3, servers: [] };
  }
}

export function saveUserMcpConfig(cqrRoot: string, cfg: UserMcpConfigFile): void {
  const p = configPath(cqrRoot);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(
    p,
    `${JSON.stringify({ version: 3, servers: parseServers({ servers: cfg.servers }) }, null, 2)}\n`,
    'utf8',
  );
}

function sessionKey(cqrRoot: string, server: UserMcpServerConfig): string {
  return `${path.resolve(cqrRoot)}::${server.id}::${server.url}::${server.authToken || ''}`;
}

function toolName(serverId: string, name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 48);
  return `mcp_${serverId}_${safe}`.slice(0, 64);
}

export async function connectUserMcpServer(
  cqrRoot: string,
  server: UserMcpServerConfig,
): Promise<Client> {
  const key = sessionKey(cqrRoot, server);
  const existing = sessions.get(key);
  if (existing) return existing.client;

  const headers: Record<string, string> = {};
  if (server.authToken?.trim()) headers.Authorization = `Bearer ${server.authToken.trim()}`;
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers },
  });
  const client = new Client(
    { name: `cqr-pa-remote-mcp-${server.id}`, version: '0.1.0' },
    { capabilities: {} },
  );
  await client.connect(transport);
  sessions.set(key, { client, transport });
  return client;
}

export async function closeUserMcpServer(cqrRoot: string, serverId: string): Promise<void> {
  const prefix = `${path.resolve(cqrRoot)}::${serverId}::`;
  const matches = [...sessions.entries()].filter(([key]) => key.startsWith(prefix));
  for (const [key, row] of matches) {
    try {
      await row.client.close();
    } catch {
      /* ignore */
    }
    sessions.delete(key);
  }
}

/** Best-effort list tools from enabled remote MCP servers. */
export async function listUserMcpToolDefinitions(
  cqrRoot: string,
): Promise<AgentToolDefinition[]> {
  const cfg = loadUserMcpConfig(cqrRoot);
  const out: AgentToolDefinition[] = [];
  for (const server of cfg.servers) {
    if (server.enabled === false) continue;
    try {
      const client = await connectUserMcpServer(cqrRoot, server);
      const listed = await client.listTools();
      for (const t of listed.tools ?? []) {
        const name = toolName(server.id, t.name);
        out.push({
          type: 'function',
          function: {
            name,
            description: `[mcp:${server.id}] ${t.description || t.name}`.slice(0, 500),
            parameters:
              (t.inputSchema as Record<string, unknown>)
              || { type: 'object', properties: {} },
          },
        });
      }
    } catch {
      /* offline / bad config — skip that server */
    }
  }
  return out;
}

export type UserMcpToolResult = { output: string; followUpImages?: string[] };

/** Keep image bytes out of text logs/evidence; report rejected/unsupported blocks explicitly. */
export function normalizeUserMcpResult(result: Record<string, unknown>): UserMcpToolResult {
  const texts: string[] = [];
  const images: string[] = [];
  const warnings: string[] = [];
  let bytes = 0;
  for (const item of Array.isArray(result.content) ? result.content : []) {
    const block = item as Record<string, unknown> | null;
    if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    else if (block?.type === 'image') {
      try {
        if (result.isError) throw new Error('오류 결과의 이미지는 전달하지 않습니다.');
        if (images.length >= TOOL_IMAGE_MAX_COUNT) throw new Error('이미지는 요청당 최대 4장입니다.');
        if (typeof block.data !== 'string' || typeof block.mimeType !== 'string') throw new Error('이미지 데이터 또는 MIME이 없습니다.');
        const image = toolImageFromBase64(block.data, block.mimeType);
        const size = Buffer.byteLength(block.data, 'base64');
        if (bytes + size > TOOL_IMAGE_MAX_BYTES) throw new Error('이미지 합계가 8MB를 초과합니다.');
        bytes += size;
        images.push(image);
      } catch (error) { warnings.push(error instanceof Error ? error.message : String(error)); }
    } else warnings.push(`지원하지 않는 MCP 결과 블록: ${String(block?.type ?? 'unknown')}`);
  }
  const text = texts.join('\n');
  if (result.isError) return { output: JSON.stringify({ ok: false, error: text || 'mcp tool error', warnings }) };
  if (!images.length && !warnings.length) return { output: text || JSON.stringify({ ok: true, note: '(empty mcp result)' }) };
  return { output: JSON.stringify({ ok: true, text, image_count: images.length, warnings,
    note: images.length ? '이미지는 다음 모델 요청에 전달합니다. 이미지 미지원 모델에서는 지원 모델로 변경하세요.'
      : '전달된 이미지가 없습니다. 경고를 확인하고 이미지 내용을 봤다고 판단하지 마세요.' }), followUpImages: images };
}

/** Compatibility for text-only callers. */
export async function callUserMcpTool(
  cqrRoot: string, toolNameFull: string, args: Record<string, unknown>, opts?: { timeoutMs?: number },
): Promise<string> {
  return (await callUserMcpToolWithImages(cqrRoot, toolNameFull, args, opts)).output;
}

/** Call mcp_{serverId}_{tool} through the configured remote MCP server. */
export async function callUserMcpToolWithImages(
  cqrRoot: string,
  toolNameFull: string,
  args: Record<string, unknown>,
  opts?: { timeoutMs?: number },
): Promise<UserMcpToolResult> {
  const m = /^mcp_([a-zA-Z0-9_-]+)_(.+)$/.exec(toolNameFull);
  if (!m) return { output: JSON.stringify({ ok: false, error: 'invalid mcp tool name' }) };
  const serverId = m[1];
  const rawTool = m[2];
  const cfg = loadUserMcpConfig(cqrRoot);
  const server = cfg.servers.find((item) => item.id === serverId && item.enabled !== false);
  if (!server) {
    return { output: JSON.stringify({ ok: false, error: `mcp server not found/disabled: ${serverId}` }) };
  }

  try {
    const client = await connectUserMcpServer(cqrRoot, server);
    const listed = await client.listTools();
    const match =
      listed.tools.find((t) => toolName(serverId, t.name) === toolNameFull)
      || listed.tools.find((t) => t.name.replace(/[^a-zA-Z0-9_]/g, '_') === rawTool)
      || listed.tools.find((t) => t.name === rawTool);
    if (!match) {
      return { output: JSON.stringify({ ok: false, error: `tool not on server ${serverId}: ${rawTool}` }) };
    }
    const result = await client.callTool(
      { name: match.name, arguments: args },
      undefined,
      { timeout: opts?.timeoutMs ?? 120_000 },
    );
    return normalizeUserMcpResult(result);
  } catch (error: unknown) {
    return { output: JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) };
  }
}

export function formatUserMcpServersJson(cqrRoot: string): string {
  const cfg = loadUserMcpConfig(cqrRoot);
  return JSON.stringify(
    {
      ok: true,
      path: 'data/config/user-mcp-servers.json',
      transport: 'streamable_http',
      servers: cfg.servers.map((server) => ({
        id: server.id,
        url: server.url,
        enabled: server.enabled !== false,
        authConfigured: Boolean(server.authToken),
      })),
      note: 'Remote MCP only. MY Agent stores the MCP URL and MCP token; API credentials stay on the MCP/API server.',
    },
    null,
    2,
  );
}

/** Connect + listTools for one remote server (settings Test button). */
export async function probeUserMcpServer(
  cqrRoot: string,
  serverId: string,
): Promise<{ ok: boolean; tool_count?: number; tools?: string[]; error?: string }> {
  const id = normalizeId(String(serverId || ''));
  if (!id) return { ok: false, error: 'server id required' };
  const server = loadUserMcpConfig(cqrRoot).servers.find((item) => item.id === id);
  if (!server) return { ok: false, error: `server not found: ${id}` };
  try {
    const client = await connectUserMcpServer(cqrRoot, { ...server, enabled: true });
    const listed = await client.listTools();
    return {
      ok: true,
      tool_count: listed.tools?.length ?? 0,
      tools: (listed.tools ?? []).map((tool) => tool.name).slice(0, 40),
    };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
