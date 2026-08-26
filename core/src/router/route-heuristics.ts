import type { RouteDecision } from './types.js';
import {
  blocksSpecializedPipelineModes,
  looksLikeInspectFilesTask,
  looksLikeProductBuildTask,
  inspectFilesPreferredMode,
  productBuildPreferredMode,
  hasResearchIntentSignal,
} from './route-task-gate.js';

export {
  looksLikeInspectFilesTask,
  looksLikeProductBuildTask,
  blocksSpecializedPipelineModes,
  evaluateSpecializedModeFit,
  isExplicitMarketSlash,
  hasResearchIntentSignal,
} from './route-task-gate.js';

export const URL_IN_MESSAGE_RE = /https?:\/\/[^\s<>"')\]]+/i;

export const BROWSER_CAPTURE_RE =
  /스크린샷|캡처|캡쳐|screenshot|capture|사이트\s*캡|webpage|페이지\s*캡/i;

/** Real page interaction — not vague "에이전트/자동화" (those steal code-agent traffic). */
const BROWSER_INTERACTIVE_CORE_RE =
  /로그인|클릭|click|fill|입력|submit|검색|form|버튼\s*클릭|상호작용/i;

const BROWSER_AGENT_WORD_RE = /자동화|에이전트|agent|비전|vision/i;

const BROWSER_CONTEXT_RE = /브라우저|browser|웹\s*페이지|webpage|사이트에서|페이지에서/i;

const WEB_CRAWL_RE =
  /크롤|crawl|sitemap|여러\s*페이지|링크\s*수집|사이트\s*전체|spider|페이지\s*수집/i;
const BROWSER_OPEN_RE = /열어|open|visit|접속|browse/i;
const FILE_CODE_HINT_RE = /(?:파일|file|\.py|\.js|\.ts|\.tsx|\.jsx|\.html|\.css|코드|edit|수정|write|script)/i;

/** Local app / workspace UI edit — never browser_agent. */
const UI_EDIT_HINT_RE =
  /(?:채팅창|레이아웃|사이드바|컴포저|composer|undo|전송\s*버튼|작업\s*폴더|ui\/|css|테마|패널|뷰포트)/i;

const PROMPT_MASTER_RE =
  /프롬프트|prompt engineering|superprompt|midjourney|dalle|stable diffusion|seedream|네거티브 프롬|cursor prompt|adapt prompt/i;

const IMAGE_GEN_RE =
  /(?:그려|그림\s*(?:그려|만들)|이미지\s*(?:만들|생성|그려)|일러스트|로고\s*(?:만들|그려)|draw|generate image|illustration)/i;

/** Bare 「타당성확인」(secretary verify) must not steal market routing. */
const MARKET_RE =
  /시장조사|시장\s*타당성|타당성\s*(?:조사|분석|검토|연구)|경쟁사|feasibility|market research/i;

const DEEP_RESEARCH_RE =
  /심층\s*리서치|딥\s*리서치|deep research|다중\s*출처|출처.*(?:조사|리서치)|investigate.*sources/i;

const CONCEPT_RE =
  /컨셉|무드\s*보드|룩북|촬영\s*브리프|lookbook|mood board|shoot brief|로드아웃|브랜드에\s*맞는|제품\s*(?:컨셉|추천)|라인\s*컨셉|촬영\s*컨셉/i;

const WEB_LANDING_RE =
  /랜딩\s*페이지|랜딩페이지|웹\s*랜딩|landing\s*page|히어로\s*섹션|pricing\s*page|가격\s*페이지|프라이싱|마케팅\s*페이지|홍보\s*페이지|cta\s*섹션|conversion\s*page|히어로\s*만들|랜딩\s*제작|랜딩\s*만들/i;

const WEB_DEV_RE =
  /(?:코드|코딩|프로그래밍|버그\s*수정|refactor|codebase|\.(?:py|js|ts|tsx|jsx|html|css)\b|read_file|write_file|채팅창|레이아웃|사이드바|컴포저|composer|작업\s*폴더|툴\s*콜|tool[\s_-]?call|파일\s*(?:읽|쓰|수정)|익스텐션|익스탠션|확장\s*프로그램|chrome\s*extension|크롬\s*확장)/i;

function decision(
  mode: RouteDecision['mode'],
  tool: string,
  confidence: number,
): RouteDecision {
  return { mode, confidence, layer: 'L1', matched_tool: tool };
}

/** Fast-path: URL + capture/open intent → browser_automation (no LLM). */
export function matchBrowserCaptureRoute(message: string): RouteDecision | null {
  if (!URL_IN_MESSAGE_RE.test(message)) return null;

  if (BROWSER_CAPTURE_RE.test(message)) {
    return decision('browser_automation', 'browser_automation', 0.9);
  }

  if (BROWSER_OPEN_RE.test(message) && !FILE_CODE_HINT_RE.test(message)) {
    return decision('browser_automation', 'browser_automation', 0.82);
  }

  return null;
}

export function matchWebCrawlRoute(message: string): RouteDecision | null {
  if (!WEB_CRAWL_RE.test(message)) return null;
  if (BROWSER_CAPTURE_RE.test(message) && !WEB_CRAWL_RE.test(message)) return null;
  return decision('web_crawl', 'web_crawl', 0.86);
}

export function matchBrowserAgentRoute(message: string): RouteDecision | null {
  if (WEB_CRAWL_RE.test(message)) return null;
  // Workspace / UI edits must stay on code agent — "에이전트·버튼·입력" alone is not a live-page task.
  if (FILE_CODE_HINT_RE.test(message) || UI_EDIT_HINT_RE.test(message) || WEB_DEV_RE.test(message)) {
    return null;
  }
  if (BROWSER_CAPTURE_RE.test(message) && !BROWSER_INTERACTIVE_CORE_RE.test(message)) return null;

  const hasUrl = URL_IN_MESSAGE_RE.test(message);
  const hasBrowserCtx = hasUrl || BROWSER_CONTEXT_RE.test(message);

  if (BROWSER_INTERACTIVE_CORE_RE.test(message) && hasBrowserCtx) {
    return decision('browser_agent', 'browser_agent', 0.85);
  }

  // Vague "에이전트/자동화" only with URL or explicit browser wording.
  if (BROWSER_AGENT_WORD_RE.test(message) && hasBrowserCtx) {
    return decision('browser_agent', 'browser_agent', 0.82);
  }

  if (hasUrl && /로그인|검색|클릭|click|fill|submit|form/i.test(message)) {
    return decision('browser_agent', 'browser_agent', 0.84);
  }

  return null;
}

export function matchPromptMasterRoute(message: string): RouteDecision | null {
  if (!PROMPT_MASTER_RE.test(message)) return null;
  if (IMAGE_GEN_RE.test(message) && !/프롬프트/i.test(message)) return null;
  return decision('prompt_master', 'prompt_master', 0.84);
}

export function matchMarketResearchRoute(message: string): RouteDecision | null {
  if (blocksSpecializedPipelineModes(message)) return null;
  if (!MARKET_RE.test(message)) return null;
  return decision('deep_research', 'deep_research', 0.85);
}

export function matchDeepResearchRoute(message: string): RouteDecision | null {
  if (blocksSpecializedPipelineModes(message)) return null;
  if (!DEEP_RESEARCH_RE.test(message)) return null;
  if (MARKET_RE.test(message)) return null;
  return decision('deep_research', 'deep_research', 0.82);
}

export function matchConceptRoute(message: string): RouteDecision | null {
  if (blocksSpecializedPipelineModes(message)) return null;
  if (!CONCEPT_RE.test(message)) return null;
  if (MARKET_RE.test(message)) return null;
  return decision('chat', 'chat', 0.7);
}

export function matchImageGenRoute(message: string): RouteDecision | null {
  if (blocksSpecializedPipelineModes(message) && !IMAGE_GEN_RE.test(message)) return null;
  if (!IMAGE_GEN_RE.test(message)) return null;
  if (/프롬프트\s*(?:짜|작성|고쳐|개선)/i.test(message)) return null;
  return decision('image_gen', 'image_gen', 0.83);
}

/** UNC/NAS/양식 확인 — specialized research pipelines must lose. */
export function matchInspectFilesRoute(message: string): RouteDecision | null {
  if (!looksLikeInspectFilesTask(message)) return null;
  // Conflict with research wording outside path tokens → leave to fit-gate clarify.
  if (hasResearchIntentSignal(message)) {
    return null;
  }
  const mode = inspectFilesPreferredMode();
  return decision(mode, mode, 0.9);
}

/** Extension / address-parser / product build — never browser_agent. */
export function matchProductBuildRoute(message: string): RouteDecision | null {
  if (!looksLikeProductBuildTask(message)) return null;
  const mode = productBuildPreferredMode();
  return decision(mode, 'web_dev', 0.91);
}

export function matchWebLandingRoute(message: string): RouteDecision | null {
  if (!WEB_LANDING_RE.test(message) && !/\b랜딩\b/i.test(message)) return null;
  // Explicit product/code work without landing signals → not landing
  if (WEB_DEV_RE.test(message) && !/랜딩|landing|hero|pricing|히어로|프라이싱|cta/i.test(message)) {
    return null;
  }
  // Bare "랜딩" alone is enough for landing skill
  return decision('web_landing', 'web_landing', 0.8);
}

export function matchWebDevRoute(message: string): RouteDecision | null {
  if (!WEB_DEV_RE.test(message)) return null;
  if (WEB_LANDING_RE.test(message) && !WEB_DEV_RE.test(message)) return null;
  return decision('web_dev', 'web_dev', 0.78);
}

/** All rule-based fast routes (priority order). */
export function matchFastSkillRoutes(message: string): RouteDecision | null {
  return (
    matchBrowserCaptureRoute(message)
    ?? matchWebCrawlRoute(message)
    ?? matchInspectFilesRoute(message)
    ?? matchProductBuildRoute(message)
    ?? matchWebLandingRoute(message)
    ?? matchWebDevRoute(message)
    ?? matchBrowserAgentRoute(message)
    ?? matchPromptMasterRoute(message)
    ?? matchMarketResearchRoute(message)
    ?? matchImageGenRoute(message)
    ?? matchDeepResearchRoute(message)
    ?? matchConceptRoute(message)
  );
}

/** Hard language policy for user-facing model replies. */
export const RESPONSE_LANGUAGE_RULE = [
  'Language (hard):',
  '- Default: Korean for all user-facing prose (titles, bullets, explanations, summaries, review comments).',
  '- English only if the user message is written primarily in English.',
  '- Never write Chinese prose (简体/繁體 explanations, 优化建议, 修改后的代码 narrative, 功能完备性) when the user wrote Korean.',
  '- Code identifiers, existing source comments, and domain glyphs (e.g. 萬筒索 tile names in mahjong data) may remain as in the file; your commentary must still be Korean.',
].join('\n');

/** Default general-chat tone: conclusion-first, scannable, next-action oriented. */
const CHAT_RESPONSE_STYLE = [
  'Response style (default chat):',
  '- Lead with the conclusion or direct answer in 1–2 sentences (no throat-clearing).',
  '- Then give structured support: bullets or tight sections with key reasons/evidence.',
  '- End with one concrete next action the user can take, or one clarifying question if blocked.',
  '- Prefer scannable formatting; avoid filler, long preambles, and repeating the question.',
  '- Keep length proportional to the ask — short questions get short answers.',
  '- For analysis, design, debugging, or multi-step reasoning asks: go deeper with enough detail to be useful; do not artificially truncate.',
  RESPONSE_LANGUAGE_RULE,
].join('\n');

/**
 * Triggers Acceptance Review output shape (요구 vs 실제 / 구조·아키텍처 평가).
 * Includes assessment asks that lack 「검토해」 (e.g. 「구조 검토」, 「리팩토링 필요성」).
 */
export const ACCEPTANCE_REVIEW_RE =
  /(?:요구\s*vs\s*실제|acceptance\s*review|완성도|피드백|코드\s*검토|내용\s*검토|구현\s*검토|(?:제대로|맞게)\s*(?:된|됐|했)|리뷰해|검토해|review\s*(?:this|the|code|구현|변경)|이\s*정도\s*완성도|(?:구조|아키텍처|설계|코드베이스|프로젝트).{0,16}(?:검토|평가|감사|진단|재검토)|(?:검토|평가|감사|진단|재검토).{0,16}(?:구조|아키텍처|설계|코드베이스)|(?:리팩토|리펙토)(?:링)?\s*필요(?:성)?|(?:필요성|우선순위).{0,8}(?:확인|검토|평가)|구조\s*개선|기술\s*부채)/i;

export function looksLikeAcceptanceReviewTask(message: string): boolean {
  return ACCEPTANCE_REVIEW_RE.test(String(message || '').trim());
}

/** Bare follow-ups like 「이어서」 after a review ask keep the short-review contract. */
const REVIEW_FOLLOWUP_RE =
  /^(?:이어서|계속(?:해서)?|계속해(?:요|줘|주세요)?|더\s*(?:해|봐|분석|검토)|마저(?:\s*해)?)\s*[.!。]*$/i;

export function looksLikeAcceptanceReviewFollowUp(
  message: string,
  history?: Array<{ role: string; content: string }> | null,
): boolean {
  if (looksLikeAcceptanceReviewTask(message)) return true;
  if (!REVIEW_FOLLOWUP_RE.test(String(message || '').trim())) return false;
  if (!history?.length) return false;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const m = history[i];
    if (m?.role === 'user' && looksLikeAcceptanceReviewTask(m.content)) return true;
  }
  return false;
}

