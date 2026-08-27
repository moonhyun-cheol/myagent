import type { ChatMode, ChatRequest } from '../router/types.js';
import { isUserSkillMode } from '../skills/user-skill-store.js';
import { isOrgSkillMode } from '../skills/organization-skill-store.js';

export function parseChatRequest(raw: string): ChatRequest {
  const doc = JSON.parse(raw) as ChatRequest;
  if (!doc.message || typeof doc.message !== 'string') {
    throw new Error('INVALID_CHAT_REQUEST');
  }
  return doc;
}

const ALL_MODES: ChatMode[] = [
  'image_gen',
  'deep_research',
  'web_dev',
  'web_landing',
  'prompt_master',
  'browser_automation',
  'browser_agent',
  'web_crawl',
  'automaton_direct',
];

export function normalizeMode(mode?: string): ChatMode | null {
  if (!mode || mode === 'chat') return null;
  if (mode === 'code_agent') return 'web_dev';
  if (ALL_MODES.includes(mode as ChatMode)) return mode as ChatMode;
  if (isUserSkillMode(mode) || isOrgSkillMode(mode)) return mode as ChatMode;
  return null;
}

export function statusLabelForMode(mode: ChatMode): string {
  switch (mode) {
    case 'web_dev':
      return '코드 에이전트 · 도구 실행 중…';
    case 'web_landing':
      return '랜딩 페이지 제작 중…';
    case 'prompt_master':
      return '프롬프트 작성 중…';
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
      if (isUserSkillMode(mode) || isOrgSkillMode(mode)) return '스킬 답변 생성 중…';
      return '답변 생성 중…';
  }
}
