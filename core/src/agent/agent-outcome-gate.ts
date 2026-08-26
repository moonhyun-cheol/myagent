/**
 * Outcome gate: block false "수정 완료" claims unless mutate + optional disk probe agree.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolveDevWorkspaceReadPath } from '../security/dev-workspace-guard.js';
import { normalizeAgentPath } from './agent-grounding.js';
import {
  hasStrongVerifyEvidence,
  type VerifyWitness,
} from './agent-claim-gates.js';

export type DiagnosticsEvidenceStatus = true | false | null | 'weak';

const CODEISH_MARKER_RE =
  /`([A-Za-z_#$][\w.#-]{2,63})`|\b(HEADERS|#(?:headers|original|english)Row|ShipTo\w+|englishRow|originalRow|headersRow|parseKo|parseAddress|Buyer Address)\b/g;

const TEXT_EXT_RE = /\.(?:js|mjs|cjs|ts|tsx|jsx|json|html|css|md|xaml|cs|py)$/i;

/** Map run_diagnostics JSON into pass | fail | weak | not-run. skipped ≠ pass. */
export function diagnosticsEvidenceStatus(diag: {
  ok?: boolean;
  skipped?: boolean;
  weak?: boolean;
} | null): DiagnosticsEvidenceStatus {
  if (!diag || typeof diag.ok !== 'boolean') return null;
  if (diag.ok === false && !diag.skipped) return false;
  if (diag.skipped === true || diag.weak === true) return 'weak';
  if (diag.ok === true) return true;
  return 'weak';
}

/** Identifiers the model claimed exist after an edit (for disk probe). */
export function extractClaimedMarkers(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(CODEISH_MARKER_RE)) {
    const token = (m[1] || m[2] || '').trim();
    if (!token || seen.has(token)) continue;
    // Filenames in backticks (`README.md`) are paths, not on-disk code markers.
    // Live workspace_tiny_mutate: probe_miss FP after a real README append.
    if (/\.(?:md|ts|tsx|js|mjs|cjs|json|html|css|xaml|cs|py)$/i.test(token)) continue;
    if (/^(?:README|CHANGELOG|TODO|LICENSE)$/i.test(token)) continue;
    // Live tiny-mutate: user asked to append `# live-bt-ok` — model cites `live-bt-ok`
    // while disk has `# live-bt-ok` / `#live-bt-ok` (probe substring can still miss if
    // fileContents lag). Smoke tokens are not code identifiers.
    if (/^(?:live-bt-ok|bt-ok|smoke-ok|livebtok|live_bt_ok|smoke_ok)$/i.test(token)) continue;
    // Tool / protocol tokens and markdown heading markers (`edit_file`, `#live-bt-ok`).
    if (
      /^(?:write_file|edit_file|apply_patch|read_file|list_directory|search_files|run_diagnostics|run_tests|run_terminal|delete_file|rename_file|TOOL_CALL|AGENT|ASK|PLAN)$/i.test(
        token,
      )
    ) {
      continue;
    }
    if (/^#/.test(token)) continue;
    // Live tiny-mutate: model cited `Add-Content` / `Test-Path` after a real README append.
    if (
      /^(?:Add|Set|Get|Test|New|Remove|Out|Write|Select|Copy|Move|Rename|Join|Split|Push|Pop|Start|Stop|Wait)-[A-Za-z][\w.-]*$/.test(
        token,
      )
    ) {
      continue;
    }
    seen.add(token);
    out.push(token);
    if (out.length >= 12) break;
  }
  return out;
}

export function probeContentsForMarkers(
  contents: string[],
  markers: string[],
): { missing: string[]; found: string[] } {
  if (!markers.length) return { missing: [], found: [] };
  const blob = contents.join('\n');
  const found: string[] = [];
  const missing: string[] = [];
  for (const marker of markers) {
    if (blob.includes(marker)) found.push(marker);
    else missing.push(marker);
  }
  return { missing, found };
}

