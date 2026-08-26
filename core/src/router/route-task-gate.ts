/**
 * Cross-mode task-type gate: specialized pipelines must not run when the
 * user is clearly asking to inspect local/NAS files, forms, or sheets.
 *
 * Applies to deep_research / image_gen (and any
 * future pipeline mode that registers via evaluateSpecializedModeFit).
 */
import type { ChatMode } from './types.js';

/** UNC/drive match for intent detection (may truncate at spaces — OK for boolean detect). */
const UNC_OR_DRIVE_PATH_RE =
  /(?:\\\\[^\s\\]+(?:\\[^\s\\]+)+|[A-Za-z]:\\[^\s\\]+(?:\\[^\s\\]+)*)/;

const NETWORK_SHARE_HINT_RE =
  /\\\\nas\b|\\\\[가-힣A-Za-z0-9._-]+\\|공용_|네트워크\s*경로|공유\s*(?:폴더|드라이브)|NAS\s*경로/i;

const FILE_INSPECT_NOUN_RE =
  /양식|레거시|엑셀|\.xlsx\b|\.xls\b|\.csv\b|시트|컬럼|주소란|주소\s*쪽|배송요청|출고요청|도착지정보|샘플출고|주문출고/i;

const FILE_INSPECT_VERB_RE =
  /(?:폴더|파일|경로|엑셀|양식|시트).{0,12}(?:봐|확인|열|읽|점검)|(?:봐|확인|열|읽|점검).{0,12}(?:폴더|파일|경로|엑셀|양식|시트)|열어서|기입\s*방식|컬럼\s*구조/i;

/** Structure/architecture assessment — must not be treated as NAS/양식 inspect. */
const STRUCTURE_ASSESS_RE =
  /(?:구조|아키텍처|설계|코드베이스|프로젝트).{0,16}(?:검토|평가|감사|진단|재검토)|(?:검토|평가|감사|진단|재검토).{0,16}(?:구조|아키텍처|설계|코드베이스)|(?:리팩토|리펙토)(?:링)?\s*필요(?:성)?|acceptance\s*review|완성도|코드\s*검토|구현\s*검토|기술\s*부채/i;

const MARKET_RE =
  /시장조사|타당성|경쟁사|feasibility|market research|기획서/i;

const DEEP_RESEARCH_RE =
  /심층\s*리서치|딥\s*리서치|deep research|다중\s*출처|출처.*(?:조사|리서치)/i;

const CONCEPT_RE =
  /컨셉|무드\s*보드|룩북|촬영\s*브리프|lookbook|mood board|shoot brief/i;

const IMAGE_GEN_RE =
  /(?:그려|그림\s*(?:그려|만들)|이미지\s*(?:만들|생성|그려)|일러스트|로고\s*(?:만들|그려)|draw|generate image)/i;

const MARKET_SLASH_RE = /^\/(?:심층리서치|타당성|기획서)(?:\s|$)/i;

/** Chrome/product build — never live browser_agent (URL click/login). */
const EXTENSION_OR_PRODUCT_RE =
  /(?:크롬|구글|chrome|google)?\s*(?:익스텐션|익스탠션|확장\s*프로그램|extension)|chrome\s*extension|브라우저\s*확장|애드온|add[\s-]?on/i;

const BUILD_VERB_RE =
  /(?:만들|제작|구현|개발|표준화|파서|parser|모듈|기능\s*(?:추가|만들)|로\s*만들)/i;

const PARSE_SPEC_RE =
  /(?:주소|양식|파싱|나눠|정규화|필드|컬럼|긁어\s*넣|붙여\s*넣|수취인|우편번호|zip|전화번호)/i;

