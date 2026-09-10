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
export const BROWSER_VISION_TIER1_ACTIONS = [
  'navigate',
  'snapshot',
  'find_in_page',
  'scroll',
  'read_text',
  'extract',
  'click',
  'fill',
  'screenshot',
  'done',
  'fail',
] as const;
export const BROWSER_VISION_TIER2_ACTIONS = [
  'wait_for',
  'select',
  'key',
  'go_back',
  'forward',
  'reload',
  'upload_file',
] as const;
export const BROWSER_VISION_TIER3_ACTIONS = [
  'get_console_logs',
  'eval_js',
  'download',
  'take_over',
] as const;
export const BROWSER_VISION_ACTIONS = [
  ...BROWSER_VISION_TIER1_ACTIONS,
  ...BROWSER_VISION_TIER2_ACTIONS,
  ...BROWSER_VISION_TIER3_ACTIONS,
] as const;
const VISION_TOOLS = BROWSER_VISION_ACTIONS;

export interface BrowserVisionAgentResult {
  ok: boolean;
  content: string;
  imageUrls: string[];
  steps: number;
  error?: string;
  handoff?: { url: string; title: string };
  downloaded?: { path: string; relative: string; filename: string };
}

interface VisionAction {
  action: (typeof VISION_TOOLS)[number];
  selector?: string;
  ref?: string;
  snapshot_id?: string;
  value?: string;
  url?: string;
  text?: string;
  direction?: 'up' | 'down' | 'to-element' | 'to-text';
  amount?: number;
  mode?: 'text' | 'table';
  state?: 'attached' | 'visible' | 'hidden' | 'detached';
  timeout_ms?: number;
  key?: string;
  file_path?: string;
  expression?: string;
  clear?: boolean;
  summary?: string;
  reason?: string;
}

export function parseBrowserVisionAction(raw: string): VisionAction | null {
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
  'Schema: {"action":"navigate|snapshot|find_in_page|scroll|read_text|extract|click|fill|screenshot|wait_for|select|key|go_back|forward|reload|upload_file|get_console_logs|eval_js|download|take_over|done|fail","selector":"css","ref":"e1","snapshot_id":"isolated-1","text":"target text","direction":"up|down|to-element|to-text","amount":700,"mode":"text|table","state":"visible|attached|hidden|detached","timeout_ms":5000,"key":"Enter","file_path":"absolute path under app data","expression":"isolated JS","clear":false,"value":"text","url":"https://...","summary":"Korean result for user","reason":"on fail"}',
  'Rules:',
  '- Start with navigate if not on target page.',
  '- Prefer snapshot then ref-based click to guessing coordinates or fragile selectors.',
  '- Use find_in_page or scroll when the target may be outside the viewport.',
  '- Use read_text for page/element text and extract with mode=table for tables; do not infer text from the low-detail image.',
  '- A click may use ref from the latest snapshot (with snapshot_id) or a stable selector.',
  '- Use wait_for for an explicit selector or URL; use select/key for form controls and keyboard interaction.',
  '- Use go_back/forward/reload for history, upload_file only for an existing app-data path, and download with a selector.',
  '- get_console_logs returns bounded console/network failures. eval_js is isolated-only and requires the caller approval gate.',
  '- take_over ends automation and returns the current URL for the existing user-initiated visible-tab handoff path.',
  '- Use screenshot when user asked for capture or you need visual confirmation.',
  '- action=done when task complete; include summary in Korean.',
  '- action=fail if blocked (captcha/login required) with reason.',
  '- The six-step budget includes observations. Choose the narrowest action that makes progress and avoid repeated snapshots.',
].join('\n');