/** Injected when the user asks for review / completeness / architecture assessment. */
export function formatAcceptanceReviewSystemNote(): string {
  return [
    '## Acceptance review (short)',
    'User asked for review/feedback/architecture assessment.',
    'MUST use tools BEFORE the final answer (ASK is fine — mutate locked):',
    '- read_file: AGENTS.md, product-facts.json, ui-facts.json, .gitignore',
    '- read_file or query_repo_map: hotspots (code-agent.ts, tools.ts, dispatch.ts)',
    '- Prefer measured facts (file size / line count from tool results) over "미측정".',
    '- R-023: ui/workspace is the only product UI at / (do not invent ui/web or /legacy).',
    '- Web apps: if reviewing HTML/JS, flag getElementById targets missing from HTML as 미충족 (wiring).',
    '- 다음 수정: one concrete action NOW (e.g. split tools.ts registry) — never "먼저 측정 후 확정".',
    'FORBIDDEN as 미충족 items:',
    '- "측정 안 함", "확인하지 않음", "미검토", "우선순위 미확정 because I did not look"',
    '- Meta gaps about your own process. 미충족 = product problems with evidence paths.',
    'If you have not read yet: call tools now; do not publish a partial verdict.',
    'Final answer ONLY (after evidence):',
    '1) 결론 — 1–2 sentences (충족 / 부분 / 미충족)',
    '2) 표 optional (≤6 rows): 항목 | 판정 | 근거(path / Rule ID / measured LOC)',
    '3) 미충족 ≤3 — product issues only, each with one evidence path',
    '4) 다음 수정 — exactly one concrete next action',
    '5) 하지 말 것 — up to 2 (optional)',
    'Hard limits: prefer ≤700 Hangul chars (1100 max). No essays. No monorepo redesign unless asked.',
    'Anti-overclaim:',
    '- Decided policy (R-023 primary UI, deploy/output in .gitignore) is NOT "미결정".',
    '- P0 only with deploy/security evidence.',
    '- Do not misstate tools without reading them (deploy-parity ≠ source sync).',
    'Do not say 완료 while any product 미충족 remains. Do not invent paths or file contents.',
  ].join('\n');
}

