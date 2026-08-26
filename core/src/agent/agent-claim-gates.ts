/**
 * Claim-quality gates: min retrieval depth, framing vs mutate size, verify witness.
 * Pure helpers wired by the step loop.
 */

export type VerifyWitness = {
  kind: 'diagnostics' | 'tests' | 'terminal';
  ok: boolean;
  atStep: number;
  command?: string;
  /** Present when known (0 = success). */
  exitCode?: number;
};

const MIN_DEPTH_TOOLS = new Set(['read_file', 'search_files', 'list_directory']);

/** Parse hit count from query_repo_map / search_embeddings JSON (+ optional hint suffix). */
export function retrievalHitCountFromOutput(output: string): number | null {
  const raw = String(output || '').trim();
  if (!raw) return null;
  if (/returned 0 hits/i.test(raw)) return 0;
  const jsonPart = raw.split(/\n\nInstructions for the model/)[0]?.trim() ?? raw;
  try {
    const doc = JSON.parse(jsonPart) as { count?: unknown; hits?: unknown };
    if (typeof doc.count === 'number' && Number.isFinite(doc.count)) return Math.max(0, Math.floor(doc.count));
    if (Array.isArray(doc.hits)) return doc.hits.length;
  } catch {
    /* not JSON */
  }
  return null;
}

export function isEmptyHighLevelRetrieval(toolName: string, output: string): boolean {
  if (toolName !== 'query_repo_map' && toolName !== 'search_embeddings') return false;
  const n = retrievalHitCountFromOutput(output);
  return n === 0;
}

/** Concrete path/API claims that should not follow empty retrieval without a read. */
export function contentClaimsConcreteRepoPaths(text: string): boolean {
  const t = String(text || '');
  if (t.trim().length < 40) return false;
  if (
    /(?:core\/src\/|ui\/workspace\/|tools\/[\w./-]+|shell\/CqrPa)[\w./-]{0,80}/i.test(t)
    && /(?:에\s*있|에\s*정의|에서\s*확인|구현|export|function|class)\w*/i.test(t)
  ) {
    return true;
  }
  return /`[\w./\\-]+\.(?:ts|tsx|js|mjs|py|json)`/.test(t)
    && /(?:파일|경로|모듈|엔트리)/i.test(t);
}

export function shouldFlagRetrievalZeroOverclaim(opts: {
  toolsUsed: string[];
  successfulReads: string[];
  assistantText: string;
  explainTask?: boolean;
}): boolean {
  // IMP-AGT-02: knowledge/explain must not invent concrete paths after empty retrieval either.
  void opts.explainTask;
  if ((opts.successfulReads?.length ?? 0) > 0) return false;
  const usedRetrieval = (opts.toolsUsed || []).some(
    (t) => t === 'search_embeddings' || t === 'query_repo_map',
  );
  if (!usedRetrieval) return false;
  return contentClaimsConcreteRepoPaths(opts.assistantText);
}

export function formatRetrievalZeroOverclaimNudge(): string {
  return [
    'EMPTY_RETRIEVAL_OVERCLAIM: map/embeddings returned no hits (or you have not read a file),',
    'but the reply asserts concrete paths/APIs. Do not invent file locations.',
    'Next: read_file or search_files on a real candidate, or say 확인 불가 with what you searched.',
  ].join(' ');
}

/** Docx/binary extract failed — do not also invent document substance. */
export function contentContradictsExtractFailure(text: string): boolean {
  const t = String(text || '');
  const fail = /바이너리 원문만|요약할 수 없|추출\s*(?:실패|불가)|신뢰성 있게 요약할 수 없|unsupported\s*binary/i.test(
    t,
  );
  if (!fail) return false;
  return /(?:핵심\s*(?:은|요약)|요약하면|문서\s*(?:요지|에\s*따르면)|Purpose Above All|채널:\s*DTC|전략\s*목표)/i.test(
    t,
  );
}

export function formatExtractFailHallucinationNudge(): string {
  return [
    'EXTRACT_FAIL_HALLUCINATION: you admitted extract/binary failure but also claimed document substance.',
    'Stop inventing. Say 요약 불가 + next step (re-upload text twin / extract document.xml). No fabricated Purpose/channel claims.',
  ].join(' ');
}

export function isMinDepthTool(toolName: string): boolean {
  return MIN_DEPTH_TOOLS.has(toolName);
}

