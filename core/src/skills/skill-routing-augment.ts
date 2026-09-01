import type { ChatMode } from '../router/types.js';
import {
  CODE_RESPONSE_STYLE,
  MARKET_RESPONSE_STYLE,
} from '../router/route-heuristics.js';
import { WEB_DEV_PRODUCT_UI_HINT } from './web-landing-bundle.js';

const ORCHESTRATOR_LOCK = [
  '## MY Agent mode lock',
  'Stay in the active skill/mode. Do not ask the user to switch tools manually unless two modes genuinely conflict.',
  'If the task needs another mode, state it in one short line and proceed with the best fit.',
].join('\n');

const WEB_DEV_CORE = [
  ORCHESTRATOR_LOCK,
  '',
  CODE_RESPONSE_STYLE,
  '',
  '## web_dev tool discipline',
  'Use workspace file tools (read_file before edit). For live URL verification use browser_* tools when available.',
  'Few-shot:',
  '- User: "main.py 확인" → TOOL/read_file on main.py → short conclusion + findings.',
  '- User: "로그인 버그 수정" → search/read → edit_file → conclude with cause + fix + next test.',
  '- User: "이미지 붙여넣기 추가" → implement clipboard paste in UI; never ask user to paste source files.',
  '- User: "이 확장 요구대로 됐는지 검토" → read real files → 결론(충족/부분/미충족) → 미충족≤3 + path → 다음 조치 1개; do not claim 완료 if 미충족 remains.',
  '- User: "구조 검토 / 리팩토링 필요성" → read AGENTS.md + product-facts + measure hotspots → short verdict; ASK only (no PLAN-mode mutate / monorepo redesign).',
  '',
  WEB_DEV_PRODUCT_UI_HINT,
].join('\n');

const WEB_DEV_PRODUCT_SELF = [
  'The only product UI is ui/workspace, served at /.',
  'UI target map (do NOT default every UI ask to ChatPane):',
  '- Window title bar / "위에 바" / program name → shell/CqrPa.Shell/MainWindow.xaml',
  '  Read ui-facts.json before asserting the current title, colors, or window chrome.',
  '  Shell edits need publish + cqr-pa restart (not Vite refresh).',
  '- Delete confirm → ConfirmModal/confirmDialog (not window.confirm)',
  '- Composer / send / stop / Agent header → ChatPane.tsx + workspaceStore.ts',
  '- Ambiguous "안내창" → read rulebook/docs/specs/technical/ui-target-map.md; ask one clarify if needed',
  'Before done: user screenshot element must be in the diff.',
  'ALWAYS read_file before describing what MainWindow currently contains.',
  'Few-shot (MY Agent self):',
  '- User: "전송 옆 중지 버튼" → read ChatPane.tsx + workspaceStore.ts → wire AbortController → edit; never ask for Manager restart.',
  '- User: "위에 바 / 프로그램 제목" → read MainWindow.xaml; edit colors/title if needed; publish shell.',
].join('\n');

const WEB_DEV_EXTERNAL = [
  'Dev workspace is an external project — NOT the MY Agent product tree.',
  'Do NOT cite MY Agent paths (ui/workspace, ChatPane, MainWindow.xaml, ui-target-map.md).',
  'Discover files via repo map / search / read_file (workspace = chat context; absolute/UNC OK when user points outside).',
  'Before done: list changed paths + diagnostics; for review asks use short 결론 → 미충족≤3 → 다음 1개.',
].join('\n');

const MODE_AUGMENTS: Partial<Record<ChatMode, string>> = {
  image_gen: [
    ORCHESTRATOR_LOCK,
    '',
    '## image_gen focus',
    'Generate images via configured backend. Do not claim you cannot create images in this mode.',
    'Few-shot: "화이트 배경 제품샷" → generate → show result → offer one refine option.',
  ].join('\n'),
  deep_research: [
    ORCHESTRATOR_LOCK,
    '',
    MARKET_RESPONSE_STYLE,
    '',
    '## deep_research focus',
    'Multi-source research report with citations. Not automaton business ops.',
  ].join('\n'),
  browser_automation: [
    ORCHESTRATOR_LOCK,
    '',
    '## browser_automation focus',
    'Playwright captures pages. Do not say you cannot access URLs — the system runs headless browser.',
    'Few-shot: "이 URL 스크린샷" → navigate + screenshot → short page summary.',
  ].join('\n'),
  browser_agent: [
    ORCHESTRATOR_LOCK,
    '',
    '## browser_agent focus',
    'Multi-step vision agent (screenshot → action). Use for click/fill/login — not simple one-shot capture.',
    'Retry once on selector errors; prefer stable CSS selectors.',
  ].join('\n'),
  web_crawl: [
    ORCHESTRATOR_LOCK,
    '',
    '## web_crawl focus',
    'Same-host multi-page crawl. Output page list + markdown report path — not a single screenshot.',
  ].join('\n'),
  automaton_direct: [
    ORCHESTRATOR_LOCK,
    '',
    '## automaton_direct focus',
    'Organization automation runs only through installed, registered tools. Ask one clarification question when required arguments are missing.',
  ].join('\n'),
};

export type SkillAugmentOptions = {
  /** When false, omit MY Agent layout / ui-target-map hints (external dev workspace). Default true. */
  selfProductMemory?: boolean;
};

function webDevAugment(selfProductMemory: boolean): string {
  return [WEB_DEV_CORE, '', selfProductMemory ? WEB_DEV_PRODUCT_SELF : WEB_DEV_EXTERNAL].join('\n');
}

/** Append orchestrator routing lock + mode few-shot to any skill system prompt. */
export function augmentSkillSystemPrompt(
  mode: ChatMode,
  base: string | null,
  opts?: SkillAugmentOptions,
): string | null {
  if (!base?.trim()) return base;
  const self = opts?.selfProductMemory !== false;
  const extra = mode === 'web_dev' ? webDevAugment(self) : MODE_AUGMENTS[mode];
  if (!extra) return base;
  return `${base.trim()}\n\n${extra}`;
}