export function readMutatedFileSnippets(
  workspaceRoot: string,
  mutatedPaths: string[],
  maxFiles = 3,
  maxChars = 80_000,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of mutatedPaths) {
    if (out.size >= maxFiles) break;
    if (!TEXT_EXT_RE.test(rel)) continue;
    try {
      const abs = resolveDevWorkspaceReadPath(workspaceRoot, rel);
      if (!existsSync(abs)) continue;
      const raw = readFileSync(abs, 'utf8');
      out.set(rel, raw.length > maxChars ? raw.slice(0, maxChars) : raw);
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

export interface OutcomeGateInput {
  text: string;
  mutatedOk: boolean;
  mutatedPaths: string[];
  /** File path → content for probe (caller reads disk). */
  fileContents: Map<string, string> | Record<string, string>;
  diagnostics: DiagnosticsEvidenceStatus;
  /** Verify witness from silent/tool diagnostics/tests. */
  verifyWitness?: VerifyWitness | null;
  /** Workspace root for structural deliverable existence checks. */
  workspaceRoot?: string;
}

export interface OutcomeGateResult {
  ok: boolean;
  /** Internal nudge when blocked (model-only). */
  nudge?: string;
  /** User-facing honest exit when claims cannot be supported. */
  userMessage?: string;
  reason?:
    | 'no_claim'
    | 'pass'
    | 'no_mutate'
    | 'diag_fail'
    | 'diag_unverified'
    | 'probe_miss'
    | 'paths_missing'
    | 'plan_unfulfilled'
    | 'partial_as_done';
}

/** Claims a structural split/extract landed (not mere cleanup). */
export function contentClaimsStructuralDeliverable(text: string): boolean {
  return /(?:분리(?:했|함|완료)|추출(?:했|함|완료)|신규\s*(?:모듈|파일)|definitions\.ts|agent-tool-definitions|별도\s*모듈로\s*(?:분리|추출)|레지스트리로\s*(?:이전|분리))/i.test(
    text,
  );
}

/** Honest partial language — allowed without full deliverable probe. */
export function contentClaimsPartialOnly(text: string): boolean {
  return /(?:부분\s*(?:반영|충족|완료)|미완|다음\s*(?:단계|수정)|아직\s*(?:안\s*)?(?:끝|완료)|선행\s*작업)/i.test(
    text,
  );
}

/**
 * Paths the model said it created/split into (backtick or bare relative paths).
 */
export function extractClaimedDeliverablePaths(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const p = normalizeAgentPath(raw.replace(/\\/g, '/').trim());
    if (!p || seen.has(p)) return;
    if (!/\.(?:ts|tsx|js|mjs|cjs|json|md)$/i.test(p)) return;
    if (!/(?:^|\/)(?:core\/|ui\/|tools\/|shell\/)/i.test(p) && !p.includes('/')) {
      // allow bare filenames only when clearly agent-tool-* style
      if (!/^agent-tool-[\w.-]+\.ts$/i.test(p)) return;
    }
    seen.add(p);
    out.push(p);
  };
  for (const m of text.matchAll(/`((?:core|ui|tools|shell)\/[^`\n]+?\.(?:ts|tsx|js|mjs|json|md))`/gi)) {
    push(m[1]!);
  }
  for (const m of text.matchAll(
    /(?:신규|생성|추가|분리|추출|이전)[^\n`]{0,40}`?((?:core|ui|tools)\/[\w./-]+\.(?:ts|tsx|js|mjs))`?/gi,
  )) {
    push(m[1]!);
  }
  for (const m of text.matchAll(/\b(agent-tool-(?:definitions|normalize|types|registry)\.ts)\b/gi)) {
    push(`core/src/agent/${m[1]!}`);
  }
  return out.slice(0, 12);
}

function deliverableExists(workspaceRoot: string, rel: string): boolean {
  try {
    const abs = resolveDevWorkspaceReadPath(workspaceRoot, rel);
    return existsSync(abs);
  } catch {
    return false;
  }
}

function asContentMap(
  fileContents: Map<string, string> | Record<string, string>,
): Map<string, string> {
  if (fileContents instanceof Map) return fileContents;
  return new Map(Object.entries(fileContents));
}

/**
 * Evaluate whether a success-claiming final reply may ship.
 * Non-claim replies always pass.
 */
