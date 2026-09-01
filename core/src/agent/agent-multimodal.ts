/**
 * Multimodal defaults (B): attachments, images, seeded diagnostics for code agent.
 */
import type { ChatContentPart, ChatMessage } from '../providers/openai-compatible.js';
import { wrapUserMessageWithContext } from '../chat/chat-context.js';

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
