/**
 * Multimodal defaults (B): attachments, images, seeded diagnostics for code agent.
 */
import type { ChatContentPart, ChatMessage } from '../providers/openai-compatible.js';
import { wrapUserMessageWithContext } from '../chat/chat-context.js';
import { runWorkspaceDiagnostics } from './run-diagnostics.js';

const ERRORISH_RE =
  /(?:\berror\b|\bError\b|Exception|traceback|TypeError|ReferenceError|SyntaxError|TS\d{3,5}|FAIL|failed|실패|에러|진단|diagnostics|stack\s*trace|Cannot find|undefined is not|not a function)/i;

const LOGISH_ATTACH_RE =
  /(?:\.log\b|\.txt\b|stderr|stdout|tsc|eslint|build|compile|stack|trace)/i;

export function messageLooksErrorish(message: string): boolean {
  return ERRORISH_RE.test(message);
}

export function attachmentLooksLikeLog(attachmentContext: string | undefined): boolean {
  if (!attachmentContext?.trim()) return false;
  return LOGISH_ATTACH_RE.test(attachmentContext) || ERRORISH_RE.test(attachmentContext);
}

/** Run diagnostics once when the user pasted an error / log (budget-capped). */
export function seedDiagnosticsContext(
  workspaceRoot: string,
  userMessage: string,
  attachmentContext?: string,
  maxChars = 6_000,
): string {
  const attach = attachmentContext?.trim() ?? '';
  // Attachment already carries the failure evidence — don't burn another tsc run.
  if (attach.length > 200 && (attachmentLooksLikeLog(attach) || messageLooksErrorish(attach))) {
    return [
      '## Attachment log (treat as primary diagnostics evidence)',
      'Call run_diagnostics after edits to verify; do not ignore the attached error text.',
    ].join('\n');
  }
  if (!messageLooksErrorish(userMessage)) {
    return '';
  }
  try {
    const raw = runWorkspaceDiagnostics(workspaceRoot, { timeoutMs: 20_000 });
    const body = raw.length > maxChars ? `${raw.slice(0, maxChars)}\n… (truncated)` : raw;
    return [
      '## Seeded diagnostics (auto — treat as evidence, re-run after edits)',
      '```json',
      body,
      '```',
    ].join('\n');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return `## Seeded diagnostics\n(unavailable: ${msg.slice(0, 200)})`;
  }
}

export function buildCodeAgentUserContent(
  userMessage: string,
  attachmentContext: string | undefined,
  imageDataUrls: string[] | undefined,
): ChatMessage['content'] {
  const text = wrapUserMessageWithContext(userMessage, attachmentContext);
  const images = (imageDataUrls ?? []).filter((u) => typeof u === 'string' && u.startsWith('data:'));
  if (!images.length) return text;
  const parts: ChatContentPart[] = [{ type: 'text', text }];
  for (const url of images.slice(0, 4)) {
    parts.push({ type: 'image_url', image_url: { url, detail: 'auto' } });
  }
  return parts;
}

export function formatMultimodalSystemNote(
  hasImages: boolean,
  hasAttachmentText: boolean,
  hasSeededDiag: boolean,
): string {
  if (!hasImages && !hasAttachmentText && !hasSeededDiag) return '';
  return [
    '## Multimodal inputs (first-class)',
    hasImages
      ? '- User message may include screenshot/image parts and/or video keyframes — use them as primary visual evidence (do not invent scenes you cannot see).'
      : '',
    hasAttachmentText
      ? '- Attachment text/logs/video notes are in the user turn — quote paths/errors/frame notes from them before guessing.'
      : '',
    hasSeededDiag
      ? '- Seeded diagnostics JSON is above — fix real failures; do not invent clean builds.'
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}