const URL_RE = /https?:\/\/[^\s<>"')\]]+/i;

const RESEARCH_PIPELINE_MODES = new Set<ChatMode>([
  'deep_research',
]);

const BROWSER_PIPELINE_MODES = new Set<ChatMode>([
  'browser_agent',
  'browser_automation',
  'web_crawl',
]);

const CONFLICT_CLARIFY =
  '이 요청은 **폴더/양식 확인**과 **시장·리서치 조사** 신호가 같이 보여요. 어느 쪽으로 진행할까요?\n'
  + '- 폴더·엑셀·양식 확인\n'
  + '- 심층리서치/시장조사';

/** Prose that follows a path in the same sentence (do not treat as path segment). */
const PATH_TRAILING_PROSE_RE =
  /\s+(?:먼저|이\s|그\s|저\s|봐|확인|레거시|양식|주소|파일들?|폴더|루트|쪽|관련|엑셀|시트|컬럼)/;

function trimPathProse(raw: string): string {
  let p = raw.trim();
  const cut = p.search(PATH_TRAILING_PROSE_RE);
  if (cut > 0) p = p.slice(0, cut);
  return p.replace(/[.,;:!?。]+$/u, '').trim();
}

/**
 * Extract UNC / drive paths from user text. Allows spaces inside segments
 * (e.g. `00_TRICELL USA 주문`) and trims trailing Korean prose.
 */
export function extractUncOrDrivePaths(message: string): string[] {
  const text = String(message || '');
  const found: string[] = [];
  const uncRe = /\\\\[^\\/:*?"<>|\r\n]+(?:\\[^\\/:*?"<>|\r\n]+)+/g;
  const driveRe = /[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*/g;
  for (const re of [uncRe, driveRe]) {
    for (const m of text.matchAll(re)) {
      const p = trimPathProse(m[0]);
      if (!p) continue;
      if (p.startsWith('\\\\')) {
        // Need \\server\share at minimum
        if (!/^\\\\[^\\]+\\[^\\]/.test(p)) continue;
      }
      found.push(p);
    }
  }
  return [...new Set(found)];
}

/** Drop UNC/drive path tokens so folder names like `시장조사팀` do not fake research intent. */
export function stripPathTokens(message: string): string {
  let t = String(message || '');
  for (const p of extractUncOrDrivePaths(t)) {
    t = t.split(p).join(' ');
  }
  return t
    .replace(UNC_OR_DRIVE_PATH_RE, ' ')
    .replace(/\\\\[^\s]+/g, ' ')
    .replace(/[A-Za-z]:\\[^\s]+/g, ' ');
}

export function isExplicitMarketSlash(message: string): boolean {
  return MARKET_SLASH_RE.test(String(message || '').trim());
}

/** True when the message is primarily about inspecting paths/forms/sheets. */
export function looksLikeInspectFilesTask(message: string): boolean {
  const t = String(message || '').trim();
  if (!t) return false;

  // Absolute path + architecture/structure review is NOT form/NAS inspect.
  // (Otherwise C:\...\MY Agent + 「구조 검토」 dumps a dir listing and skips the review loop.)
  if (STRUCTURE_ASSESS_RE.test(t) && !FILE_INSPECT_NOUN_RE.test(t)) {
    return false;
  }

  if (extractUncOrDrivePaths(t).length > 0) return true;
  if (UNC_OR_DRIVE_PATH_RE.test(t)) return true;
  if (NETWORK_SHARE_HINT_RE.test(t) && (FILE_INSPECT_VERB_RE.test(t) || FILE_INSPECT_NOUN_RE.test(t))) {
    return true;
  }
  if (FILE_INSPECT_NOUN_RE.test(t) && FILE_INSPECT_VERB_RE.test(t)) return true;
  if (/(?:양식|레거시\s*파일|도착지\s*정보).{0,24}(?:확인|봐)/i.test(t)) return true;
  if (/(?:주소\s*쪽|주소란).{0,12}(?:확인|봐|체크)/i.test(t)) return true;
  return false;
}

/**
 * Build/ship a product (Chrome extension, address parser, form normalizer, etc.).
 * Must NOT go to browser_agent just because the text contains 「입력」.
 */
export function looksLikeProductBuildTask(message: string): boolean {
  const t = String(message || '').trim();
  if (!t) return false;
  // Live page control with URL stays browser — product build is about creating software.
  if (URL_RE.test(t) && /(?:클릭|로그인|fill|submit|열어|접속)/i.test(t) && !EXTENSION_OR_PRODUCT_RE.test(t)) {
    return false;
  }
  if (EXTENSION_OR_PRODUCT_RE.test(t) && BUILD_VERB_RE.test(t)) return true;
  if (EXTENSION_OR_PRODUCT_RE.test(t)) return true;
  // Spec sample (address block) + build/normalize intent without saying "extension"
  if (PARSE_SPEC_RE.test(t) && BUILD_VERB_RE.test(t) && !looksLikeInspectFilesTask(t)) {
    return true;
  }
  return false;
}

/** Hard preemption: do not enter research/concept/image/browser pipelines for wrong task types. */
export function blocksSpecializedPipelineModes(message: string): boolean {
  if (looksLikeInspectFilesTask(message)) return true;
  if (looksLikeProductBuildTask(message)) return true;
  return false;
}

export function hasResearchIntentSignal(message: string): boolean {
  const t = stripPathTokens(String(message || ''));
  return (
    isExplicitMarketSlash(String(message || ''))
    || MARKET_RE.test(t)
    || DEEP_RESEARCH_RE.test(t)
    || CONCEPT_RE.test(t)
  );
}

export type ModeFitResult =
  | { ok: true }
  | { ok: false; action: 'reroute'; mode: ChatMode }
  | { ok: false; action: 'clarify'; message: string };

/**
 * Legacy capability-fit helper retained for narrow pipeline and path checks.
 * brand override, including explicit chip + slash bypass.
 */
export function evaluateSpecializedModeFit(mode: ChatMode, message: string): ModeFitResult {
  const inspect = looksLikeInspectFilesTask(message);
  const productBuild = looksLikeProductBuildTask(message);
  const researchSignal = hasResearchIntentSignal(message);
  const imageSignal = IMAGE_GEN_RE.test(message);

  // Product/extension build must never run live browser pipelines.
  if (productBuild && BROWSER_PIPELINE_MODES.has(mode)) {
    return { ok: false, action: 'reroute', mode: 'web_dev' };
  }
  if (productBuild && RESEARCH_PIPELINE_MODES.has(mode) && !researchSignal) {
    return { ok: false, action: 'reroute', mode: 'web_dev' };
  }

  if (!inspect) return { ok: true };

  if (RESEARCH_PIPELINE_MODES.has(mode)) {
    if (researchSignal) {
      return { ok: false, action: 'clarify', message: CONFLICT_CLARIFY };
    }
    return { ok: false, action: 'reroute', mode: 'web_dev' };
  }

  if (mode === 'image_gen' && !imageSignal) {
    return { ok: false, action: 'reroute', mode: 'web_dev' };
  }

  if (BROWSER_PIPELINE_MODES.has(mode) && !URL_RE.test(message)) {
    return { ok: false, action: 'reroute', mode: 'web_dev' };
  }

  return { ok: true };
}

/** Fast-path decision target when inspect-files / product-build wins. */
export function inspectFilesPreferredMode(): ChatMode {
  return 'web_dev';
}

export function productBuildPreferredMode(): ChatMode {
  return 'web_dev';
}