/** Single Exit Gate + one TOOL_CALL (RCA: one unclosed evidence gate per turn). */
export function formatExitGateToolNudge(opts: {
  gate: string;
  toolName: string;
  args?: Record<string, unknown>;
  detail?: string;
}): string {
  const call = {
    name: opts.toolName,
    arguments: opts.args ?? {},
  };
  return [
    `EXIT_GATE (close this one only): ${opts.gate}`,
    opts.detail?.trim() || null,
    `TOOL_CALL: ${JSON.stringify(call)}`,
    'First line must be TOOL_CALL. Brief Korean status after. No apology essay.',
  ]
    .filter((l) => l != null && l !== '')
    .join('\n');
}

export function formatMinDepthNudge(opts: {
  userMessage: string;
  pathHints?: string[];
}): string {
  const paths = (opts.pathHints ?? []).filter(Boolean).slice(0, 4);
  if (paths[0]) {
    return formatExitGateToolNudge({
      gate: 'read a suspected entry path after empty retrieval',
      toolName: 'read_file',
      args: { path: paths[0] },
      detail: 'Empty map ≠ missing file. Do not finish with 확인 불가.',
    });
  }
  return formatExitGateToolNudge({
    gate: 'search_files for entry points after empty retrieval',
    toolName: 'search_files',
    args: { query: 'tools.ts' },
    detail: 'Empty map ≠ missing file. Do not finish with 확인 불가.',
  });
}

/** Over-hype framing in final prose (architecture / large refactor claims). */
export function contentHasOverFramingKeywords(text: string): boolean {
  return /(?:아키텍처\s*(?:개선|개편|고도화)|구조\s*(?:개선|개편|혁신)|의존성\s*(?:축소|제거|정리)|대규모\s*리팩토|전면\s*(?:개편|리팩토)|architecture\s*improvement|reduced\s+dependenc|major\s+refactor|god-?object\s*(?:해소|제거)|순환\s*참조\s*(?:제거|해소))/i.test(
    text,
  );
}

/** Approx changed-line budget from a successful mutate tool call. */
export function estimateMutateLineDelta(
  toolName: string,
  args: Record<string, unknown>,
): number {
  if (toolName === 'edit_file') {
    const oldT = String(args.old_text ?? args.oldText ?? '');
    const newT = String(args.new_text ?? args.newText ?? '');
    const ol = oldT ? oldT.split(/\r?\n/).length : 0;
    const nl = newT ? newT.split(/\r?\n/).length : 0;
    return Math.max(ol, nl, Math.abs(nl - ol));
  }
  if (toolName === 'write_file') {
    const content = String(args.content ?? '');
    return content ? content.split(/\r?\n/).length : 0;
  }
  if (toolName === 'apply_patch') {
    const patch = typeof args.patch === 'string' ? args.patch : '';
    if (patch) {
      let n = 0;
      for (const line of patch.split(/\r?\n/)) {
        if (/^[+-]/.test(line) && !/^\+\+\+|^---/.test(line)) n += 1;
      }
      if (n > 0) return n;
    }
    if (Array.isArray(args.files)) {
      let n = 0;
      for (const f of args.files) {
        if (!f || typeof f !== 'object') continue;
        const edits = (f as { edits?: unknown }).edits;
        if (!Array.isArray(edits)) continue;
        for (const e of edits) {
          if (!e || typeof e !== 'object') continue;
          const ot = String((e as { old_text?: string }).old_text ?? '');
          const nt = String((e as { new_text?: string }).new_text ?? '');
          n += Math.max(ot.split(/\r?\n/).length, nt.split(/\r?\n/).length);
        }
      }
      return n;
    }
  }
  if (toolName === 'delete_file' || toolName === 'rename_file') return 1;
  return 0;
}

/**
 * Session mutate looks cosmetic: few files + small line delta, or thin re-export façades.
 */
