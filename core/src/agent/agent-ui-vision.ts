/**
 * Classify UI screenshots before code edits (agent grounding #3).
 */
import { chatCompletionVision } from '../providers/vision-chat.js';

export type UiVisionTarget = 'title_bar' | 'confirm' | 'composer' | 'sidebar' | 'unknown';

export type UiVisionClassifyResult = {
  target: UiVisionTarget;
  reason: string;
  source: 'vision' | 'heuristic' | 'none';
  /** Raw Open WebUI / vision model reply when available (for thought log). */
  raw?: string;
};

const VISION_PROMPT = [
  'You classify which MY Agent UI region the screenshot shows.',
  'Reply with ONE JSON object only, no markdown:',
  '{"target":"title_bar"|"confirm"|"composer"|"sidebar"|"unknown","reason":"short"}',
  'Definitions:',
  '- title_bar: OS/app window caption with min/max/close, text like MY Agent or MY Agent',
  '- confirm: dialog with 확인/취소 or "삭제할까요"',
  '- composer: chat input, send/stop, Agent header inside the app',
  '- sidebar: left nav / conversation list',
  '- unknown: cannot tell',
].join('\n');

export function parseUiVisionTarget(raw: string): UiVisionClassifyResult | null {
  const text = raw.trim();
  if (!text) return null;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]) as { target?: string; reason?: string };
      const target = normalizeTarget(obj.target);
      if (target) {
        return {
          target,
          reason: String(obj.reason ?? '').slice(0, 200) || 'vision json',
          source: 'vision',
        };
      }
    } catch {
      /* fall through */
    }
  }
  return heuristicFromText(text);
}

function normalizeTarget(raw: string | undefined): UiVisionTarget | null {
  const t = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
  if (t === 'title_bar' || t === 'titlebar' || t === 'caption') return 'title_bar';
  if (t === 'confirm' || t === 'dialog' || t === 'modal' || t === 'alert') return 'confirm';
  if (t === 'composer' || t === 'chat' || t === 'agent_header') return 'composer';
  if (t === 'sidebar' || t === 'nav') return 'sidebar';
  if (t === 'unknown') return 'unknown';
  return null;
}

function heuristicFromText(text: string): UiVisionClassifyResult | null {
  if (/(?:title_bar|타이틀바|MY Agent|최소화|닫기)/i.test(text)) {
    return { target: 'title_bar', reason: 'heuristic keywords', source: 'heuristic' };
  }
  if (/(?:confirm|삭제할까요|확인|취소)/i.test(text)) {
    return { target: 'confirm', reason: 'heuristic keywords', source: 'heuristic' };
  }
  if (/(?:composer|입력창|전송|중지)/i.test(text)) {
    return { target: 'composer', reason: 'heuristic keywords', source: 'heuristic' };
  }
  if (/(?:sidebar|사이드바)/i.test(text)) {
    return { target: 'sidebar', reason: 'heuristic keywords', source: 'heuristic' };
  }
  return null;
}

/** Heuristic from user text alone (no image). */
export function classifyUiTargetFromMessage(message: string): UiVisionClassifyResult {
  if (/(?:타이틀바|title\s*bar|위에\s*바|상단\s*바|프로그램명|창\s*제목|CQR\s*Agent)/i.test(message)) {
    return { target: 'title_bar', reason: 'message keywords', source: 'heuristic' };
  }
  if (/(?:삭제할까요|확인창|다이얼로그|confirm)/i.test(message)) {
    return { target: 'confirm', reason: 'message keywords', source: 'heuristic' };
  }
  if (/(?:입력창|composer|전송|중지|Agent\s*헤더)/i.test(message)) {
    return { target: 'composer', reason: 'message keywords', source: 'heuristic' };
  }
  if (/(?:사이드바|대화\s*목록)/i.test(message)) {
    return { target: 'sidebar', reason: 'message keywords', source: 'heuristic' };
  }
  return { target: 'unknown', reason: 'no keywords', source: 'none' };
}

export async function classifyUiScreenshot(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  imageDataUrls: string[];
  signal?: AbortSignal;
}): Promise<UiVisionClassifyResult> {
  if (!opts.imageDataUrls.length) {
    return { target: 'unknown', reason: 'no image', source: 'none' };
  }
  try {
    const parts: Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string; detail: 'low' } }
    > = [{ type: 'text', text: VISION_PROMPT }];
    for (const url of opts.imageDataUrls.slice(0, 2)) {
      parts.push({ type: 'image_url', image_url: { url, detail: 'low' } });
    }
    const out = await chatCompletionVision(
      opts.baseUrl,
      opts.apiKey,
      opts.model,
      [
        { role: 'system', content: 'UI region classifier. JSON only.' },
        { role: 'user', content: parts },
      ],
      { signal: opts.signal },
    );
    const raw = out.content?.trim() || '';
    const parsed = parseUiVisionTarget(out.content);
    if (parsed) return { ...parsed, raw: raw || undefined };
    return {
      target: 'unknown',
      reason: 'unparsed vision',
      source: 'vision',
      raw: raw || undefined,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { target: 'unknown', reason: `vision failed: ${msg.slice(0, 120)}`, source: 'none' };
  }
}

export function visionTargetToBootstrapPath(
  target: UiVisionTarget,
  factsTargets?: {
    title_bar?: string[];
    delete_confirm?: string[];
    composer?: string[];
  },
): string | null {
  if (target === 'title_bar') return factsTargets?.title_bar?.[0] ?? 'shell/CqrPa.Shell/MainWindow.xaml';
  if (target === 'confirm') {
    return factsTargets?.delete_confirm?.[0] ?? 'ui/workspace/src/components/ConfirmModal.tsx';
  }
  if (target === 'composer') {
    return factsTargets?.composer?.[0] ?? 'ui/workspace/src/components/ChatPane.tsx';
  }
  if (target === 'sidebar') return 'ui/workspace/src/components/GeminiNavSidebar.tsx';
  return null;
}