/** Code/workspace replies: truth constraints only; the model owns answer structure. */
export const CODE_RESPONSE_STYLE = [
  'Code/workspace response contract:',
  'The model chooses the answer structure and keeps useful findings. Do not force Conclusion/Cause/Fix/Next sections.',
  'Do not append changed-path, TypeScript diagnostics, build, or verify boilerplate.',
  'Mention execution evidence only when requested, failed, or directly relevant to the user-visible outcome.',
  'Never claim 수정/반영/완료 unless mutating tools succeeded this run and disk matches the claim.',
  'Never invent smoke/parser field dumps (Ship To / Buyer Address) without a real command result. If unverified, say 미검증 in one line.',
  'Skip sections that do not apply; never invent files or UI redesigns that the user did not request.',
  'Never treat a synthetic editor buffer (buffer.tsx) or unrelated selection as the user task.',
  RESPONSE_LANGUAGE_RULE,
].join('\n');

/** Market / research answers: conclusion → evidence → recommendation → next. */
export const MARKET_RESPONSE_STYLE = [
  'Response style (market / research):',
  '1) Conclusion — feasibility or answer first.',
  '2) Evidence — key facts with sources when available.',
  '3) Recommendation — actionable options ranked briefly.',
  '4) Next — one concrete follow-up (data to collect, mode to run, or decision to make).',
  RESPONSE_LANGUAGE_RULE,
].join('\n');

