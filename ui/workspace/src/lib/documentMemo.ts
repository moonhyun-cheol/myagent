import type { ChatTurn } from '../types';

/** Prefix for document sticky-note asks — restored sessions stay out of ChatPane. */
export const DOCUMENT_MEMO_MARKER = '<!--my-agent:document-memo-->\n';

const MEMO_ASK_RE =
  /다음 문서 선택 구간에 대해 답해\s*줘[\s\S]*짧고 메모처럼 설명해/;

/** True when this user (or restored) message is an AI-memo side-channel ask. */
export function isDocumentMemoMessage(text: string): boolean {
  const t = String(text || '');
  if (!t.trim()) return false;
  if (t.includes('<!--my-agent:document-memo-->')) return true;
  return MEMO_ASK_RE.test(t);
}

/**
 * Hide document AI-memo Q&A from the main chat transcript.
 * Uses explicit uiHidden, marker, classic ask wording, and assistant-follows-memo-user.
 */
export function isChatTurnUiHidden(turn: ChatTurn, chat: ChatTurn[]): boolean {
  if (turn.uiHidden) return true;
  if (turn.role === 'user' && isDocumentMemoMessage(turn.text)) return true;
  if (turn.role === 'assistant') {
    const idx = chat.findIndex((t) => t.id === turn.id);
    const prev = idx > 0 ? chat[idx - 1] : null;
    if (prev?.role === 'user' && (prev.uiHidden || isDocumentMemoMessage(prev.text))) return true;
  }
  return false;
}
