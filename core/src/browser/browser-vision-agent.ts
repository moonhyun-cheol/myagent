import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { ProviderStore } from '../providers/provider-store.js';
import { chatCompletionVision } from '../providers/vision-chat.js';
import { extractUrlFromText } from './browser-service.js';
import { isPlaywrightAvailable } from './playwright-probe.js';
import { PlaywrightSession } from './playwright-session.js';
import { loadUserOverrides } from '../config/user-overrides.js';
import { formatToolSelfCorrection } from '../agent/tool-self-correction.js';

const MAX_STEPS = 6;
const VISION_TOOLS = ['navigate', 'click', 'fill', 'screenshot', 'done', 'fail'] as const;

export interface BrowserVisionAgentResult {
  ok: boolean;
  content: string;
  imageUrls: string[];
  steps: number;
  error?: string;
}

interface VisionAction {
  action: (typeof VISION_TOOLS)[number];
  selector?: string;
  value?: string;
  url?: string;
  summary?: string;
  reason?: string;
}

function parseVisionAction(raw: string): VisionAction | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const doc = JSON.parse(raw.slice(start, end + 1)) as VisionAction;
    if (!doc.action || !VISION_TOOLS.includes(doc.action)) return null;
    return doc;
  } catch {
    return null;
  }
}

function screenshotPublicUrl(cqrRoot: string, sessionId: string, filename: string): string {
  return `/outputs/browser/${sessionId}/${filename}`;
}