const CHAT_CAPABILITY_BOUNDARIES = [
  'Capability boundary (chat mode):',
  '- URL screenshot/capture → browser_automation (say "스크린샷" or use browser mode; do not claim impossible).',
  '- URL click/login/fill/interaction → browser_agent mode.',
  '- Multi-page crawl / sitemap → web_crawl mode.',
  '- Image draw/generate → image_gen mode.',
    '- Market research / feasibility → deep_research mode.',
  '- Prompt writing for AI tools → prompt_master mode.',
  '- Code/files → web_dev mode.',
  '- Chrome extension / address parser / form normalizer build → web_dev (NOT browser_agent).',
  '- UNC/NAS path or 양식/엑셀 확인 → web_dev (list_directory/read_file on the path; never ask to copy into workspace).',
  'Do not permanently refuse specialized tasks — name the correct MY Agent mode briefly.',
].join('\n');

export function appendChatResponseStyle(
  systemPrompt: string | undefined,
  message?: string,
  history?: Array<{ role: string; content: string }> | null,
): string {
  const base = systemPrompt?.trim() ?? '';
  let out = base ? `${base}\n\n${CHAT_RESPONSE_STYLE}` : CHAT_RESPONSE_STYLE;
  if (message && looksLikeAcceptanceReviewFollowUp(message, history)) {
    out = `${out}\n\n${formatAcceptanceReviewSystemNote()}`;
  }
  return out;
}