export function isCosmeticSessionMutate(opts: {
  mutatedPaths: string[];
  approxLineDelta: number;
  fileContents?: Map<string, string> | Record<string, string>;
}): boolean {
  const paths = opts.mutatedPaths.filter(Boolean);
  if (!paths.length) return false;
  if (paths.length > 3) return false;
  if (opts.approxLineDelta > 0 && opts.approxLineDelta < 8) return true;
  if (opts.approxLineDelta >= 8) return false;

  const map =
    opts.fileContents instanceof Map
      ? opts.fileContents
      : new Map(Object.entries(opts.fileContents ?? {}));
  if (!map.size) return paths.length <= 1;

  let cosmeticFiles = 0;
  for (const [, raw] of map) {
    const body = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
      .trim();
    const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    const nonExport = lines.filter(
      (l) =>
        !/^(?:export\s+)?(?:type\s+)?(?:\*|\{|import\b|export\b)/.test(l)
        && !/^from\s+['"]/.test(l)
        && !/^['"].*['"];?$/.test(l),
    );
    if (nonExport.length <= 2 && lines.length <= 40) cosmeticFiles += 1;
  }
  return cosmeticFiles > 0 && cosmeticFiles >= Math.min(paths.length, map.size);
}

export function formatOverFramingNudge(opts: {
  mutatedPaths: string[];
  approxLineDelta: number;
}): string {
  return [
    'SYSTEM: Your disk mutation looks cosmetic (import/re-export or tiny hunk),',
    `but the final text over-claims architecture/structure improvement (Δ≈${opts.approxLineDelta} lines, files: ${opts.mutatedPaths.join(', ') || '(none)'}).`,
    'Do NOT claim 아키텍처 개선 / 의존성 축소 / 대규모 리팩토 / architecture improvement.',
    'Rewrite honestly as a minor path re-export or small edit. Prefer 「부분 반영」 or 「경로 정리」.',
    'Reply again with accurate framing only — no embellishment.',
  ].join('\n');
}

export function formatOverFramingRewrite(text: string, opts: {
  mutatedPaths: string[];
  approxLineDelta: number;
}): string {
  const paths = opts.mutatedPaths.join(', ') || '(없음)';
  return [
    '부분 반영 — 소규모 경로/re-export 조정만 확인되었습니다.',
    `변경 경로: ${paths} (대략 ${opts.approxLineDelta || '?'}줄 규모).`,
    '아키텍처 개선·의존성 축소·대규모 리팩토로 보지 않습니다.',
    '',
    '원문 요약(과장 제거 전 참고):',
    text.trim().slice(0, 400),
  ].join('\n');
}

/** Prose claims typecheck/diagnostics/tests passed. */
export function contentClaimsVerifySuccess(text: string): boolean {
  return /(?:타입\s*체크|typecheck|tsc(?:\s|--)|diagnostics?|린트|lint|테스트|tests?).{0,24}(?:통과|완료|성공|pass(?:ed)?|ok\b)|(?:통과|완료|성공)(?:했|함).{0,16}(?:타입|tsc|진단|diagnostics?|테스트)|(?:검증|diagnostics?|run_diagnostics|run_tests).{0,20}(?:통과|완료|성공|pass)/i.test(
    text,
  );
}

export function hasUsableVerifyWitness(
  witness: VerifyWitness | null | undefined,
  diagnostics: true | false | null | 'weak',
): boolean {
  if (witness?.ok === true) return true;
  return diagnostics === true || diagnostics === 'weak';
}

export function formatVerificationWitnessNote(w: VerifyWitness): string {
  const status = w.ok ? 'PASSED' : 'FAILED';
  const exit = typeof w.exitCode === 'number' ? ` (Exit ${w.exitCode})` : '';
  const cmd = w.command ? ` ${w.command}` : '';
  return [
    `[SYSTEM INTERNAL VERIFY: ${w.kind}${cmd} ${status}${exit}]`,
    w.ok
      ? 'Internal repair witness recorded. Do not cite it unless the user asked or it directly proves the requested outcome.'
      : 'Witness recorded FAIL — do not claim typecheck/diagnostics/tests passed.',
  ].join('\n');
}

export function formatMissingVerifyWitnessNudge(): string {
  return formatExitGateToolNudge({
    gate: 'strong verify witness (run_diagnostics exit 0)',
    toolName: 'run_diagnostics',
    args: {},
    detail: 'FALSE: claimed pass without system witness. Rewrite only after tool result.',
  });
}

/** Strong machine verify only — weak/skipped diagnostics do NOT count as pass. */
export function hasStrongVerifyEvidence(
  witness: VerifyWitness | null | undefined,
  diagnostics: true | false | null | 'weak',
): boolean {
  if (
    witness?.ok === true
    && (witness.exitCode === undefined || witness.exitCode === 0)
  ) {
    return true;
  }
  return diagnostics === true;
}

/** Honest 「미검증」caveat already present (skipped ≠ pass). Ignores auto evidence footer. */
export function contentHasHonestUnverifiedCaveat(text: string): boolean {
  const prose = String(text || '')
    .replace(/###\s*변경\s*증거[\s\S]*$/i, '')
    .trim();
  return /미검증|skipped\s*≠\s*pass|skipped\s*!=\s*pass|진단(?:\s*도구)?(?:가\s*)?(?:없|미감지)|자동\s*(?:검증|진단).{0,12}(?:건너|스킵)|통과\s*아님|검증\s*불가/i.test(
    prose,
  );
}

/**
 * Asks the user to debug / inspect instead of fixing in-tools
 * (console, open the file yourself, 「니가 확인」).
 * Does NOT match honest iframe/security 「새 탭에서 확인」 guidance.
 */
export function contentDefersDebugToUser(text: string): boolean {
  const t = String(text || '').trim();
  if (!t) return false;
  // Honest external-frame guidance is allowed.
  if (
    /(?:X-Frame-Options|frame-ancestors|CSP|보안\s*정책).{0,80}(?:새\s*탭|새탭)/i.test(t)
    && !/(?:콘솔|DevTools|app\.js|직접\s*확인해야)/i.test(t)
  ) {
    return false;
  }
  // Honest HITL Accept + “I will not ask for paste/share” is product truth, not deferral.
  // (Otherwise terminal…실행…결과…공유 spans Accept answers as false defer.)
  if (
    /(?:run_terminal|터미널).{0,64}Accept/i.test(t)
    || /Accept.{0,64}(?:눌러|승인|사용자)/i.test(t)
  ) {
    if (/(?:붙여\s*넣|결과|공유).{0,16}요청하지/i.test(t) || /요청하지\s*않/i.test(t)) {
      return false;
    }
  }
  // Honest shell-handoff rewrite (P87): agent-owned next tool, not user paste.
  if (
    /run_terminal로.{0,64}(?:npm\s+run|빌드|verify)/i.test(t)
    && /사용자\s*붙여\s*넣기\s*요청\s*없음|붙여\s*넣.{0,16}(?:요청하지|요청\s*없음)/i.test(t)
  ) {
    return false;
  }
  // Live P03/gh_explain: 「다음 조치: README 읽어야」 is agent-owned, not user debug.
  if (
    /(?:다음\s*조치(?:는|로)?|next(?:\s*steps?)?)\s*[:：]?\s*.{0,96}(?:README|읽어\s*야|읽어야|확인해야)/i.test(
      t,
    )
    && !/(?:지정하(?:면|면\s*)|요청하(?:시면|면))/i.test(t)
  ) {
    return true;
  }
  // Live P87: 「다음 조치: 빌드와 검증을 실행」 without tools.
  if (
    /(?:다음\s*조치(?:는|로)?|next(?:\s*steps?)?)\s*[:：]?\s*.{0,96}(?:빌드|검증|실행|deploy\/output|배포파일)/i.test(
      t,
    )
    && !/(?:지정하(?:면|면\s*)|요청하(?:시면|면)|없음|완료)/i.test(t)
  ) {
    return true;
  }
  // Live P102: missing absolute docx — asks user to confirm path is reachable then summarize.
  if (
    /호스트에서\s*(?:찾을\s*수\s*없|열\s*수\s*없|접근)/i.test(t)
    && /확인되면.{0,48}(?:요약|읽)/i.test(t)
  ) {
    return true;
  }
  if (/접근\s*가능한지\s*확인되면.{0,48}요약/i.test(t)) return true;
  if (
    /호스트에서\s*(?:찾을\s*수\s*없|열\s*수\s*없)/i.test(t)
    && /요청\s*문구가\s*경로에\s*함께\s*포함/i.test(t)
  ) {
    return true;
  }
  return (
    /(?:개발자\s*도구|콘솔|console|DevTools).{0,40}(?:오류|확인|보라|보세요|열어서)/i.test(t)
    || /(?:다음으로|먼저).{0,48}(?:내용을?\s*)?확인해야\s*(?:정확히\s*)?(?:수정|알)/i.test(t)
    || /(?:app\.js|index\.html|styles\.css).{0,48}확인해야/i.test(t)
    || /버튼이\s*없(?:다면|으면).{0,80}(?:Ctrl\s*\+\s*F5|새로고침|콘솔)/i.test(t)
    || /직접\s*(?:파일을?\s*)?(?:열어|확인|점검).{0,24}(?:보|주)(?:세요|셔야)/i.test(t)
    || /사용자가\s*(?:직접\s*)?(?:확인|디버깅|고쳐)/i.test(t)
    || (
      /(?:로컬\s*)?(?:터미널|terminal|run_terminal).{0,48}(?:실행|명령).{0,40}(?:결과|output).{0,24}(?:보내|붙여|공유)/i.test(t)
      && !/(?:결과|출력|붙여\s*넣|공유).{0,24}(?:요청하지|요청\s*없음|시키지\s*않)/i.test(t)
      && !/(?:Accept|승인).{0,40}(?:사용자|직접)/i.test(t)
      && !/사용자\s*붙여\s*넣기\s*요청\s*없음/i.test(t)
    )
    || /아래\s*(?:명령|command).{0,40}(?:실행|run).{0,40}(?:보내|붙여|share|paste)/i.test(t)
  );
}

export function formatUserDebugDeferralNudge(opts?: { pathHint?: string }): string {
  const path = opts?.pathHint?.trim() || '.';
  return [
    'FALSE: do not ask the user to open DevTools, re-check files, or debug for you.',
    'FALSE: do not ask the user to run terminal/git clone and paste stdout — use run_terminal + read_file in-session.',
    'MY Agent must read/mutate and fix in-session. User-facing status may say 「해결 중」 — not 「확인해 보세요」.',
    'Call NOW, then fix the defect yourself:',
    `TOOL_CALL: {"name":"read_file","arguments":{"path":"${path}"}}`,
    'If the bug is clear, emit edit_file / apply_patch next. Do not defer.',
  ].join('\n');
}

export function formatUserDebugDeferralRewrite(text: string): string {
  return [
    '내부 수정이 필요합니다 — 사용자에게 콘솔/파일 확인을 전가하지 않습니다.',
    '에이전트가 read_file·mutate로 직접 점검·수정해야 합니다. 미반영으로 봅니다.',
    '',
    '차단된 초안 요약:',
    text.trim().slice(0, 320),
  ].join('\n');
}

/**
 * Functional overclaim: treats checklist / iframe preview / guidance as real
 * cross-browser execution, auto-pass, or device-farm verification.
 */
/**
 * Model invents 「잠금 제약으로 index.html 생성 금지」 when the user asked to create it.
 */
export function contentInventedDeliverableLock(text: string, userMessage: string): boolean {
  const t = String(text || '');
  const u = String(userMessage || '');
  if (!/(?:잠금\s*제약|수정\s*금지\s*경로|do-not-touch|생성·변경하지\s*않았다)/i.test(t)) {
    return false;
  }
  const mentionsLockedDeliverable =
    /(?:index\.html|styles\.css|app\.js).{0,120}(?:금지|생성\s*하지|변경하지|손대지)/i.test(t)
    || /(?:금지|손대지|생성\s*하지).{0,120}(?:index\.html|styles\.css|app\.js)/i.test(t);
  if (!mentionsLockedDeliverable) return false;
  return /(?:index\.html|styles\.css|app\.js|만들어|구현|write_file|파일\s*생성)/i.test(u);
}

export function formatInventedDeliverableLockNudge(): string {
  return [
    'ERROR: invented_deliverable_lock — 사용자가 생성하라고 한 index.html/styles.css/app.js 를',
    'do-not-touch/잠금으로 취급하지 마세요. write_file로 지금 생성하세요.',
  ].join(' ');
}

export function contentHasFunctionalOverclaim(text: string): boolean {
  const t = String(text || '').trim();
  if (!t) return false;
  const claimsRealExec =
    /(?:실제로\s*(?:기능|실행|동작|판정)|자동\s*(?:판정|검증|테스트)|실기기\s*(?:없이|대신).{0,24}(?:검증|통과)|모든\s*브라우저.{0,24}(?:통과|검증|완료)|크로스\s*브라우저.{0,24}(?:자동|완료|통과))/i.test(
      t,
    );
  const claimsImpossibleEnv =
    /(?:iOS\s*Safari|WebKit|실기기).{0,40}(?:재현|통과|검증)\s*(?:했|완료|가능)/i.test(t)
    && /(?:iframe|뷰어|미리\s*보기)/i.test(t);
  const claimsFrameBypass =
    /(?:X-Frame-Options|frame-ancestors|CSP).{0,40}(?:우회|무시|해결)\s*(?:했|함|가능)/i.test(t);
  return claimsRealExec || claimsImpossibleEnv || claimsFrameBypass;
}

export function formatFunctionalOverclaimNudge(): string {
  return [
    'FALSE: do not over-claim product capability.',
    'Checklist / localStorage / iframe viewport ≠ automatic cross-browser or real-device verification.',
    'iframe cannot bypass X-Frame-Options/CSP. iOS Safari/WebKit is not reproduced in Chromium iframe.',
    'Rewrite honestly: what was implemented, what remains manual/미검증, what tools cannot do.',
    'Prefer 「수동 점검 기록」 or 「부분 반영」 — never 「실제로 기능/자동 판정/모든 브라우저 통과」.',
  ].join('\n');
}

export function formatFunctionalOverclaimRewrite(text: string): string {
  return [
    '부분 반영 — 기능 과대 주장을 제거했습니다.',
    '구현된 범위만 보고하세요. 자동 크로스브라우저·실기기·iframe 우회는 수행하지 않습니다.',
    '미검증 항목은 미검증으로 남깁니다.',
    '',
    '원문 요약(과장 제거 전 참고):',
    text.trim().slice(0, 400),
  ].join('\n');
}

/**
 * Shell/UI integration overclaim: 「연결/연동/인앱에서 열림」 without a real call path.
 * `<a href>` alone is not enough — need postMessage bridge or NavigationStarting → OpenInAppBrowser.
 */
export function contentClaimsShellIntegration(text: string): boolean {
  const t = String(text || '').trim();
  if (!t) return false;
  const claimsInAppOpen =
    /(?:인앱\s*(?:브라우저)?\s*(?:에서\s*)?(?:열|표시)|앱\s*안에서\s*(?:열|표시)|BrowserWebView|InAppBrowser)/i.test(
      t,
    );
  const claimsWire =
    /(?:채팅|메시지|링크|URL).{0,28}(?:연결|연동|가로채|우선\s*사용)|(?:연결|연동).{0,28}(?:인앱|BrowserWebView|셸|WebView)|(?:클릭).{0,20}(?:인앱|BrowserWebView)|인앱\s*브라우저를\s*우선/i.test(
      t,
    );
  return claimsInAppOpen || claimsWire;
}

/** True when mutated file text includes an actual open path (not just an `<a href>`). */
export function snippetsHaveShellIntegrationCallPath(contents: Iterable<string>): boolean {
  const blob = [...contents].join('\n');
  if (!blob.trim()) return false;
  const postMessageBridge =
    /inAppBrowser\.(?:open|navigate)/i.test(blob)
    || (/chrome\.webview\.postMessage/i.test(blob) && /inAppBrowser/i.test(blob))
    || (/postMessage\s*\(\s*\{[^}]{0,120}type\s*:\s*['"]inAppBrowser\./i.test(blob));
  const navHook =
    /NavigationStarting/i.test(blob)
    && /OpenInAppBrowser/i.test(blob);
  return postMessageBridge || navHook;
}

export function formatShellIntegrationOverclaimNudge(): string {
  return [
    'FALSE: do not claim shell/UI 「연결/연동/인앱에서 열림」 without a call path on disk.',
    '`<a href="https://…">` alone is NOT wired. Required evidence in mutated files:',
    '- chrome.webview.postMessage({ type: "inAppBrowser.open", url }) — or',
    '- NavigationStarting → OpenInAppBrowser (shell), with ChatPane actually invoking that path.',
    'Either implement the bridge, or rewrite as 부분 반영 / 미검증 (no 연결 완료).',
    'UI Done = user Acceptance path (click → right panel URL), not tsc/dotnet build alone.',
  ].join('\n');
}

export function formatShellIntegrationOverclaimRewrite(text: string): string {
  return [
    '부분 반영 — 셸/인앱 「연결·연동」 주장을 제거했습니다.',
    '호출 경로(postMessage inAppBrowser.open 또는 NavigationStarting→OpenInAppBrowser) 증거가 없습니다.',
    '`<a href>`만으로는 인앱 브라우저 연결로 보지 않습니다. 미검증으로 남깁니다.',
    '',
    '원문 요약:',
    text.trim().slice(0, 400),
  ].join('\n');
}

export function formatDoneClaimNeedsVerifyNudge(): string {
  return formatExitGateToolNudge({
    gate: 'diagnostics pass before 완료 claim (weak/skipped ≠ pass)',
    toolName: 'run_diagnostics',
    args: {},
    detail: 'If no linter exists, reply 미검증 — do not imply 통과.',
  });
}

export function formatDoneClaimUnverifiedRewrite(text: string): string {
  return [
    '미검증 — 시스템 diagnostics pass 증인이 없어 완료·통과로 처리하지 않습니다.',
    '변경이 있었다면 경로만 보고하고, skipped ≠ pass를 명시하세요.',
    '',
    '원문 요약:',
    text.trim().slice(0, 360),
  ].join('\n');
}