function browserShotPath(cqrRoot: string, sessionId: string, name: string): string {
  const dir = path.join(cqrRoot, 'data', 'outputs', 'browser', sessionId);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

function toDataUrl(filePath: string): string {
  const buf = readFileSync(filePath);
  return `data:image/png;base64,${buf.toString('base64')}`;
}

const SYSTEM = [
  'You are a browser automation agent controlling headless Chromium via JSON actions.',
  'Reply with ONE JSON object only per turn.',
  'Schema: {"action":"navigate|click|fill|screenshot|done|fail","selector":"css","value":"text","url":"https://...","summary":"Korean result for user","reason":"on fail"}',
  'Rules:',
  '- Start with navigate if not on target page.',
  '- Use click/fill for forms and buttons; prefer stable selectors (#id, [name=], button text).',
  '- Use screenshot when user asked for capture or you need visual confirmation.',
  '- action=done when task complete; include summary in Korean.',
  '- action=fail if blocked (captcha/login required) with reason.',
  '- Max steps are limited; prefer direct actions.',
].join('\n');

export async function runBrowserVisionAgent(opts: {
  cqrRoot: string;
  configPath: string;
  providerStore: ProviderStore;
  sessionId: string;
  message: string;
  onStatus?: (text: string) => void;
}): Promise<BrowserVisionAgentResult> {
  if (!isPlaywrightAvailable(opts.cqrRoot)) {
    return {
      ok: false,
      content: 'Playwright가 설치되지 않았습니다. `tools\\bootstrap-playwright.ps1` 실행 후 다시 시도하세요.',
      imageUrls: [],
      steps: 0,
      error: 'playwright_missing',
    };
  }

  const targetUrl = extractUrlFromText(opts.message) ?? '';
  const cfg = loadUserOverrides(opts.configPath);
  const providerId = opts.providerStore.getDefaultId();
  if (!providerId) {
    return { ok: false, content: 'LLM 프로바이더가 설정되지 않았습니다.', imageUrls: [], steps: 0 };
  }
  const resolved = opts.providerStore.resolveProvider(providerId);
  if (!resolved) {
    return { ok: false, content: 'LLM 프로바이더를 불러올 수 없습니다.', imageUrls: [], steps: 0 };
  }

  const imageUrls: string[] = [];
  let session: PlaywrightSession | null = null;
  const history: string[] = [];
  let lastError = '';

  try {
    session = await PlaywrightSession.open({
      cqrRoot: opts.cqrRoot,
      headless: cfg.playwright_headless !== false,
      urlGuard: { allowLocalhost: cfg.playwright_allow_localhost === true },
    });

    for (let step = 1; step <= MAX_STEPS; step += 1) {
      opts.onStatus?.(`브라우저 에이전트 ${step}/${MAX_STEPS}…`);

      const shotName = `vision-step-${step}-${Date.now()}.png`;
      const shotAbs = browserShotPath(opts.cqrRoot, opts.sessionId, shotName);
      try {
        await session.screenshot(opts.cqrRoot, `data/outputs/browser/${opts.sessionId}/${shotName}`, opts.sessionId, {});
        const pub = screenshotPublicUrl(opts.cqrRoot, opts.sessionId, shotName);
        imageUrls.push(pub);
      } catch (e: unknown) {
        lastError = e instanceof Error ? e.message : String(e);
      }

      const userText = [
        `User task: ${opts.message}`,
        targetUrl ? `Target URL: ${targetUrl}` : '',
        history.length ? `Prior steps:\n${history.join('\n')}` : '',
        lastError ? `Last error: ${lastError}` : '',
        'Decide the next JSON action.',
      ]
        .filter(Boolean)
        .join('\n\n');

      let llmRaw: string;
      try {
        const out = await chatCompletionVision(
          resolved.baseUrl,
          resolved.secret.api_key,
          resolved.modelId,
          [
            { role: 'system', content: SYSTEM },
            {
              role: 'user',
              content: [
                { type: 'text', text: userText },
                { type: 'image_url', image_url: { url: toDataUrl(shotAbs), detail: 'low' } },
              ],
            },
          ],
          {
            timeoutMs: 120_000,
            wireApi: resolved.wireApi,
          },
        );
        llmRaw = out.content;
      } catch (e: unknown) {
        const err = e instanceof Error ? e.message : String(e);
        if (step < MAX_STEPS) {
          lastError = formatToolSelfCorrection('vision_agent', err, [...VISION_TOOLS]);
          continue;
        }
        return { ok: false, content: `비전 에이전트 LLM 오류: ${err}`, imageUrls, steps: step };
      }

      const action = parseVisionAction(llmRaw);
      if (!action) {
        lastError = formatToolSelfCorrection(
          'vision_parse',
          'Invalid JSON action from model',
          [...VISION_TOOLS],
        );
        continue;
      }

      if (action.action === 'done') {
        return {
          ok: true,
          content: action.summary?.trim() || '브라우저 작업을 완료했습니다.',
          imageUrls,
          steps: step,
        };
      }
      if (action.action === 'fail') {
        return {
          ok: false,
          content: action.reason?.trim() || action.summary?.trim() || '브라우저 작업에 실패했습니다.',
          imageUrls,
          steps: step,
          error: 'agent_fail',
        };
      }

      try {
        if (action.action === 'navigate') {
          const url = action.url || targetUrl;
          if (!url) throw new Error('navigate requires url');
          const nav = await session.navigate(url);
          history.push(`navigate ${url} → ${nav.title}`);
        } else if (action.action === 'click') {
          if (!action.selector) throw new Error('click requires selector');
          const msg = await session.click(action.selector);
          history.push(msg);
        } else if (action.action === 'fill') {
          if (!action.selector) throw new Error('fill requires selector');
          const msg = await session.fill(action.selector, action.value ?? '');
          history.push(msg);
        } else if (action.action === 'screenshot') {
          history.push(`screenshot saved ${shotName}`);
        }
        lastError = '';
      } catch (e: unknown) {
        lastError = e instanceof Error ? e.message : String(e);
        history.push(`ERROR: ${lastError}`);
      }
    }

    return {
      ok: true,
      content: '브라우저 에이전트가 최대 단계에 도달했습니다. 마지막 스크린샷을 확인하세요.',
      imageUrls,
      steps: MAX_STEPS,
    };
  } finally {
    await session?.close();
  }
}