export function evaluateOutcomeGate(input: OutcomeGateInput): OutcomeGateResult {
  const claims = input.mutatedOk || input.mutatedPaths.length > 0;
  if (!claims) return { ok: true, reason: 'no_claim' };

  if (!input.mutatedOk || input.mutatedPaths.length === 0) {
    return {
      ok: false,
      reason: 'no_mutate',
      nudge: [
        'EXIT_GATE (close this one only): successful mutate on disk OR honest 미반영',
        'FALSE_COMPLETION: no successful mutate this run — do not claim 수정/반영/완료.',
        'TOOL_CALL: {"name":"read_file","arguments":{"path":"."}}',
        'Prefer a real target path, then edit_file/apply_patch, or retract as 미반영. First line = TOOL_CALL.',
      ].join('\n'),
      userMessage:
        '파일 수정이 확인되지 않아 완료로 처리할 수 없습니다. 반영된 변경이 없습니다.',
    };
  }

  if (input.diagnostics === false) {
    return {
      ok: false,
      reason: 'diag_fail',
      nudge: [
        'FALSE_COMPLETION: diagnostics failed. Do not claim success.',
        'Fix with edit_file/apply_patch, then run_diagnostics (and run_tests if present) until exit code 0.',
        `Changed so far: ${input.mutatedPaths.join(', ')}`,
      ].join('\n'),
      userMessage:
        '진단/테스트가 실패해 완료로 처리할 수 없습니다. 수정 후 검증을 다시 실행하세요.',
    };
  }

  // Strong verify required for done claims (null/weak ≠ pass). Exit-code truth is authoritative.
  // Live workspace_tiny_mutate: README one-liner `# live-bt-ok` + 「검증 길게 금지」 —
  // requiring full diagnostics blocked a real md-only smoke mutate (probe_miss FP path).
  const contentMapEarly = asContentMap(input.fileContents);
  const mdOnlyLiveSmoke =
    input.mutatedPaths.length > 0
    && input.mutatedPaths.every((p) => /\.md$/i.test(p))
    && [...contentMapEarly.values()].some((c) => /#\s*(?:live-bt-ok|smoke-ok|bt-ok)/i.test(c));
  if (!hasStrongVerifyEvidence(input.verifyWitness, input.diagnostics)) {
    // diagnostics === false already returned above; md-only live smoke may skip diag_unverified.
    if (!mdOnlyLiveSmoke) {
      return {
        ok: false,
        reason: 'diag_unverified',
        nudge: [
          'EXIT_GATE (close this one only): run_diagnostics exit 0 (weak/skipped ≠ pass)',
          'FALSE_COMPLETION: no strong verify witness after mutate.',
          'TOOL_CALL: {"name":"run_diagnostics","arguments":{}}',
          `Changed so far: ${input.mutatedPaths.join(', ')}`,
          'Or report 미검증 without a completion claim. First line = TOOL_CALL.',
        ].join('\n'),
        userMessage:
          '자동 검증(exit code 0) 증거가 없어 완료로 처리할 수 없습니다. 진단을 통과시키거나 미검증으로 보고하세요.',
      };
    }
  }

  // Live workspace_tiny_mutate: md-only `# live-bt-ok` already on disk — skip code-marker
  // probe (prompt contamination / incidental `HEADERS` etc. caused probe_miss FP).
  const markers = mdOnlyLiveSmoke ? [] : extractClaimedMarkers(input.text);
  if (markers.length) {
    const map = contentMapEarly;
    const contents = [...map.values()];
    if (contents.length) {
      const { found, missing } = probeContentsForMarkers(contents, markers);
      if (found.length === 0) {
        return {
          ok: false,
          reason: 'probe_miss',
          nudge: [
            `FALSE_COMPLETION: claimed done but disk probe missed markers [${missing.slice(0, 8).join(', ')}].`,
            'Mutate again so those markers exist on disk, or retract the completion claim. Do not repeat the same prose.',
            `Probed: ${[...map.keys()].join(', ')}`,
          ].join('\n'),
          userMessage:
            '디스크에서 주장한 식별자를 찾지 못해 완료로 처리할 수 없습니다. 해당 문자열을 파일에 반영하거나 완료 주장을 철회하세요.',
        };
      }
    }
  }

  // Structural refactor claims (분리/추출/신규 모듈) require disk deliverables or partial language.
  if (
    contentClaimsStructuralDeliverable(input.text)
    && !contentClaimsPartialOnly(input.text)
    && input.workspaceRoot
  ) {
    const claimed = extractClaimedDeliverablePaths(input.text);
    if (claimed.length) {
      const missing = claimed.filter((p) => !deliverableExists(input.workspaceRoot!, p));
      if (missing.length) {
        return {
          ok: false,
          reason: 'plan_unfulfilled',
          nudge: [
            'FALSE_COMPLETION: claimed structural split/extract but deliverable paths are missing on disk:',
            missing.map((p) => `- ${p}`).join('\n'),
            'Create those files with write_file/apply_patch, or rewrite as 부분 반영 (not 완료).',
            `Mutated this run: ${input.mutatedPaths.join(', ') || '(none)'}`,
          ].join('\n'),
          userMessage:
            '구조 분리/신규 파일이 디스크에 없어 완료로 처리할 수 없습니다. 부분 반영만 보고하거나 분리를 마저 진행하세요.',
        };
      }
    } else if (input.mutatedPaths.length <= 1) {
      // Claimed structural work but only tiny mutate (e.g. import cleanup) — force honesty.
      return {
        ok: false,
        reason: 'partial_as_done',
        nudge: [
          'FALSE_COMPLETION: claimed module split/extract but this run only touched minimal paths:',
          input.mutatedPaths.map((p) => `- ${p}`).join('\n') || '- (none)',
          'Either finish the structural split (new definition/registry modules), or say 부분 반영 / 미완 — do not claim 완료.',
        ].join('\n'),
        userMessage:
          '구조 리팩토 완료로 보기 어렵습니다. 부분 반영만 확인되었습니다. 분리를 이어가거나 미완으로 보고하세요.',
      };
    }
  }

  return { ok: true, reason: 'pass' };
}

/** Soft length cap for acceptance-review answers (characters). */
export function compressAgentFinalReply(text: string, maxChars = 1100): string {
  const t = dedupeRepeatedReviewBody(text.trim());
  if (t.length <= maxChars) return t;
  // Prefer cutting after the last complete section rather than mid-bullet.
  const slice = t.slice(0, maxChars);
  const markers = ['\n### ', '\n## ', '\n###미충족', '\n### 미충족', '\n4) ', '\n3) ', '\n### 다음', '\n다음 수정'];
  let cut = -1;
  for (const m of markers) {
    const idx = slice.lastIndexOf(m);
    if (idx > maxChars * 0.45) cut = Math.max(cut, idx);
  }
  if (cut < 0) {
    const nl = slice.lastIndexOf('\n');
    cut = nl > maxChars * 0.5 ? nl : maxChars;
  }
  return `${slice.slice(0, cut).trimEnd()}\n… (피드백 길이 상한)`;
}

/** Review answer that lists "I did not measure" as gaps instead of product findings. */
export function contentIsMetaUnmeasuredReview(text: string): boolean {
  const t = String(text || '');
  if (!t.trim()) return false;
  const metaGap =
    /(?:미측정|측정되지\s*않|확인하지\s*않|미검토|검토하지\s*않|우선순위\s*미확정|근거\s*미측정)/i.test(t);
  // 「다음에 측정해서 확정」also counts as deferral, not a product next-step.
  const deferMeasure =
    /(?:측정한\s*뒤|측정\s*후|LOC.{0,12}측정|의존성(?:을|를)?\s*측정).{0,40}(?:확정|분리|리팩토)/i.test(t);
  if (!metaGap && !deferMeasure) return false;
  return /(?:미충족|판정|다음\s*수정)/i.test(t);
}

/** Architecture review that only cites AGENTS.md (no facts/hotspot/.gitignore). */
export function contentIsAgentsOnlyShallowReview(text: string): boolean {
  const t = String(text || '');
  if (!/(?:미충족|부분\s*충족|충족)/i.test(t)) return false;
  const citesAgents = /AGENTS\.md/i.test(t);
  if (!citesAgents) return false;
  const citesDeeper =
    /product-facts|ui-facts|\.gitignore|code-agent\.ts|tools\.ts|dispatch\.ts|R-023|deploy\/output/i.test(t);
  return !citesDeeper;
}

/** True when review reads cover memory + at least one measured artifact. */
export function reviewReadsAreAdequate(successfulReads: string[]): boolean {
  const norm = successfulReads.map((p) => normalizeAgentPath(p).toLowerCase());
  const has = (frag: string) => norm.some((p) => p.includes(frag.toLowerCase()));
  const memory = has('agents.md') || has('product-facts.json') || has('ui-facts.json');
  const measure =
    has('.gitignore')
    || has('code-agent.ts')
    || has('tools.ts')
    || has('dispatch.ts')
    || has('agent-outcome-gate.ts');
  return memory && measure;
}

/** Drop accidental duplicated short-review bodies (same ## 결론 twice). */
export function dedupeRepeatedReviewBody(text: string): string {
  const t = text.trim();
  const re = /^##\s*결론/gm;
  const hits: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) hits.push(m.index);
  if (hits.length < 2) return t;
  return t.slice(0, hits[1]).trimEnd();
}

