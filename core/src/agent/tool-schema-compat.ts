import type { AgentToolCall, AgentToolDefinition } from './tools.js';
import { normalizeToolCall } from './tools.js';

type JsonRecord = Record<string, unknown>;

const ARG_KEY_ALIASES: Record<string, string> = {
  filepath: 'path',
  filename: 'path',
  file: 'path',
  targetpath: 'path',
  directorypath: 'path',
  dir: 'path',
  folder: 'path',
  oldstring: 'old_text',
  newstring: 'new_text',
  contents: 'content',
  text: 'content',
  body: 'content',
  streamcontent: 'content',
  filecontent: 'content',
  file_content: 'content',
  updatedcontent: 'content',
  replacement: 'new_text',
  cmd: 'command',
  to: 'new_path',
  destination: 'new_path',
  toppath: 'new_path',
};

export interface ToolSchemaValidationResult {
  hasSchema: boolean;
  ok: boolean;
  missing: string[];
  unexpected: string[];
  typeErrors: string[];
  repairHint?: string;
}

export interface ToolSchemaCompatResult {
  toolCall: AgentToolCall;
  validation: ToolSchemaValidationResult;
  reroutedFrom?: string;
}

function parseArguments(raw: string): JsonRecord {
  try {
    const parsed = JSON.parse(raw || '{}') as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as JsonRecord;
    }
    return { value: parsed };
  } catch {
    return { value: raw };
  }
}

function buildSchemaMap(tools: AgentToolDefinition[]): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const tool of tools) {
    map.set(tool.function.name, tool.function.parameters);
  }
  return map;
}

function normalizeArgKeys(args: JsonRecord, schema?: Record<string, unknown>): JsonRecord {
  const out: JsonRecord = { ...args };
  const schemaProps = schema?.properties && typeof schema.properties === 'object'
    ? new Set(Object.keys(schema.properties as Record<string, unknown>))
    : new Set<string>();

  for (const [rawKey, rawValue] of Object.entries(args)) {
    const canonical = ARG_KEY_ALIASES[rawKey.toLowerCase().replace(/[^a-z0-9]/g, '')];
    if (!canonical || canonical === rawKey || schemaProps.has(rawKey)) continue;
    if (Object.prototype.hasOwnProperty.call(out, canonical)) {
      delete out[rawKey];
      continue;
    }
    out[canonical] = rawValue;
    delete out[rawKey];
  }
  return out;
}

function validateArgs(
  toolName: string,
  args: JsonRecord,
  schema?: Record<string, unknown>,
): ToolSchemaValidationResult {
  if (!schema) {
    return { hasSchema: false, ok: true, missing: [], unexpected: [], typeErrors: [] };
  }

  const properties = (schema.properties && typeof schema.properties === 'object'
    ? schema.properties
    : {}) as Record<string, { type?: string }>;
  const required = Array.isArray(schema.required)
    ? schema.required.filter((v): v is string => typeof v === 'string')
    : [];

  const missing = required.filter((key) => {
    if (!Object.prototype.hasOwnProperty.call(args, key)) return true;
    const v = args[key];
    // Empty strings fail required for path/content/old_text/new_text (model slip).
    if (
      typeof v === 'string'
      && !v.trim()
      && (key === 'path' || key === 'content' || key === 'old_text' || key === 'new_text' || key === 'command')
    ) {
      return true;
    }
    return false;
  });
  const unexpected: string[] = [];
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) unexpected.push(key);
    }
  }

  const typeErrors: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    const prop = properties[key];
    if (!prop?.type) continue;
    if (prop.type === 'string' && typeof value !== 'string') {
      typeErrors.push(`${key}: expected string`);
    }
  }

  const ok = missing.length === 0 && unexpected.length === 0 && typeErrors.length === 0;
  let repairHint: string | undefined;
  if (!ok) {
    const hints: string[] = [];
    if (missing.length) hints.push(`missing required: ${missing.join(', ')}`);
    if (unexpected.length) hints.push(`remove unsupported fields: ${unexpected.join(', ')}`);
    if (typeErrors.length) hints.push(typeErrors.join('; '));
    if (toolName === 'edit_file' && missing.includes('old_text')) {
      hints.push('edit_file requires path, old_text, new_text — for full file rewrite use write_file with path and content');
    }
    if (toolName === 'write_file' && missing.includes('content')) {
      hints.push('write_file requires path and content (full file body as JSON string)');
    }
    repairHint = hints.join(' | ');
  }

  return { hasSchema: true, ok, missing, unexpected, typeErrors, repairHint };
}

function tryRerouteEditToWrite(call: AgentToolCall, args: JsonRecord): AgentToolCall | null {
  if (call.function.name !== 'edit_file') return null;
  const oldText = typeof args.old_text === 'string' ? args.old_text : '';
  if (oldText.trim().length > 0) return null;
  const path = typeof args.path === 'string' ? args.path.trim() : '';
  const content =
    typeof args.new_text === 'string' && args.new_text.length
      ? args.new_text
      : typeof args.content === 'string' && args.content.length
        ? args.content
        : typeof args.body === 'string' && args.body.length
          ? args.body
          : null;
  if (!path || content === null) return null;
  // Full-file rewrite heuristic: any non-empty new_text/content without old_text.
  return {
    ...call,
    function: {
      name: 'write_file',
      arguments: JSON.stringify({ path, content }),
    },
  };
}

/** Normalize model tool args and validate against MY Agent schemas before execution. */
export function applyToolSchemaCompat(
  call: AgentToolCall,
  tools: AgentToolDefinition[],
): ToolSchemaCompatResult {
  const normalized = normalizeToolCall(call);
  const schemaMap = buildSchemaMap(tools);
  let args = normalizeArgKeys(parseArguments(normalized.function.arguments), schemaMap.get(normalized.function.name));

  let toolCall = normalized;
  let reroutedFrom: string | undefined;
  const rerouted = tryRerouteEditToWrite(normalized, args);
  if (rerouted) {
    toolCall = rerouted;
    reroutedFrom = 'edit_file';
    args = parseArguments(rerouted.function.arguments);
  }

  let schema = schemaMap.get(toolCall.function.name);
  let validation = validateArgs(toolCall.function.name, args, schema);

  // Second chance: validation says missing old_text → coerce to write_file once.
  if (
    !validation.ok
    && toolCall.function.name === 'edit_file'
    && validation.missing.includes('old_text')
  ) {
    const healed = tryRerouteEditToWrite(
      { ...toolCall, function: { ...toolCall.function, name: 'edit_file' } },
      args,
    );
    if (healed) {
      toolCall = healed;
      reroutedFrom = reroutedFrom ?? 'edit_file';
      args = parseArguments(healed.function.arguments);
      schema = schemaMap.get('write_file');
      validation = validateArgs('write_file', args, schema);
    }
  }

  return {
    toolCall: {
      ...toolCall,
      function: {
        ...toolCall.function,
        arguments: JSON.stringify(args),
      },
    },
    validation,
    reroutedFrom,
  };
}
