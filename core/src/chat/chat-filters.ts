/**
 * Open WebUI Filter-inspired inlet / outlet / stream guards for chat.
 * Runs inside MY Agent orchestrator (no external Pipelines worker).
 */

import type { SessionMessage } from '../sessions/types.js';

export interface ChatFilterContext {
  sessionId?: string;
  mode?: string;
  userMessage?: string;
}

export interface ChatFilterResult {
  /** Transformed text */
  text: string;
  /** Soft warnings for thought/status UI */
  warnings?: string[];
  /** Hard block — do not call the model */
  blocked?: boolean;
  blockReason?: string;
}

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'private_key', re: /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/g },
  { name: 'aws_key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'github_pat', re: /\bghp_[A-Za-z0-9]{36,}\b/g },
  { name: 'openai_sk', re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { name: 'slack_token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
];

const PII_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'email', re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  // Korean mobile (soft — only redact in outlet by default for logs)
  { name: 'kr_mobile', re: /\b01[016789]-?\d{3,4}-?\d{4}\b/g },
];

function redactPatterns(
  text: string,
  patterns: Array<{ name: string; re: RegExp }>,
  label: string,
): { text: string; hits: string[] } {
  let out = text;
  const hits: string[] = [];
  for (const p of patterns) {
    const re = new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : `${p.re.flags}g`);
    if (re.test(out)) {
      hits.push(p.name);
      out = out.replace(re, `[REDACTED_${label}_${p.name.toUpperCase()}]`);
    }
  }
  return { text: out, hits };
}

/** Inlet: sanitize / rate-hint user message before model. */
export function applyChatInletFilter(
  message: string,
  _ctx: ChatFilterContext = {},
): ChatFilterResult {
  const warnings: string[] = [];
  let text = message;

  if (text.length > 200_000) {
    return {
      text: text.slice(0, 200_000),
      blocked: true,
      blockReason: 'Message exceeds 200k characters.',
      warnings: ['inlet: message too large'],
    };
  }

  const secrets = redactPatterns(text, SECRET_PATTERNS, 'SECRET');
  if (secrets.hits.length) {
    text = secrets.text;
    warnings.push(`inlet: redacted secrets (${secrets.hits.join(', ')})`);
  }

  // Block empty after strip
  if (!text.trim()) {
    return { text, blocked: true, blockReason: 'Empty message after inlet filter.', warnings };
  }

  return { text, warnings };
}

/** Outlet: scrub model reply before UI / session persist. */
export function applyChatOutletFilter(
  reply: string,
  _ctx: ChatFilterContext = {},
): ChatFilterResult {
  const warnings: string[] = [];
  let text = reply;

  const secrets = redactPatterns(text, SECRET_PATTERNS, 'SECRET');
  if (secrets.hits.length) {
    text = secrets.text;
    warnings.push(`outlet: redacted secrets (${secrets.hits.join(', ')})`);
  }

  // Soft PII redaction in assistant output only when it looks like a dump
  if (/(?:password|passwd|api[_-]?key|secret)\s*[:=]/i.test(text)) {
    const pii = redactPatterns(text, PII_PATTERNS, 'PII');
    if (pii.hits.length) {
      text = pii.text;
      warnings.push(`outlet: redacted pii near credential context (${pii.hits.join(', ')})`);
    }
  }

  const scrubbedChannels = scrubAgentChannelLeak(text);
  if (scrubbedChannels !== text) {
    text = scrubbedChannels;
    warnings.push('outlet: stripped agent channel tags');
  }

  return { text, warnings };
}

/**
 * Models sometimes leak Cursor/Codex-style channel markers into the user-visible reply
 * e.g. `[P:commentary]: #` or `[P:final_answer]:`.
 */
export function scrubAgentChannelLeak(text: string): string {
  return text
    .replace(/^\s*\[P:(?:commentary|final_answer|thinking|response)\]\s*:?\s*#?\s*/gim, '')
    .trim();
}

/**
 * Narrative replies that stop after a preamble or channel tag (shared across modes).
 */
export function looksLikeTruncatedAssistantReply(text: string): boolean {
  return !text.trim();
}

/** Stream chunk soft filter (thought / status). */
export function applyChatStreamFilter(chunk: string): string {
  const secrets = redactPatterns(chunk, SECRET_PATTERNS, 'SECRET');
  return secrets.text;
}

export function shouldExcludeFromModelContext(message: Pick<SessionMessage, 'role' | 'content' | 'model_exclude'>): boolean {
  return message.model_exclude === true;
}

/**
 * Keep history unless an explicit structural flag excludes a message.
 */
export function sanitizeHistoryForModel<T extends Pick<SessionMessage, 'role' | 'content' | 'model_exclude'>>(
  messages: T[],
): T[] {
  return messages.filter((m) => !shouldExcludeFromModelContext(m));
}
