/**
 * Wire-level log of OpenAI-compatible /chat/completions traffic.
 * Enable: MY_AGENT_LLM_LOG=1|true|on|summary|full  (default off)
 * Dir:   MY_AGENT_LLM_LOG_DIR or <cwd>/data/logs
 * File:  llm-wire.jsonl
 *
 * Never writes Authorization / api keys. Bodies may still contain user code —
 * treat data/logs as sensitive local data.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type LlmLogMode = 'off' | 'summary' | 'full';

type WireListener = (line: string) => void;

let wireListener: WireListener | null = null;

/** Optional UI/status hook (e.g. code-agent onStatus). */
export function setLlmWireLogListener(fn: WireListener | null): void {
  wireListener = fn;
}

export function resolveLlmLogMode(): LlmLogMode {
  const raw = (process.env.MY_AGENT_LLM_LOG ?? '').trim().toLowerCase();
  if (!raw || raw === '0' || raw === 'off' || raw === 'false' || raw === 'no') return 'off';
  if (raw === 'full' || raw === 'verbose' || raw === '2') return 'full';
  return 'summary'; // 1 | true | on | summary | jsonl
}

export function llmWireLogDir(): string {
  const override = (process.env.MY_AGENT_LLM_LOG_DIR ?? '').trim();
  if (override) return path.resolve(override);
  return path.resolve(process.cwd(), 'data', 'logs');
}

export function llmWireLogPath(): string {
  return path.join(llmWireLogDir(), 'llm-wire.jsonl');
}