/** Model answered a review ask with a generic "how can I help?" greeting. */
export function contentIsGreetingEvasion(text: string): boolean {
  const t = String(text || '').trim();
  if (!t || t.length > 500) return false;
  if (/(?:충족|미충족|##\s*결론|다음\s*수정)/i.test(t)) return false;
  return /(?:어떤\s*도움|무엇을\s*도와|도와드릴까요|꺼내놓|말씀해\s*(?:주|주세요)|궁금한\s*사항|무엇을\s*원하|how\s+can\s+i\s+help|what\s+can\s+i\s+(?:do|help))/i.test(
    t,
  );
}

/**
 * Review ask answered with planning theater / "요청 이해" / Chinese preamble
 * instead of the short verdict.
 */
export function contentIsPlanningTheaterEvasion(text: string): boolean {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/(?:충족|미충족|##\s*결론|다음\s*수정)/i.test(t)) return false;
  const theater =
    /(?:다음과\s*같이\s*작업을\s*진행|요청\s*이해|사용자의\s*지시사항|작업을\s*진행하겠습니다|继续翻译|下的继续)/i.test(
      t,
    );
  const chinesePreamble = /[\u4E00-\u9FFF]{2,}/.test(t) && !/(?:충족|미충족)/.test(t);
  return theater || (chinesePreamble && t.length < 1200);
}

/** Any soft evasion of an acceptance/structure review ask. */
export function contentIsReviewEvasion(text: string): boolean {
  return contentIsGreetingEvasion(text) || contentIsPlanningTheaterEvasion(text);
}

export function formatFalseCompletionUserMessage(reason: string): string {
  return [
    '완료 주장이 디스크/진단 증거와 맞지 않아 차단했습니다.',
    `원인: ${reason}`,
    '실제 반영 여부를 확인한 뒤, 미충족이면 미반영으로 답하거나 수정을 이어가세요.',
  ].join('\n');
}

/** User explicitly forbids tool calls this turn. */
export function userForbidsToolUse(message: string): boolean {
  return /(?:도구(?:는|를|을)?\s*(?:쓰지\s*마|사용하지\s*마|호출하지\s*마|사용\s*금지)|do\s*not\s*use\s*tools|without\s*(?:using\s*)?tools|no\s*tools|도구\s*없이)/i.test(
    String(message || ''),
  );
}

/**
 * User wants a fake/hypothetical "done" report (often paired with no tools).
 * Short-circuit: never invent file state or claim completion.
 */
export function userAsksHypotheticalDoneReport(message: string): boolean {
  const t = String(message || '');
  if (/(?:수정했다고\s*가정|가정하고\s*(?:완료|보고)|완료\s*보고만|보고만\s*해)/i.test(t)) {
    return true;
  }
  return userForbidsToolUse(t) && /(?:완료\s*보고|완료했다고|수정했다고)/i.test(t);
}

export const HYPOTHETICAL_DONE_REFUSAL =
  '도구 없이 완료 보고 불가. 미반영.';

/**
 * Assumed smoke / expected field dumps without a real command run.
 * Admitting "미검증" / "실행하지 않음" alone is OK if there is no fabricated field table.
 */
export function contentHasUnverifiedSmokeNarrative(text: string): boolean {
  const t = text.trim();
  if (t.length < 40) return false;
  const assumes =
    /(?:반영되었다고\s*가정|가정한\s*(?:스모크|결과|지정\s*입력)|이\s*상태로\s*실제\s*반영되었다고\s*가정|예상\s*결과|현재\s*예상\s*결과)/i.test(
      t,
    );
  const fieldDump =
    /(?:Ship To Name|Buyer Address\s*[12]|ShipTo Phone|수취인명|주소\s*1)\s*[:：]/.test(t);
  if (assumes && fieldDump) return true;
  // Field dump framed as live parser output while admitting no command was run
  const claimsParserOutput =
    /(?:파서\s*(?:스모크\s*)?결과|영문\s*표준\s*행\s*핵심|원문\s*표준\s*행\s*핵심)/i.test(t)
    && fieldDump;
  const admitsNoRun =
    /(?:실행\s*결과(?:는)?\s*(?:이\s*응답에서는\s*)?(?:수집되지|없)|(?:node\s*--check|run_diagnostics).{0,40}(?:실행하지|돌리지\s*않)|미검증)/i.test(
      t,
    );
  return claimsParserOutput && admitsNoRun;
}

/** Asserts current code shape (구형/미구현) — needs read_file this run. */
export function contentClaimsCurrentCodeShape(text: string): boolean {
  const t = text.trim();
  if (t.length < 40) return false;
  return (
    /(?:아직\s*(?:구형|구현되어\s*있지)|현재.{0,40}(?:구형|legacyAddress|isLikelyName)|표준\s*11개.{0,40}(?:없|미구현|구현되어\s*있지))/i.test(
      t,
    )
    || /(?:카드와\s*`?legacyAddress|필드\s*카드\/통합주소|제공하신\s*원문\s*기준\s*현재\s*예상\s*결과)/i.test(t)
    || /(?:한글\s*이름\s*분리는\s*구현되어\s*있지|isLikelyName\(\).{0,40}영문)/i.test(t)
  );
}

const PATH_IN_PROSE_RE =
  /(?:[\w.-]+\/)*[\w.-]+\.(?:js|mjs|cjs|ts|tsx|jsx|html|css|json|py|cs|xaml|md)/gi;

/** Module stems used in chat without extension (agent-tool-definitions). */
const MODULE_STEM_RE = /\b([a-z][\w]*(?:-[\w]+){1,4})\b/gi;

/** Paths mentioned in the user message (for grounding bootstraps). */
export function extractPathsFromUserMessage(message: string, maxPaths = 4): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const p = raw.replace(/\\/g, '/');
    const key = p.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };
  for (const hit of String(message || '').matchAll(PATH_IN_PROSE_RE)) {
    push(hit[0]);
    if (out.length >= maxPaths) return out;
  }
  for (const hit of String(message || '').matchAll(MODULE_STEM_RE)) {
    const stem = hit[1];
    // Skip common non-module hyphen phrases.
    if (/^(open-webui|full-bleed|one-shot)$/i.test(stem)) continue;
    if (!/(?:^|-)(?:agent|tool|code|chat|ui|repo|run|work|mode|gate|loop)(?:-|$)/i.test(stem)) {
      continue;
    }
    push(`${stem}.ts`);
    if (out.length >= maxPaths) break;
  }
  return out;
}

/** Paths recently claimed as changed in assistant history (for forced re-read on review). */
export function extractRecentMutatedPathsFromHistory(
  history: Array<{ role?: string; content?: string }> | undefined,
  maxPaths = 6,
): string[] {
  if (!history?.length) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = history.length - 1; i >= 0 && out.length < maxPaths; i -= 1) {
    const m = history[i];
    if (m?.role !== 'assistant') continue;
    const content = String(m.content ?? '');
    if (
      !/(?:변경\s*(?:파일|경로|증거)|반영했|수정했|###\s*변경)/i.test(content)
      && !/`[^`]+\.(?:js|ts|tsx|html)`/.test(content)
    ) {
      continue;
    }
    for (const hit of content.matchAll(PATH_IN_PROSE_RE)) {
      const p = hit[0].replace(/\\/g, '/');
      const key = p.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
      if (out.length >= maxPaths) break;
    }
  }
  return out;
}

export function formatForcedReadNudge(paths: string[]): string {
  const path = paths[0] ?? '.';
  return [
    'EXIT_GATE (close this one only): re-read session-mutated file before review',
    'FALSE: do not reuse stale memory. First line = TOOL_CALL.',
    `TOOL_CALL: ${JSON.stringify({ name: 'read_file', arguments: { path } })}`,
    paths.length > 1 ? `Also read when needed: ${paths.slice(1).join(', ')}` : '',
    'Then short review from the tool result only.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatUnverifiedSmokeNudge(): string {
  return [
    'FALSE: unverified smoke narrative (가정/예상 결과 + field dump) is forbidden.',
    'Either run node --check / a real parser smoke via run_terminal and paste exit code + stdout,',
    'or reply in one line: 미검증 — 명령 미실행. Do not invent Ship To / Buyer Address tables.',
  ].join('\n');
}