export async function runBrowserVisionAgent(opts: {
  cqrRoot: string;
  configPath: string;
  providerStore: ProviderStore;
  sessionId: string;
  message: string;
  onStatus?: (text: string) => void;
  /** Explicit caller-side approval. Raw JS stays disabled unless HITL approved it. */
  allowEvaluate?: boolean;
}): Promise<BrowserVisionAgentResult> {
  if (!isPlaywrightAvailable(opts.cqrRoot)) {
    return {
      ok: false,
      content: 'Playwright 실행 환경을 사용할 수 없습니다.',
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

      const action = parseBrowserVisionAction(llmRaw);
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
        } else if (action.action === 'snapshot') {
          const snapshot = await session.snapshot();
          history.push(`snapshot ${snapshot.snapshot_id} (${snapshot.ref_count} refs)\n${snapshot.tree}`);
        } else if (action.action === 'find_in_page') {
          if (!action.text) throw new Error('find_in_page requires text');
          const found = await session.findInPage(action.text);
          history.push(`find_in_page ${action.text} → ${JSON.stringify(found)}`);
        } else if (action.action === 'scroll') {
          const direction = action.direction ?? 'down';
          const msg = await session.scroll({
            direction,
            amount: action.amount,
            selector: action.selector,
            text: action.text,
          });
          history.push(msg);
        } else if (action.action === 'read_text' || action.action === 'extract') {
          const mode = action.action === 'extract' ? (action.mode ?? 'table') : (action.mode ?? 'text');
          const text = await session.readText(action.selector, mode);
          history.push(`${action.action}${action.selector ? ` ${action.selector}` : ''} →\n${text}`);
        } else if (action.action === 'click') {
          if (action.ref) {
            const msg = await session.clickRef(action.ref, action.snapshot_id);
            history.push(`${msg} via ref ${action.ref}`);
          } else {
            if (!action.selector) throw new Error('click requires ref or selector');
            const msg = await session.click(action.selector);
            history.push(msg);
          }
        } else if (action.action === 'fill') {
          if (!action.selector) throw new Error('fill requires selector');
          const msg = await session.fill(action.selector, action.value ?? '');
          history.push(msg);
        } else if (action.action === 'wait_for') {
          const msg = await session.waitFor({
            selector: action.selector,
            url: action.url,
            state: action.state,
            timeoutMs: action.timeout_ms,
          });
          history.push(msg);
        } else if (action.action === 'select') {
          if (!action.selector) throw new Error('select requires selector');
          const msg = await session.select(action.selector, action.value ?? '');
          history.push(msg);
        } else if (action.action === 'key') {
          if (!action.key) throw new Error('key requires key');
          history.push(await session.pressKey(action.key, action.selector));
        } else if (action.action === 'go_back') {
          history.push(`go_back → ${JSON.stringify(await session.history('back'))}`);
        } else if (action.action === 'forward') {
          history.push(`forward → ${JSON.stringify(await session.history('forward'))}`);
        } else if (action.action === 'reload') {
          history.push(`reload → ${JSON.stringify(await session.history('reload'))}`);
        } else if (action.action === 'upload_file') {
          if (!action.selector || !action.file_path) throw new Error('upload_file requires selector and file_path');
          history.push(await session.uploadFile(action.selector, action.file_path));
        } else if (action.action === 'get_console_logs') {
          history.push(`console/network diagnostics → ${JSON.stringify(session.getConsoleLogs(action.clear === true))}`);
        } else if (action.action === 'eval_js') {
          if (!opts.allowEvaluate) throw new Error('BROWSER_EVALUATE_APPROVAL_REQUIRED');
          if (!action.expression) throw new Error('eval_js requires expression');
          history.push(`eval_js → ${await session.evaluate(action.expression)}`);
        } else if (action.action === 'download') {
          if (!action.selector) throw new Error('download requires selector');
          const downloaded = await session.download(action.selector, opts.sessionId);
          return {
            ok: true,
            content: action.summary?.trim() || `다운로드를 저장했습니다: ${downloaded.filename}`,
            imageUrls,
            steps: step,
            downloaded,
          };
        } else if (action.action === 'take_over') {
          const handoff = await session.handoffState();
          if (!handoff) throw new Error('BROWSER_TAKE_OVER_URL_UNAVAILABLE');
          return {
            ok: true,
            content: action.summary?.trim() || '현재 페이지를 사용자가 볼 수 있도록 인계할 준비가 됐습니다.',
            imageUrls,
            steps: step,
            handoff,
          };
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
