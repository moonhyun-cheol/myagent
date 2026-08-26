/**
 * Generic agent grounding: live UI facts + ungrounded-state blocks + done-path checks.
 * Prefer process rules over one-off hallucination allowlists.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type UiFacts = {
  version: number;
  generated_at?: string;
  note?: string;
  shell?: {
    main_window?: string;
    title?: string | null;
    window_style?: string | null;
    has_window_chrome?: boolean;
    caption_height?: string | null;
    title_bar_background?: string | null;
    title_bar_label?: string | null;
    accent_bar?: string | null;
    custom_caption?: boolean;
  };
  workspace?: {
    chat_pane?: string | null;
    confirm_modal?: string | null;
    confirm_dialog_helper?: string | null;
    nav_sidebar?: string | null;
    projects_tree?: string | null;
    nav_uses_confirm_dialog?: boolean;
    nav_uses_window_confirm?: boolean;
    tree_uses_confirm_dialog?: boolean;
  };
  targets?: {
    title_bar?: string[];
    delete_confirm?: string[];
    composer?: string[];
  };
};

export function loadUiFacts(cqrRoot: string): UiFacts | null {
  const candidates = [
    path.join(cqrRoot, 'core', 'config', 'defaults', 'ui-facts.json'),
    path.join(cqrRoot, 'core', 'dist', 'config', 'defaults', 'ui-facts.json'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as UiFacts;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Compact system-prompt block from build-generated facts. */
