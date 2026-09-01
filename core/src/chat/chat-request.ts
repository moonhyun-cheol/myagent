import type { ChatMode, ChatRequest } from '../router/types.js';
import { isUserSkillMode } from '../skills/user-skill-store.js';

export function parseChatRequest(raw: string): ChatRequest {
  const doc = JSON.parse(raw) as ChatRequest;
  if (!doc.message || typeof doc.message !== 'string') {
    throw new Error('INVALID_CHAT_REQUEST');
  }
  // Entry-point normalization: legacy specialized modes are read-compat only.
  // Old sessions/clients may still send them; convert once here, never store back.
  const legacyMode = doc.mode as string | undefined;
  if (legacyMode === 'code_agent' || legacyMode === 'web_landing') doc.mode = 'web_dev';
  else if (legacyMode === 'prompt_master') doc.mode = 'chat';
  return doc;
}

const ALL_MODES: ChatMode[] = [
  'image_gen',
  'deep_research',
  'web_dev',
  'browser_automation',
  'browser_agent',
  'web_crawl',
  'automaton_direct',
];

export function normalizeMode(mode?: string): ChatMode | null {
  if (!mode || mode === 'chat') return null;
  if (mode === 'code_agent') return 'web_dev';
  // Legacy specialized modes removed — landing work runs in web_dev, prompt asks in normal chat.
  if (mode === 'web_landing') return 'web_dev';
  if (mode === 'prompt_master') return null;
  if (ALL_MODES.includes(mode as ChatMode)) return mode as ChatMode;
  if (isUserSkillMode(mode)) return mode as ChatMode;
  return null;
}

export function statusLabelForMode(mode: ChatMode): string {
  switch (mode) {
    case 'web_dev':
      return '코드 에이전트 · 도구 실행 중…';
    case 'deep_research':
      return '심층 리서치 중…';
    case 'image_gen':
      return '이미지 생성 중…';
    case 'browser_automation':
      return '브라우저 스크린샷 중…';
    case 'browser_agent':
      return '브라우저 에이전트 실행 중…';
    case 'web_crawl':
      return '웹 크롤링 중…';
    case 'automaton_direct':
      return '업무 명령 접수…';
    default:
      if (isUserSkillMode(mode)) return '스킬 답변 생성 중…';
      return '답변 생성 중…';
  }
}
