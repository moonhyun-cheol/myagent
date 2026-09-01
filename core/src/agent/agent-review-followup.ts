/**
 * After an acceptance/structure review, user says 「전부 수정」/「추가 수정」—
 * continue from prior assistant gaps instead of asking which files.
 */
import { isPlaceholderNavUrl } from '../browser/browser-service.js';
import { looksLikeAutopilotContinue } from './agent-autopilot-intent.js';

const EXECUTE_PRIOR_REVIEW_RE =
  /^(?:전부\s*수정|모두\s*수정|다\s*고쳐|위\s*(?:내용|항목|미충족).{0,12}수정|미충족.{0,16}수정|추가\s*수정(?:\s*실행)?|개선안\s*(?:대로\s*)?(?:수정|적용|반영)|리뷰\s*(?:대로|결과).{0,8}(?:수정|반영)|fix\s*all|apply\s*(?:the\s*)?(?:fixes|gaps)|address\s*(?:the\s*)?gaps)\s*[.!]?\s*$/i;

const EXECUTE_PRIOR_LOOSE_RE =
  /(?:전부\s*수정|추가\s*수정(?:\s*실행)?|미충족\s*(?:항목\s*)?(?:부터\s*)?수정|개선안\s*적용|위\s*三项|위\s*세\s*가지|1\s*[.、)]\s*.{0,40}ignoreHTTPS)/i;

/** Short execute-follow-up after a review turn. */
export function looksLikeExecutePriorReview(message: string): boolean {
  const t = String(message || '').trim();
  if (!t || t.length > 120) return EXECUTE_PRIOR_LOOSE_RE.test(t) && t.length < 200;
  return EXECUTE_PRIOR_REVIEW_RE.test(t) || EXECUTE_PRIOR_LOOSE_RE.test(t);
}

function lastAssistantContent(
  history?: Array<{ role?: string; content?: string }> | null,
): string {
  if (!history?.length) return '';
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m?.role === 'assistant' && String(m.content || '').trim()) {
      return String(m.content);
    }
  }
  return '';
}

/** True when prior assistant looks like a review with gaps / next steps. */
export function priorAssistantHasReviewGaps(content: string): boolean {
  const t = content.trim();
  if (!t) return false;
  return (
    /###\s*미충족|미충족\s*\d|다음\s*수정|VERDICT\s*:\s*(?:PARTIAL|FAIL)|부분\s*충족|개선안/i.test(t)
    || /ignoreHTTPSErrors|실기기|test:compatibility|playwright\.config/i.test(t)
  );
}

function scrubPlaceholderUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s<>"')\]]+/gi, (url) => {
    const cleaned = url.replace(/[.,;:!?)]+$/, '');
    return isPlaceholderNavUrl(cleaned) ? '[PLACEHOLDER_URL — do not open/test]' : url;
  });
}

export function extractReviewGapsBrief(content: string, maxChars = 3500): string {
  const t = content.trim();
  if (!t) return '';
  // Prefer ### 미충족 … through ### 다음 or end
  const m =
    t.match(/###\s*미충족[\s\S]{0,4000}?(?=###\s*다음|VERDICT\s*:|$)/i)
    || t.match(/(?:미충족|다음\s*수정)[\s\S]{0,3500}/i);
  const chunk = scrubPlaceholderUrls((m?.[0] || t).trim());
  return chunk.length > maxChars ? `${chunk.slice(0, maxChars)}\n…` : chunk;
}

/**
 * If user asks to fix everything from the prior review, return an expanded
 * user message that pins the gaps. Otherwise null.
 */
export function expandExecutePriorReviewMessage(
  message: string,
  history?: Array<{ role?: string; content?: string }> | null,
): string | null {
  const continueHit = looksLikeExecutePriorReview(message) || looksLikeAutopilotContinue(message);
  if (!continueHit) return null;
  const prior = lastAssistantContent(history);
  if (!priorAssistantHasReviewGaps(prior)) return null;
  const gaps = extractReviewGapsBrief(prior);
  return [
    '이전 검토의 미충족 항목을 지금 전부 수정·반영하세요. 파일을 묻지 말고 바로 mutate 하세요.',
    '금지: 「어떤 파일/코드를 수정할까요?」재질문.',
    '자리표시자 URL(https://대상-주소, example.com)로 브라우저/테스트 실행 금지 — 로컬/실제 URL만.',
    'Autopilot/연속 실행: 「다음 조치」로 끊지 말고 이 턴에서 닫으세요.',
    '',
    '## 이전 검토에서 닫을 Exit Gate / 미충족',
    gaps,
  ].join('\n');
}

export function formatExecutePriorReviewSystemNote(): string {
  return [
    '## Execute prior review (no clarify)',
    'The user approved applying the previous review gaps.',
    'Do NOT ask which files to edit. Read the listed paths, mutate with tools, verify.',
    'Never navigate or test placeholder URLs like https://대상-주소 or https://example.com.',
    'If a live URL is missing, fix config/code for local HTTP and note 미검증 for remote HTTPS.',
  ].join('\n');
}

/** Apply prior-review expansion onto agent options (message + system note). */
export function withExecutePriorReviewExpansion<
  T extends {
    userMessage: string;
    history?: Array<{ role?: string; content?: string }> | null;
    extraSystemNotes?: string[];
    cqrRoot?: string;
    sessionId?: string;
  },
>(opts: T): T {
  const expanded = expandExecutePriorReviewMessage(opts.userMessage, opts.history);
  if (!expanded) return opts;
  return {
    ...opts,
    userMessage: expanded,
    extraSystemNotes: [...(opts.extraSystemNotes ?? []), formatExecutePriorReviewSystemNote()],
  };
}