export function formatUiFactsForPrompt(facts: UiFacts | null): string {
  if (!facts?.shell && !facts?.workspace) return '';
  const s = facts.shell ?? {};
  const w = facts.workspace ?? {};
  return [
    '',
    '## Live UI facts (build-generated — prefer over memory)',
    facts.generated_at ? `generated_at: ${facts.generated_at}` : '',
    s.main_window
      ? [
          `shell: ${s.main_window}`,
          `  Title=${JSON.stringify(s.title ?? null)} WindowStyle=${JSON.stringify(s.window_style ?? null)}`,
          `  custom_caption=${Boolean(s.custom_caption)} chrome=${Boolean(s.has_window_chrome)} caption_h=${s.caption_height ?? '?'}`,
          `  bar_bg=${s.title_bar_background ?? '?'} label=${JSON.stringify(s.title_bar_label ?? null)} accent=${s.accent_bar ?? '?'}`,
        ].join('\n')
      : '',
    w.confirm_modal
      ? `delete confirm: modal=${w.confirm_modal} helper=${w.confirm_dialog_helper} nav_confirmDialog=${Boolean(w.nav_uses_confirm_dialog)} (window.confirm=${Boolean(w.nav_uses_window_confirm)})`
      : '',
    w.chat_pane ? `composer/chat: ${w.chat_pane}` : '',
    'RULE: Never assert current Title/WindowStyle/confirm() state from memory. If unsure, read_file the path above.',
    'RULE: Do not claim "default Windows title bar / Title-only" when custom_caption=true.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Prose that asserts codebase/UI state (needs a successful read_file this run).
 */
export function contentClaimsUngroundedFileState(text: string): boolean {
  const t = text.trim();
  if (t.length < 40) return false;
  const assertsState =
    /(?:현재|지금)\s*.{0,40}(?:MainWindow|타이틀바|WindowStyle|Title\s*=|confirm\s*\(|기본\s*Windows|기본\s*윈도우)/i.test(t)
    || /(?:Title\s*만|Background(?:로)?\s*(?:변경|적용)\s*되지|색상까지\s*변경하려면)/i.test(t)
    || /Title\s*=\s*["']MY Agent["']/i.test(t)
    || /WindowStyle\s*=\s*["'][^"']+["']/i.test(t)
    || /(?:기본\s*Windows\s*타이틀바|시스템\s*타이틀바|Aero\s*캡션)/i.test(t)
    || /확인된\s*변경\s*대상[\s\S]{0,80}Title\s*=/i.test(t);
  return assertsState;
}

export function normalizeAgentPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

export function pathMatchesAny(candidate: string, allowed: string[]): boolean {
  const c = normalizeAgentPath(candidate).toLowerCase();
  return allowed.some((a) => {
    const n = normalizeAgentPath(a).toLowerCase();
    return c === n || c.endsWith(`/${n}`) || n.endsWith(`/${c}`) || c.includes(n) || n.includes(c);
  });
}

const TITLEBAR_REQ =
  /(?:타이틀바|title\s*bar|창\s*상단|위에\s*바|상단\s*바|프로그램명|창\s*제목|CQR\s*Agent|CQR\s*_?\s*PA)/i;
const CONFIRM_REQ =
  /(?:삭제할까요|confirm|확인창|다이얼로그|프로젝트\s*이름|새\s*프로젝트|window\.prompt|prompt\(|안내창)/i;
const COMPOSER_REQ =
  /(?:composer|입력창|전송|중지|Agent\s*헤더|채팅\s*헤더)/i;

/** Expected edit paths for known UI intents (from live facts when possible). */
export function expectedPathsForUiRequest(userMessage: string, facts: UiFacts | null): string[] {
  const t = facts?.targets;
  if (TITLEBAR_REQ.test(userMessage)) {
    return t?.title_bar?.length
      ? t.title_bar
      : ['shell/CqrPa.Shell/MainWindow.xaml'];
  }
  if (CONFIRM_REQ.test(userMessage) && /(?:색|테마|모달|바꾸|변경|맞|UI|ui|입력|prompt|프로젝트)/i.test(userMessage)) {
    return t?.delete_confirm?.length
      ? t.delete_confirm
      : [
          'ui/workspace/src/components/ConfirmModal.tsx',
          'ui/workspace/src/lib/confirmDialog.ts',
          'ui/workspace/src/components/ProjectsTree.tsx',
        ];
  }
  if (COMPOSER_REQ.test(userMessage)) {
    return t?.composer?.length
      ? t.composer
      : ['ui/workspace/src/components/ChatPane.tsx'];
  }
  return [];
}

export function mutationsCoverExpected(
  mutatedPaths: string[],
  expectedPaths: string[],
): { ok: boolean; missing: string[]; hit: string[] } {
  if (!expectedPaths.length) return { ok: true, missing: [], hit: [] };
  const hit = expectedPaths.filter((exp) => mutatedPaths.some((m) => pathMatchesAny(m, [exp])));
  const missing = expectedPaths.filter((exp) => !hit.some((h) => pathMatchesAny(h, [exp])));
  // ok if at least one expected path was touched (title bar may only need MainWindow.xaml)
  const ok = hit.length > 0;
  return { ok, missing, hit };
}

/** Successful read_file paths from assistant tool_calls that already ran (message list). */
export function collectReadPathsFromMessages(
  messages: Array<{ role?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> }>,
): Set<string> {
  const out = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
    for (const call of m.tool_calls) {
      if (call.function?.name !== 'read_file') continue;
      try {
        const args = JSON.parse(call.function.arguments || '{}') as { path?: string };
        if (typeof args.path === 'string' && args.path.trim()) {
          out.add(normalizeAgentPath(args.path));
        }
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

const AMBIGUOUS_UI_RE =
  /(?:안내창|이\s*두\s*부분|색상\s*(?:맞|통일|변경)|테마\s*맞|컨셉에\s*맞)/i;

export type UiClarifyOpts = {
  hasScreenshot?: boolean;
  planApproved?: boolean;
};

/**
 * Plan gate (#4): ask once when UI edit intent is ambiguous and neither
 * keywords nor screenshot classified a concrete target.
 * Skip when screenshot present, vision classified, or user already said 진행.
 */
export function needsUiClarifyQuestion(
  userMessage: string,
  visionTarget: 'title_bar' | 'confirm' | 'composer' | 'sidebar' | 'unknown' | null,
  opts?: UiClarifyOpts,
): boolean {
  if (opts?.hasScreenshot || opts?.planApproved) return false;
  if (!/(?:색|테마|바꾸|변경|맞추|통일|수정)/i.test(userMessage) && !AMBIGUOUS_UI_RE.test(userMessage)) {
    return false;
  }
  if (TITLEBAR_REQ.test(userMessage) || COMPOSER_REQ.test(userMessage)) return false;
  if (CONFIRM_REQ.test(userMessage) && /(?:색|테마|모달|바꾸|변경|맞|UI|ui|입력|prompt|프로젝트)/i.test(userMessage)) {
    return false;
  }
  if (visionTarget && visionTarget !== 'unknown') return false;
  return AMBIGUOUS_UI_RE.test(userMessage) || /(?:위|상단|창|다이얼|모달|바)/i.test(userMessage);
}

export function formatUiClarifyQuestion(): string {
  return [
    '어느 UI를 바꿀까요? 번호로 답해 주세요.',
    '1) 창 타이틀바 (MY Agent / 최소화·닫기)',
    '2) 삭제 확인 모달',
    '3) 채팅 Agent 헤더·입력창',
    '스크린샷을 다시 첨부해 주셔도 됩니다.',
  ].join('\n');
}

/** Map numeric clarify replies to expected paths. */
export function pathsFromUiClarifyReply(
  reply: string,
  facts: UiFacts | null,
): string[] {
  const t = reply.trim();
  if (/^1\b|타이틀|위에\s*바|창\s*바|CQR\s*Agent/i.test(t)) {
    return facts?.targets?.title_bar ?? ['shell/CqrPa.Shell/MainWindow.xaml'];
  }
  if (/^2\b|삭제|확인|모달|다이얼/i.test(t)) {
    return facts?.targets?.delete_confirm ?? ['ui/workspace/src/components/ConfirmModal.tsx'];
  }
  if (/^3\b|입력|composer|채팅|헤더/i.test(t)) {
    return facts?.targets?.composer ?? ['ui/workspace/src/components/ChatPane.tsx'];
  }
  return [];
}