export function appendCodeResponseStyle(systemPrompt: string | undefined): string {
  const base = systemPrompt?.trim() ?? '';
  return base ? `${base}\n\n${CODE_RESPONSE_STYLE}` : CODE_RESPONSE_STYLE;
}

export function appendMarketResponseStyle(systemPrompt: string | undefined): string {
  const base = systemPrompt?.trim() ?? '';
  return base ? `${base}\n\n${MARKET_RESPONSE_STYLE}` : MARKET_RESPONSE_STYLE;
}

export function appendChatCapabilityBoundary(systemPrompt: string | undefined): string {
  const base = systemPrompt?.trim() ?? '';
  return base ? `${base}\n\n${CHAT_CAPABILITY_BOUNDARIES}` : CHAT_CAPABILITY_BOUNDARIES;
}

export function messageNeedsChatCapabilityBoundary(message: string): boolean {
  return (
    (URL_IN_MESSAGE_RE.test(message) && BROWSER_CAPTURE_RE.test(message))
    || (BROWSER_INTERACTIVE_CORE_RE.test(message) && (URL_IN_MESSAGE_RE.test(message) || BROWSER_CONTEXT_RE.test(message)))
    || WEB_CRAWL_RE.test(message)
    || IMAGE_GEN_RE.test(message)
    || MARKET_RE.test(message)
    || PROMPT_MASTER_RE.test(message)
    || WEB_DEV_RE.test(message)
    || DEEP_RESEARCH_RE.test(message)
    || looksLikeInspectFilesTask(message)
  );
}

/**
 * User already attached media and is asking to analyze/describe it.
 * Must stay on chat (vision keyframes) — not automaton intent-clarify.
 */
const ATTACHED_MEDIA_TASK_RE =
  /(?:영상|비디오|video|mp4|webm|mov|이미지|사진|스크린샷|화면|광고).{0,16}(?:분석|요약|설명|리뷰|장면|자막|추출|읽어|봐줘|확인해)|(?:분석|요약|설명|장면|자막|키프레임).{0,16}(?:영상|비디오|video|이미지|사진)|이거\s*(?:분석|봐|설명)|첨부.+(?:분석|설명|요약)/i;

export function looksLikeAttachedMediaTask(message: string): boolean {
  return ATTACHED_MEDIA_TASK_RE.test(message.trim());
}

/** @deprecated use messageNeedsChatCapabilityBoundary */
export function messageNeedsChatBrowserBoundary(message: string): boolean {
  return messageNeedsChatCapabilityBoundary(message);
}