function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***')
    .replace(/("api[_-]?key"\s*:\s*")[^"]+"/gi, '$1***"')
    .replace(/(sk-[A-Za-z0-9]{8,})/g, 'sk-***')
    .replace(/(sk-proj-[A-Za-z0-9_\-]{8,})/g, 'sk-proj-***');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…(+${s.length - max} chars)`;
}

function summarizeContent(content: unknown, mode: LlmLogMode): unknown {
  if (content == null) return null;
  if (typeof content === 'string') {
    return mode === 'full' ? truncate(content, 80_000) : truncate(content, 4_000);
  }
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!part || typeof part !== 'object') return part;
      const p = part as { type?: string; text?: string; image_url?: { url?: string } };
      if (p.type === 'image_url') {
        const url = p.image_url?.url ?? '';
        return {
          type: 'image_url',
          image_url: {
            url: url.startsWith('data:')
              ? `data:[redacted ${url.length} chars]`
              : truncate(url, 120),
          },
        };
      }
      if (typeof p.text === 'string') {
        return {
          ...p,
          text: mode === 'full' ? truncate(p.text, 80_000) : truncate(p.text, 4_000),
        };
      }
      return part;
    });
  }
  return content;
}

function summarizeMessages(messages: unknown[], mode: LlmLogMode): unknown[] {
  return messages.map((m) => {
    if (!m || typeof m !== 'object') return m;
    const row = m as Record<string, unknown>;
    const out: Record<string, unknown> = {
      role: row.role,
      content: summarizeContent(row.content, mode),
    };
    if (row.tool_call_id) out.tool_call_id = row.tool_call_id;
    if (Array.isArray(row.tool_calls)) {
      out.tool_calls = row.tool_calls.map((tc) => {
        if (!tc || typeof tc !== 'object') return tc;
        const t = tc as {
          id?: string;
          function?: { name?: string; arguments?: string };
        };
        const args = t.function?.arguments ?? '';
        return {
          id: t.id,
          function: {
            name: t.function?.name,
            arguments:
              mode === 'full' ? truncate(String(args), 40_000) : truncate(String(args), 2_000),
          },
        };
      });
    }
    return out;
  });
}

function summarizeTools(tools: unknown[] | undefined, mode: LlmLogMode): unknown {
  if (!tools?.length) return undefined;
  if (mode === 'full') {
    return tools.map((t) => {
      const raw = JSON.stringify(t);
      return raw.length > 8_000 ? JSON.parse(truncate(raw, 8_000) + '"}') : t;
    });
  }
  return tools.map((t) => {
    if (!t || typeof t !== 'object') return t;
    const fn = (t as { function?: { name?: string; description?: string } }).function;
    return {
      type: (t as { type?: string }).type ?? 'function',
      function: {
        name: fn?.name,
        description: fn?.description ? truncate(fn.description, 160) : undefined,
      },
    };
  });
}

function writeJsonl(entry: Record<string, unknown>): void {
  const dir = llmWireLogDir();
  mkdirSync(dir, { recursive: true });
  const line = `${JSON.stringify(entry)}\n`;
  appendFileSync(llmWireLogPath(), line, 'utf8');
}

function emitUi(line: string): void {
  try {
    wireListener?.(line);
  } catch {
    /* ignore */
  }
  // Always mirror a short line to stderr for the EXE-hosted API / development console.
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    /* ignore */
  }
}

export interface LlmWireRequestLog {
  url: string;
  model: string;
  messages: unknown[];
  tools?: unknown[];
  toolChoice?: string;
  stream?: boolean;
  kind?: string;
  promptContext?: {
    prefix_hash: string;
    tool_schema_hash: string;
    stable_prefix_chars: number;
    duplicate_system_blocks_removed: number;
    duplicate_tools_removed: number;
    local_cache_hit: boolean;
  };
}

export interface LlmWireResponseLog {
  ok: boolean;
  status?: number;
  model?: string;
  finishReason?: string | null;
  content?: string | null;
  toolCalls?: { id?: string; name?: string; arguments?: string }[];
  usage?: unknown;
  error?: string;
  durationMs?: number;
  stream?: boolean;
}

/**
 * Log outbound chat/completions request. Returns requestId for pairing response.
 */
export function logLlmWireRequest(req: LlmWireRequestLog): string | null {
  const mode = resolveLlmLogMode();
  if (mode === 'off') return null;
  const id = randomUUID().slice(0, 8);
  const safeUrl = redactSecrets(req.url);
  const entry = {
    id,
    at: new Date().toISOString(),
    dir: 'request',
    kind: req.kind ?? 'chat.completions',
    url: safeUrl,
    model: req.model,
    stream: req.stream === true,
    tool_choice: req.toolChoice,
    message_count: req.messages.length,
    tool_count: req.tools?.length ?? 0,
    tool_names: (req.tools ?? [])
      .map((t) => {
        if (!t || typeof t !== 'object') return null;
        return (t as { function?: { name?: string } }).function?.name ?? null;
      })
      .filter(Boolean),
    prompt_context: req.promptContext,
    messages: summarizeMessages(req.messages, mode),
    tools: summarizeTools(req.tools, mode),
  };
  try {
    writeJsonl(entry);
  } catch (e) {
    emitUi(`LLM log write failed: ${e instanceof Error ? e.message : String(e)}`);
    return id;
  }
  const toolsN = req.tools?.length ?? 0;
  emitUi(
    `LLM → POST ${safeUrl} id=${id} model=${req.model} msgs=${req.messages.length} tools=${toolsN}${req.stream ? ' stream' : ''}`,
  );
  return id;
}

export function logLlmWireResponse(requestId: string | null, res: LlmWireResponseLog): void {
  const mode = resolveLlmLogMode();
  if (mode === 'off') return;
  const id = requestId ?? randomUUID().slice(0, 8);
  const toolCalls = (res.toolCalls ?? []).map((tc) => ({
    id: tc.id,
    name: tc.name,
    arguments:
      mode === 'full'
        ? truncate(String(tc.arguments ?? ''), 40_000)
        : truncate(String(tc.arguments ?? ''), 2_000),
  }));
  const entry = {
    id,
    at: new Date().toISOString(),
    dir: 'response',
    ok: res.ok,
    status: res.status,
    model: res.model,
    finish_reason: res.finishReason ?? null,
    stream: res.stream === true,
    duration_ms: res.durationMs,
    content:
      res.content == null
        ? null
        : mode === 'full'
          ? truncate(res.content, 80_000)
          : truncate(res.content, 4_000),
    tool_calls: toolCalls,
    usage: res.usage,
    error: res.error ? redactSecrets(res.error) : undefined,
  };
  try {
    writeJsonl(entry);
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    emitUi(
      `LLM ← FAIL id=${id} status=${res.status ?? '?'} err=${truncate(redactSecrets(res.error ?? ''), 160)}`,
    );
    return;
  }
  emitUi(
    `LLM ← OK id=${id} model=${res.model ?? '?'} finish=${res.finishReason ?? '-'} tools=${toolCalls.length} chars=${(res.content ?? '').length}${res.durationMs != null ? ` ${res.durationMs}ms` : ''}`,
  );
}
