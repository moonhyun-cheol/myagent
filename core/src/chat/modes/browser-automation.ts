import type { ChatResponse, RouteDecision } from '../../router/types.js';
import type { SessionStore } from '../../sessions/session-store.js';
import { loadUserOverrides } from '../../config/user-overrides.js';
import { extractUrlFromText } from '../../browser/browser-service.js';
import { browserScreenshotViaMcp } from '../../browser/playwright-mcp-bridge.js';
import { appendAssistantReply } from '../assistant-reply.js';

export async function handleBrowserAutomationMode(opts: {
  cqrRoot: string;
  configPath: string;
  sessionStore: SessionStore;
  sessionId: string;
  message: string;
  routing: RouteDecision;
}): Promise<ChatResponse> {
  const { cqrRoot, configPath, sessionStore, sessionId, message, routing } = opts;
  const targetUrl = extractUrlFromText(message);

  if (!targetUrl) {
    const content = appendAssistantReply(sessionStore, sessionId, {
      content: '브라우저 자동화를 위해 URL이 필요합니다.\n\n예: `https://example.com` 스크린샷 찍어줘',
      model: 'browser/playwright',
      mode: 'browser_automation',
    });
    return {
      role: 'assistant',
      content,
      mode: 'browser_automation',
      routing,
      model: 'browser/playwright',
    };
  }

  const cfg = loadUserOverrides(configPath);
  let shot = await browserScreenshotViaMcp(targetUrl, {
    cqrRoot,
    headless: cfg.playwright_headless !== false,
    allowLocalhost: cfg.playwright_allow_localhost === true,
    sessionId,
  });
  if (!shot.ok || !shot.url) {
    shot = await browserScreenshotViaMcp(targetUrl, {
      cqrRoot,
      headless: cfg.playwright_headless !== false,
      allowLocalhost: cfg.playwright_allow_localhost === true,
      sessionId,
    });
  }

  if (!shot.ok || !shot.url) {
    const content = appendAssistantReply(sessionStore, sessionId, {
      content: `**브라우저 스크린샷 실패**\n\n${shot.error ?? '알 수 없는 오류'}`,
      model: 'browser/playwright',
      mode: 'browser_automation',
    });
    return {
      role: 'assistant',
      content,
      mode: 'browser_automation',
      routing,
      model: 'browser/playwright',
    };
  }

  const content = appendAssistantReply(sessionStore, sessionId, {
    content: [
      `**${shot.title ?? '페이지'}** 스크린샷을 저장했습니다.`,
      '',
      `URL: ${shot.page_url ?? targetUrl}`,
    ].join('\n'),
    model: 'browser/playwright',
    mode: 'browser_automation',
    image_urls: [shot.url],
  });
  return {
    role: 'assistant',
    content,
    mode: 'browser_automation',
    routing,
    model: 'browser/playwright',
    image: { url: shot.url },
    images: [{ url: shot.url }],
  };
}
