/**
 * Thin agentic planner note: force plan→execute→verify shape inside AGENT mode
 * for multi-file / large-scope work (no separate planner model).
 */
/**
 * Compact Coding IQ + Autopilot in ONE system block (reduces prompt tax vs Cursor/Claude).
 */
export function formatCodingSpineSystemNote(opts?: {
  autopilot?: boolean;
  compactUnderstanding?: boolean;
}): string {
  const lines: string[] = ['## Coding spine'];
  if (opts?.compactUnderstanding || opts?.autopilot) {
    lines.push(
      'One line then TOOL_CALL: 목표 + ≤2 paths + Exit Gate(disk/command). Card alone = FAIL.',
    );
  } else {
    lines.push(
      'Before first TOOL_CALL ≤4 bullets: 목표 | 대상≤3 | P0 | Exit Gate — then mutate immediately.',
    );
  }
  if (opts?.autopilot) {
    lines.push(
      'Autopilot ON: finish THIS run — no 「다음 조치」. discover→mutate→verify→repair, then answer in the model-chosen form.',
      'Open Exit Gate: close THAT gate only. Honor ASK/PLAN + do-not-touch.',
    );
  } else {
    lines.push('Prefer edit_file / apply_patch. Do not ask for 「진행」.');
  }
  return lines.join('\n');
}

/**
 * ADR-006 Coding IQ — short understanding before mutate (not a PLAN lock).
 * Injected in AGENT mutate turns; model must still call tools in the same turn.
 * `compact`: Autopilot simple edits — skip 4-bullet prose tax (Cursor/Claude-like).
 */
export function formatUnderstandingCardSystemNote(opts?: { compact?: boolean }): string {
  if (opts?.compact) {
    return formatCodingSpineSystemNote({ compactUnderstanding: true });
  }
  return [
    '## Understanding Card (required, then mutate)',
    'Before the first TOOL_CALL, write at most 4 bullets (Korean OK):',
    '1. 목표: one sentence',
    '2. 대상 파일: ≤3 real paths (from tools/index — do not invent)',
    '3. P0: 신규/기존 | artifactKind/runtimeSurface | 손대지 말 것 | 진입점 | 필수 env',
    '4. Exit Gate 1개: disk/command evidence that closes this turn',
    'Discord/매크로/스케줄 → Node bot 우선 (웹 SPA 기본 금지). OpenClaw≠개인 봇.',
    'Unknown organization data sources → domain-connectors.json; fixture/ASSUMED_SCHEMA only; 실REST invent 금지.',
    '개인 Discord는 Webhook URL 우선(봇 토큰은 명시 시에만). Webhook 없으면 게시 완료 금지.',
    'Then IMMEDIATELY call edit_file / apply_patch / write_file. Card alone is FAIL.',
    'Do not ask for 「진행」. Do not claim 읽기 전용.',
    'After search_files / query_repo_map hits: read_file those paths once, then mutate — never re-run the same search.',
    'Never paste TOOL_LOOP_GUARD / tool raw errors into the user reply; keep 「해결 중…」 and change strategy.',
  ].join('\n');
}

/**
 * Spec-driven agentic loop — lean (Cursor/Claude tax ↓). Keep Acceptance P0.
 */
export function formatAgenticLoopSystemNote(): string {
  return [
    '## Agentic loop (Planner → Executor → Verify)',
    '1. PLANNER — short PLAN: 목표 | P0(신규/기존·artifactKind·do-not-touch·진입점·필수env) | 대상 파일 | Acceptance 클릭경로 1줄(UI만) | 검증(diagnostics/tests).',
    '2. EXECUTOR — search/map once → read hit paths → apply_patch/edit_file. Same search twice = blocked. Honor artifact contract scaffold.',
    '3. VERIFY — run_diagnostics (+ run_tests). On INTERNAL_VERIFY_FAILED: repair until pass/EXHAUSTED.',
    'No 「진행」 wait in AGENT. Honor Locked constraints + Artifact contract. The model chooses the final answer structure and preserves useful findings; no automatic paths/verify footer. Self-check: 미충족이면 완료 금지.',
  ].join('\n');
}

/** Injected for UI/shell/chat feature work — Done = user-visible path, not build green. */
export function formatAcceptanceScenarioSystemNote(): string {
  return [
    '## Acceptance scenario (UI/feature Done)',
    '완료 ≠ tsc/dotnet alone. PLAN P0에 사용자 클릭·화면 경로 1줄.',
    '「연결/인앱」 = call-path 증거(postMessage inAppBrowser.open 또는 NavigationStarting→OpenInAppBrowser). `<a href>` alone = PARTIAL.',
    '도구로 Acceptance 닫을 때까지 「다음 조치」 금지. Preview UI면 같은 턴 workspace:build 권장(다음 AGENT를 sticky 차단하지 말 것).',
  ].join('\n');
}

/** Strict patch / tool output format constraints — lean for every-turn base prompt. */
export function formatPatchFormatConstraints(): string {
  return [
    '## Format constraints (patch / tools)',
    '- Mutate via tools only. Prefer apply_patch (multi) / edit_file (single). old_text unique (≥2 context lines).',
    '- apply_patch atomic: all succeed or none. Fix hunks then resubmit full patch.',
    '- Patch text: *** Begin Patch / *** Update File: path / @@ / -old / +new / *** End Patch',
    '- Or files:[{path, edits:[{old_text,new_text}]}]. No fences in tool args.',
  ].join('\n');
}
