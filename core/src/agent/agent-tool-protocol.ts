import type { ChatMessage } from '../providers/openai-compatible.js';
import type { ProviderDefinition } from '../providers/types.js';
import { owuiPrefersClientToolProtocol } from '../providers/harness-policy.js';

/**
 * Select the legacy TEXT TOOL_CALL compatibility protocol.
 * - Ollama / local_only: always TEXT
 * - Responses / Anthropic Messages: caller locks native tools, so this return
 *   value is ignored and the runtime never renegotiates to TEXT.
 * - Chat Completions: configuration may explicitly retain TEXT compatibility.
 * - Non-code: `MY_AGENT_OWUI_PROTOCOL` (default text).
 */
export function prefersClientToolProtocol(
  providerId: string,
  def: ProviderDefinition,
  opts?: { forCodeAgent?: boolean },
): boolean {
  return owuiPrefersClientToolProtocol(providerId, def, process.env, opts?.forCodeAgent !== false);
}

export function isCodeAgentLlmProvider(_providerId: string, def: ProviderDefinition): boolean {
  return def.kind === 'openai_compatible';
}

export function clientToolProtocolInstruction(toolNames: string[]): string {
  return [
    '## TOOL_CALL protocol (required)',
    'When you need a workspace tool, first line MUST be:',
    'TOOL_CALL: {"name":"read_file","arguments":{"path":"relative/path.ts"}}',
    'Then a blank line and a brief Korean status.',
    'write_file needs full arguments.content (\\n for newlines). Prefer edit_file for small edits.',
    `Valid names: ${toolNames.join(', ')}.`,
    'MY Agent executes TOOL_CALL locally — never claim "Tool not found".',
    'No XML/<invoke>. Example after a read:',
    'TOOL_CALL: {"name":"edit_file","arguments":{"path":"app.js","old_text":"foo","new_text":"bar"}}',
  ].join('\n');
}

const PROTOCOL_MARKER = '## TOOL_CALL protocol (required)';

export function appendClientToolProtocol(
  messages: ChatMessage[],
  toolNames: string[],
): ChatMessage[] {
  const out = messages.map((m) => ({ ...m }));
  const sys = out.find((m) => m.role === 'system');
  const extra = clientToolProtocolInstruction(toolNames);
  if (sys) {
    const cur = typeof sys.content === 'string' ? sys.content : '';
    // Avoid re-injecting the full block every client step.
    if (cur.includes(PROTOCOL_MARKER)) return out;
    sys.content = `${cur}\n\n${extra}`;
  } else {
    out.unshift({ role: 'system', content: extra });
  }
  return out;
}
