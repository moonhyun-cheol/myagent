import { createHash } from 'node:crypto';
import type { ChatMessage } from './openai-compatible.js';

const CACHE_VERSION = 1 as const;
const MAX_LOCAL_PREFIXES = 128;

export type PromptContextMetadata = {
  version: typeof CACHE_VERSION;
  prefix_hash: string;
  tool_schema_hash: string;
  stable_prefix_chars: number;
  duplicate_system_blocks_removed: number;
  duplicate_tools_removed: number;
  local_cache_hit: boolean;
};

export type CompiledPromptContext = {
  messages: ChatMessage[];
  tools: unknown[];
  metadata: PromptContextMetadata;
};

type CachedPrefix = {
  system: string;
  tools: unknown[];
  metadata: Omit<PromptContextMetadata, 'local_cache_hit'>;
};

const localPrefixCache = new Map<string, CachedPrefix>();

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** JSON form with deterministic object-key order; arrays retain semantic order. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${stableJson(row[key])}`).join(',')}}`;
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  const source = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(source).sort().map((key) => [key, canonicalValue(source[key])]));
}

function normalizeStaticText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trim();
}

function toolName(tool: unknown): string {
  if (!tool || typeof tool !== 'object') return '';
  const row = tool as { name?: unknown; function?: { name?: unknown } };
  const name = row.function?.name ?? row.name;
  return typeof name === 'string' ? name : '';
}

function compileStablePrefix(messages: ChatMessage[], tools: unknown[]): CachedPrefix {
  const seenSystems = new Set<string>();
  const systems: string[] = [];
  let duplicateSystems = 0;
  for (const message of messages) {
    // Ephemeral notes are dynamic-tail content; they must never move the prefix hash.
    if (message.role !== 'system' || message.ephemeral === true || typeof message.content !== 'string') continue;
    const normalized = normalizeStaticText(message.content);
    if (!normalized) continue;
    if (seenSystems.has(normalized)) {
      duplicateSystems += 1;
      continue;
    }
    seenSystems.add(normalized);
    systems.push(normalized);
  }

  const toolRows = tools.map((tool) => {
    const value = canonicalValue(tool);
    return { name: toolName(value), json: stableJson(value), value };
  });
  toolRows.sort((a, b) => a.name.localeCompare(b.name) || a.json.localeCompare(b.json));
  const seenTools = new Set<string>();
  const canonicalTools: unknown[] = [];
  let duplicateTools = 0;
  for (const row of toolRows) {
    if (seenTools.has(row.json)) {
      duplicateTools += 1;
      continue;
    }
    seenTools.add(row.json);
    canonicalTools.push(row.value);
  }

  const system = systems.join('\n\n');
  const toolJson = stableJson(canonicalTools);
  const prefix = stableJson({ version: CACHE_VERSION, system, tools: canonicalTools });
  return {
    system,
    tools: canonicalTools,
    metadata: {
      version: CACHE_VERSION,
      prefix_hash: sha256(prefix),
      tool_schema_hash: sha256(toolJson),
      stable_prefix_chars: system.length + toolJson.length,
      duplicate_system_blocks_removed: duplicateSystems,
      duplicate_tools_removed: duplicateTools,
    },
  };
}

function remember(key: string, value: CachedPrefix): void {
  if (localPrefixCache.size >= MAX_LOCAL_PREFIXES) {
    const oldest = localPrefixCache.keys().next().value as string | undefined;
    if (oldest) localPrefixCache.delete(oldest);
  }
  localPrefixCache.set(key, value);
}

/**
 * Build one deterministic provider prefix while preserving every non-system message byte-for-byte.
 * This is a bounded local compilation cache, not an LLM answer cache.
 */
export function compilePromptContext(messages: ChatMessage[], tools: unknown[] = []): CompiledPromptContext {
  const candidate = compileStablePrefix(messages, tools);
  const key = candidate.metadata.prefix_hash;
  const cached = localPrefixCache.get(key);
  const stable = cached ?? candidate;
  if (!cached) remember(key, candidate);

  const dynamicMessages = messages.filter((message) => message.role !== 'system');
  const compiledMessages: ChatMessage[] = [
    ...(stable.system ? [{ role: 'system', content: stable.system } as ChatMessage] : []),
    ...dynamicMessages,
  ];
  return {
    messages: compiledMessages,
    tools: stable.tools,
    // Duplicate counters describe this request, not the first request that populated the cache.
    metadata: { ...candidate.metadata, local_cache_hit: Boolean(cached) },
  };
}

export function clearPromptContextCache(): void {
  localPrefixCache.clear();
}

export function promptContextCacheStats(): { entries: number; max_entries: number } {
  return { entries: localPrefixCache.size, max_entries: MAX_LOCAL_PREFIXES };
}
