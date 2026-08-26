import type { ChatResponse, RouteDecision } from '../../router/types.js';
import type { SessionStore } from '../../sessions/session-store.js';
import { loadUserOverrides } from '../../config/user-overrides.js';
import { extractUrlFromText } from '../../browser/browser-service.js';
import { runWebCrawl } from '../../browser/web-crawl-service.js';
import { appendAssistantReply } from '../assistant-reply.js';

export async function handleWebCrawlMode(opts: {
  cqrRoot: string;
  configPath: string;
  sessionStore: SessionStore;
  sessionId: string;
  message: string;
  routing: RouteDecision;
}): Promise<ChatResponse> {
  const { cqrRoot, configPath, sessionStore, sessionId, message, routing } = opts;
  const startUrl = extractUrlFromText(message);

  if (!startUrl) {
    const content = appendAssistantReply(sessionStore, sessionId, {
      content: '웹 크롤링을 위해 시작 URL이 필요합니다.\n\n예: `https://example.com` 사이트 전체 크롤',
      model: 'browser/web-crawl',
      mode: 'web_crawl',
    });
    return {
      role: 'assistant',
      content,
      mode: 'web_crawl',
      routing,
      model: 'browser/web-crawl',
    };
  }

  const cfg = loadUserOverrides(configPath);
  const maxMatch = message.match(/(\d+)\s*(?:페이지|pages?)/i);
  const maxPages = maxMatch ? Number(maxMatch[1]) : undefined;

  const run = () =>
    runWebCrawl({
      cqrRoot,
      sessionId,
      startUrl,
      maxPages,
      allowLocalhost: cfg.playwright_allow_localhost === true,
    });

  let result = await run();
  if (!result.ok) {
    result = await run();
  }

  const raw = result.ok
    ? [
        `**웹 크롤 완료** (${result.engine}, ${result.pages.length}페이지)`,
        '',
        result.pages
          .slice(0, 8)
          .map((p, i) => `${i + 1}. [${p.title || p.url}](${p.url})`)
          .join('\n'),
        result.pages.length > 8 ? `\n… 외 ${result.pages.length - 8}페이지` : '',
        result.reportPath ? `\n전체 보고서: ${result.reportPath}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    : `**웹 크롤 실패**\n\n${result.error ?? '알 수 없는 오류'}`;

  const content = appendAssistantReply(sessionStore, sessionId, {
    content: raw,
    model: 'browser/web-crawl',
    mode: 'web_crawl',
    emptyFallback: '웹 크롤 결과가 비어 있습니다. URL을 확인한 뒤 다시 시도하세요.',
  });

  return {
    role: 'assistant',
    content,
    mode: 'web_crawl',
    routing,
    model: 'browser/web-crawl',
    ...(result.reportPath
      ? {
          research: {
            id: `crawl-${Date.now()}`,
            url: result.reportPath,
            title: `Crawl: ${startUrl}`,
          },
        }
      : {}),
  };
}
