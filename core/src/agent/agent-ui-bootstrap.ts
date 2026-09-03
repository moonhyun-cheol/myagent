export const UI_TARGET_MAP_PATH = 'core/config/defaults/ui-facts.json';
export const CHAT_PANE_PATH = 'ui/workspace/src/components/ChatPane.tsx';
export const NAV_SIDEBAR_PATH = 'ui/workspace/src/components/GeminiNavSidebar.tsx';
export const SHELL_WINDOW_PATH = 'shell/CqrPa.Shell/MainWindow.xaml';

export const UI_TASK_RE =
  /(?:채팅|chat|composer|undo|전송|중지|stop|입력창|레이아웃|사이드바|안내창|타이틀바|title\s*bar|다이얼로그|confirm|삭제할까요|창\s*상단|위에\s*바|상단\s*바|프로그램명|창\s*제목|제목\s*표시줄|CQR\s*_?\s*PA|CQR\s*Agent|ui\b|색상|테마)/i;

export const UI_TITLEBAR_RE =
  /(?:타이틀바|title\s*bar|창\s*상단|위에\s*바|상단\s*바|윈도우\s*(?:크롬|바|제목)|캡션|최소화|최대화|닫기\s*버튼|프로그램명|창\s*제목|제목\s*표시줄|CQR\s*_?\s*PA\s*(?:로|을|를)?\s*(?:바꾸|변경)|CQR\s*Agent)/i;
export const UI_CONFIRM_RE =
  /(?:삭제할까요|confirm\s*\(|window\.confirm|다이얼로그|확인창|네이티브\s*confirm|알림창)/i;
export const UI_COMPOSER_RE =
  /(?:composer|입력창|전송|중지|stop|undo|모드\s*버튼|Agent\s*헤더|채팅\s*헤더)/i;
export const UI_AMBIGUOUS_RE = /(?:안내창|이\s*두\s*부분|색상\s*(?:맞|통일|변경)|테마\s*맞)/i;

/** Stale fiction: claiming system title bar / Title-only when custom chrome already exists. */
export function contentClaimsStaleShellTitleBar(text: string): boolean {
  return (
    /(?:기본\s*Windows\s*타이틀바|기본\s*윈도우\s*(?:타이틀|제목)|Aero\s*캡션|시스템\s*타이틀바)/i.test(text)
    || (
      /(?:Title\s*만|Background(?:로)?\s*(?:변경|적용)\s*되지|색상까지\s*변경하려면)/i.test(text)
      && /(?:MainWindow|타이틀바|WindowStyle|커스텀)/i.test(text)
    )
    || (
      /Title\s*=\s*["']MY Agent["']/i.test(text)
      && /(?:변경\s*대상|확인된|→)/i.test(text)
    )
  );
}

/** Classify UI edit target — never default every UI ask to ChatPane. */
export function resolveUiBootstrapPath(userMessage: string): string | null {
  if (!UI_TASK_RE.test(userMessage)) return null;
  if (UI_TITLEBAR_RE.test(userMessage)) return SHELL_WINDOW_PATH;
  if (UI_CONFIRM_RE.test(userMessage)) return NAV_SIDEBAR_PATH;
  if (UI_COMPOSER_RE.test(userMessage)) return CHAT_PANE_PATH;
  if (/(?:사이드바|대화\s*목록|제미나이|gemini\s*nav)/i.test(userMessage)) {
    return NAV_SIDEBAR_PATH;
  }
  // Ambiguous labels (안내창 등): read the map first — do not force ChatPane.
  if (UI_AMBIGUOUS_RE.test(userMessage)) return UI_TARGET_MAP_PATH;
  return UI_TARGET_MAP_PATH;
}

export function defaultUiReadFallback(userMessage: string, selfWorkspace: boolean): string | null {
  if (!selfWorkspace) return null;
  return resolveUiBootstrapPath(userMessage) || UI_TARGET_MAP_PATH;
}

export function toolCallReadOrList(pathHint: string | null): string {
  if (pathHint) {
    return `TOOL_CALL: {"name":"read_file","arguments":{"path":"${pathHint}"}}`;
  }
  return 'TOOL_CALL: {"name":"list_directory","arguments":{"path":"."}}';
}

export function chatUiPathHints(userMessage: string, selfWorkspace: boolean): string {
  if (!selfWorkspace || !UI_TASK_RE.test(userMessage)) return '';
  const bootstrap = resolveUiBootstrapPath(userMessage) || UI_TARGET_MAP_PATH;
  return [
    '',
    '## UI target map (Cursor-style — classify before edit)',
    'Product UI = ui/workspace (WebView2), served at /. No fallback UI exists.',
    'Do NOT assume ChatPane for every UI ask.',
    'Map:',
    `- Window title bar / "위에 바" / program name → ${SHELL_WINDOW_PATH}`,
    '  FACT (already shipped): WindowStyle=None + custom 36px chrome, Title/text "MY Agent",',
    '  bar #12151c, accent #2dd4bf, text #e8ebf2. DarkTitleBar.cs is secondary.',
    '  FALSE: "only Title= can change" / "Background cannot recolor the bar" / "still default Windows chrome".',
    '  After shell edits: rebuild/publish shell (bin/cqr-pa) and restart cqr-pa.exe — Vite refresh is NOT enough.',
    `- Delete confirm → ConfirmModal + confirmDialog() (NOT window.confirm). Call sites: ${NAV_SIDEBAR_PATH}, ProjectsTree.tsx`,
    `- Agent header / composer / send / stop → ${CHAT_PANE_PATH} + workspaceStore.ts`,
    `- Left nav / session list → ${NAV_SIDEBAR_PATH}`,
    `"안내창" is NOT a code name — use screenshot/words; if unclear, ask ONE clarifying question.`,
    'ALWAYS read_file the target BEFORE describing what "현재 MainWindow" contains. Never invent Title="MY Agent" from memory.',
    'Before claiming done: the element in the user screenshot MUST be in your diff.',
    `First read: TOOL_CALL: {"name":"read_file","arguments":{"path":"${bootstrap}"}}`,
    `Full map: ${UI_TARGET_MAP_PATH}`,
  ].join('\n');
}
