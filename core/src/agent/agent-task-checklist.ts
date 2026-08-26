/**
 * Task checklist: map user ask → required paths / retrieval / structural modules.
 * Used by outcome gate + code-agent to block partial-as-done and force index-first.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolveDevWorkspaceReadPath } from '../security/dev-workspace-guard.js';
import { normalizeAgentPath } from './agent-grounding.js';
import { extractPathsFromUserMessage } from './agent-outcome-gate.js';

export type TaskChecklist = {
  /** Explicit paths named in the user message. */
  requiredPaths: string[];
  /** New modules implied by split/extract asks. */
  requireNewModules: string[];
  /** Must call query_repo_map / search_embeddings / search_files before mutate. */
  requireRetrieval: boolean;
  /** Human labels for nudges. */
  labels: string[];
  /** Git workflow state explicitly requested by the user. */
  requiredGitState?: 'initialized' | 'first_commit';
};

const GIT_REPO_CREATE_RE =
  /(?:git\s+init|새\s*(?:git\s*)?(?:repo|repository|리포|저장소)|(?:repo|repository|리포|저장소).{0,16}(?:만들|생성|초기화))/i;
const GIT_INIT_ONLY_RE = /(?:초기화만|init\s+only|커밋(?:은|하지)\s*(?:말|마))/i;

/** Structural module split — not data-field "normalize" / schema mapping. */
const SPLIT_ASK_RE =
  /(?:분리|추출|registry|definitions|normalize\.ts|tool-?normalize|모듈로\s*묶|별도\s*모듈)/i;

/** Create-from-scratch / empty-folder scaffold — skip embedding/repo-map tax. */
const GREENFIELD_RE =
  /(?:처음부터|빈\s*(?:폴더|디렉토리|워크스페이스|Desktop)|신규\s*(?:앱|프로젝트|파일)|greenfield|scaffold|from\s+scratch|만들어라|만들어\s*(?:줘|주세요)|생성해\s*(?:줘|라)|새로\s*만들|한\s*실행에서\s*완성)/i;

/**
 * Cold multi-file create (path list + write_file / demo scaffold) on empty tree.
 * Retrieval tax is wrong here — nothing useful to search/embed yet.
 */
const COLD_CREATE_RE =
  /(?:write_file|필수\s*파일|SEED\.md|데모\s*프로젝트|all\s+write|생성\s*하기\s*전|missing\s*0|멀티스킬|maxstress|max.?stress)/i;

const RETRIEVAL_TOOLS = new Set([
  'query_repo_map',
  'search_embeddings',
  'search_files',
]);

/** True when the user asks to scaffold a new app in an empty/new folder. */
export function looksLikeGreenfieldScaffold(userMessage: string): boolean {
  return GREENFIELD_RE.test(String(userMessage || ''));
}

/**
 * Explicit multi-path create (not product refactor). Desktop maxstress / path-list demos.
 */
export function looksLikeColdMultiCreate(userMessage: string): boolean {
  const t = String(userMessage || '').trim();
  if (!t) return false;
  if (
    /(?:리팩토|리펙토|분리해|재구성|버그|고쳐|수정해\s*줘)/i.test(t)
    && !/(?:write_file|필수\s*파일|SEED\.md)/i.test(t)
  ) {
    return false;
  }
  const pathHits = extractPathsFromUserMessage(t, 24);
  if (pathHits.length >= 3 && COLD_CREATE_RE.test(t)) return true;
  if (
    pathHits.length >= 4
    && /(?:완성|구현|생성|scaffold|데모)/i.test(t)
    && !/(?:리팩토|분리해|버그\s*수정)/i.test(t)
  ) {
    return true;
  }
  return false;
}

/**
 * Soft default file set when the user asks greenfield without naming paths.
 * Multi-path Exit Gate uses these so Autopilot does not stop after one write_file.
 */
export const DEFAULT_GREENFIELD_PATHS = [
  'index.html',
  'app.js',
  'styles.css',
  'package.json',
  'README.md',
] as const;

/** Infer checklist from the latest user message. */
export function buildTaskChecklist(userMessage: string): TaskChecklist {
  const t = String(userMessage || '').trim();
  let requiredPaths = extractPathsFromUserMessage(t, 12).map((p) => normalizeAgentPath(p));
  const requireNewModules: string[] = [];
  const labels: string[] = [];
  const gitRepoCreate = GIT_REPO_CREATE_RE.test(t);
  const requiredGitState: TaskChecklist['requiredGitState'] = gitRepoCreate
    ? GIT_INIT_ONLY_RE.test(t) ? 'initialized' : 'first_commit'
    : undefined;
  if (requiredGitState) labels.push(`git-${requiredGitState}`);

  if (SPLIT_ASK_RE.test(t) && /(?:tools\.ts|도구\s*정의|tool\s*definition|레지스트리)/i.test(t)) {
    requireNewModules.push(
      'core/src/agent/agent-tool-definitions.ts',
      'core/src/agent/agent-tool-normalize.ts',
    );
    labels.push('tools registry split');
  } else if (SPLIT_ASK_RE.test(t) && /(?:인덱싱|repo-map|embedding|index\/)/i.test(t)) {
    requireNewModules.push('core/src/agent/index/public.ts');
    labels.push('indexing façade');
  } else if (SPLIT_ASK_RE.test(t)) {
    labels.push('structural split');
  }

  const greenfieldPhrase = !gitRepoCreate && looksLikeGreenfieldScaffold(t);
  const coldCreate = looksLikeColdMultiCreate(t);
  const greenfield = greenfieldPhrase || coldCreate;
  if (greenfieldPhrase) labels.push('greenfield');
  if (coldCreate) labels.push('cold-create');

  // Soft seed: path-free greenfield phrase → default multi-file set.
  if (greenfieldPhrase && requiredPaths.length === 0 && requireNewModules.length === 0) {
    requiredPaths = DEFAULT_GREENFIELD_PATHS.map((p) => normalizeAgentPath(p));
    labels.push('greenfield-default-set');
  }

  // Same-product restructure: still may want retrieval soft-path, but label for audits.
  if (/(?:재구성|구조\s*정리|폴더\s*정리|adapters\/|delivery\/)/i.test(t)) {
    labels.push('restructure');
  }

  // Cold create / greenfield: do not tax empty workspaces with repo-map/embeddings.
  const requireRetrieval = false;

  if (requireRetrieval) labels.push('retrieval-first');

  return { requiredPaths, requireNewModules, requireRetrieval, labels, requiredGitState };
}

export function formatGitWorkflowSystemNote(checklist: TaskChecklist): string {
  if (!checklist.requiredGitState) return '';
  return [
    '## Git repository completion contract',
    'This is a Git workflow, not a greenfield web scaffold. Do not invent default app files.',
    'Use git_init(confirm=true), then git_status.',
    checklist.requiredGitState === 'first_commit'
      ? 'Finish with git_commit(confirm=true, paths=[all intended tracked and untracked files]) and verify git_status. A staged-only repository is incomplete.'
      : 'Stop after git_init + git_status; no commit was requested.',
  ].join('\n');
}

function gitStateSatisfied(workspaceRoot: string, required: TaskChecklist['requiredGitState']): boolean {
  if (!required) return true;
  try {
    const marker = path.join(workspaceRoot, '.git');
    if (!existsSync(marker)) return false;
    let gitDir = marker;
    if (!statSync(marker).isDirectory()) {
      const link = readFileSync(marker, 'utf8').match(/^gitdir:\s*(.+)$/im)?.[1]?.trim();
      if (!link) return false;
      gitDir = path.resolve(workspaceRoot, link);
    }
    if (required === 'initialized') return existsSync(path.join(gitDir, 'HEAD'));
    const head = readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40,64}$/i.test(head)) return true;
    const ref = head.match(/^ref:\s*(.+)$/i)?.[1]?.trim();
    if (!ref) return false;
    if (existsSync(path.join(gitDir, ...ref.split('/')))) return true;
    const packed = path.join(gitDir, 'packed-refs');
    return existsSync(packed)
      && readFileSync(packed, 'utf8').split(/\r?\n/).some((line) => line.endsWith(` ${ref}`));
  } catch {
    return false;
  }
}

/** System note when soft greenfield default set is active. */
export function formatGreenfieldDefaultSetNote(checklist: TaskChecklist): string {
  if (!checklist.labels.includes('greenfield-default-set')) return '';
  const paths = checklist.requiredPaths.length
    ? checklist.requiredPaths
    : [...DEFAULT_GREENFIELD_PATHS];
  return [
    '## Greenfield default file set (soft Exit Gate)',
    'User did not name paths — write at least this minimum set (then any extras):',
    ...paths.map((p) => `- ${p}`),
    '## Stream-safe creates (OWUI)',
    'Each TOOL_CALL turn: at most 2 write_file calls (small chunks). Then continue next step until the set is on disk.',
    'Do NOT emit 5–8 large write_file bodies in one model response — upstream streams often terminate (~60s).',
    'Prefer short files first (README / data JSON), then HTML/CSS/JS. Autopilot keeps going in this run — do not stop after one file.',
    'If the product is clearly not a web scaffold, adapt extensions but keep ≥3 real deliverable files + README.',
  ].join('\n');
}

/**
 * Injected for cold multi-file / named-path scaffolds (even when default-set note is empty).
 */
export function formatStreamSafeWriteNote(message: string): string {
  const t = String(message || '');
  if (!looksLikeGreenfieldScaffold(t) && !looksLikeColdMultiCreate(t)) return '';
  if (!/(?:write_file|\.html|\.css|\.js|README|docs\/|data\/|필수\s*파일|여러\s*파일|한\s*번에)/i.test(t)) {
    return '';
  }
  return [
    '## Stream-safe multi-file create',
    '≤2 write_file per TOOL_CALL turn. Close the full file list across steps in THIS run (Autopilot).',
    'Avoid one mega-response with every file body — OWUI/OpenRouter often drops long streams (terminated).',
  ].join('\n');
}

export function formatRetrievalFirstSystemNote(): string {
  return [
    '## Retrieval first (index before mutate)',
    'Before the first edit_file / write_file / apply_patch in this run, call at least one of:',
    'query_repo_map | search_embeddings | search_files',
    'Then read_file the target(s). Do not mutate from memory alone on multi-file / refactor tasks.',
  ].join('\n');
}

function pathExists(workspaceRoot: string, rel: string): boolean {
  try {
    return existsSync(resolveDevWorkspaceReadPath(workspaceRoot, rel));
  } catch {
    return false;
  }
}

function pathSatisfied(
  workspaceRoot: string,
  rel: string,
  mutatedPaths: string[],
): boolean {
  const n = normalizeAgentPath(rel).toLowerCase();
  const mutated = mutatedPaths.some((p) => {
    const m = normalizeAgentPath(p).toLowerCase();
    return m === n || m.endsWith('/' + n) || n.endsWith('/' + m) || m.endsWith(n.split('/').pop()!);
  });
  if (mutated) return true;
  return pathExists(workspaceRoot, rel);
}

export type ChecklistEvalInput = {
  checklist: TaskChecklist;
  workspaceRoot: string;
  mutatedPaths: string[];
  toolsUsed: string[];
  /** Assistant claimed full completion. */
  claimsDone: boolean;
  claimsPartial: boolean;
};

export type ChecklistEvalResult = {
  ok: boolean;
  missingPaths: string[];
  missingRetrieval: boolean;
  missingGitState?: TaskChecklist['requiredGitState'];
  nudge?: string;
  reason?: 'ok' | 'missing_paths' | 'missing_retrieval' | 'partial_ok';
};

/** Compare checklist against disk + tools used this run. */
export function evaluateTaskChecklist(input: ChecklistEvalInput): ChecklistEvalResult {
  const { checklist, workspaceRoot, mutatedPaths, toolsUsed, claimsDone, claimsPartial } =
    input;

  if (claimsPartial && !claimsDone) {
    return { ok: true, missingPaths: [], missingRetrieval: false, reason: 'partial_ok' };
  }

  const missingPaths: string[] = [];
  for (const p of [...checklist.requiredPaths, ...checklist.requireNewModules]) {
    if (!pathSatisfied(workspaceRoot, p, mutatedPaths)) missingPaths.push(p);
  }

  const usedRetrieval = retrievalToolsUsed(toolsUsed, checklist);
  const missingRetrieval =
    checklist.requireRetrieval
    && mutatedPaths.length > 0
    && !usedRetrieval;
  const missingGitState = gitStateSatisfied(workspaceRoot, checklist.requiredGitState)
    ? undefined
    : checklist.requiredGitState;

  if (!missingPaths.length && !missingRetrieval && !missingGitState) {
    return { ok: true, missingPaths: [], missingRetrieval: false, reason: 'ok' };
  }

  if (missingGitState) {
    return {
      ok: false,
      missingPaths,
      missingRetrieval,
      missingGitState,
      reason: 'missing_paths',
      nudge: missingGitState === 'first_commit'
        ? 'GIT_WORKFLOW_INCOMPLETE: repository has no HEAD commit. Use git_status, then git_commit with confirm=true and explicit paths. Verify git_status before finishing.'
        : 'GIT_WORKFLOW_INCOMPLETE: initialize the selected workspace with git_init(confirm=true), then verify git_status.',
    };
  }

  // Only block hard when the model claims done (or we always nudge retrieval mid-run).
  if (!claimsDone && missingRetrieval && !missingPaths.length) {
    return {
      ok: false,
      missingPaths: [],
      missingRetrieval: true,
      reason: 'missing_retrieval',
      nudge: [
        'RETRIEVAL_REQUIRED: you mutated without query_repo_map / search_embeddings / search_files.',
        'Call one retrieval tool now, then continue edits. Do not claim 완료 yet.',
      ].join('\n'),
    };
  }

  const multiPathAsk =
    checklist.requiredPaths.length + checklist.requireNewModules.length >= 2;

  // Multi-path create/edit: do not allow prose finish while required paths still missing
  // (even without 「완료」 claim — models stop after 1–2 write_file).
  if (missingPaths.length && multiPathAsk && mutatedPaths.length > 0) {
    return {
      ok: false,
      missingPaths,
      missingRetrieval,
      reason: 'missing_paths',
      nudge: [
        'CHECKLIST_UNFULFILLED: multi-path user ask incomplete on disk.',
        `Missing paths:\n${missingPaths.map((p) => `- ${p}`).join('\n')}`,
        'Write every missing path with write_file / apply_patch. Do not summarize partial work as done.',
        `Mutated so far: ${mutatedPaths.join(', ') || '(none)'}`,
      ].join('\n'),
    };
  }

  if (claimsDone && (missingPaths.length || missingRetrieval)) {
    return {
      ok: false,
      missingPaths,
      missingRetrieval,
      reason: missingPaths.length ? 'missing_paths' : 'missing_retrieval',
      nudge: [
        'CHECKLIST_UNFULFILLED: user ask not met on disk / retrieval.',
        missingPaths.length
          ? `Missing paths:\n${missingPaths.map((p) => `- ${p}`).join('\n')}`
          : '',
        missingRetrieval
          ? 'No query_repo_map / search_embeddings / search_files this run before mutate.'
          : '',
        'Finish the checklist with tools, or rewrite as 부분 반영 (not 완료).',
        `Mutated: ${mutatedPaths.join(', ') || '(none)'}`,
        `Labels: ${checklist.labels.join(', ') || '(none)'}`,
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }

  if (missingPaths.length && mutatedPaths.length > 0 && !claimsDone) {
    // Single-path / soft: allow continue without claiming done
    return { ok: true, missingPaths, missingRetrieval, reason: 'ok' };
  }

  return { ok: true, missingPaths, missingRetrieval: false, reason: 'ok' };
}

/**
 * True when requiredPaths/modules (if any) are satisfied on disk/mutate evidence.
 * Used to stop Autopilot force-loops after multi-file greenfield completes.
 */
export function isTaskChecklistComplete(input: {
  checklist: TaskChecklist;
  workspaceRoot: string;
  mutatedPaths: string[];
  toolsUsed?: string[];
}): boolean {
  const { checklist, workspaceRoot, mutatedPaths, toolsUsed = [] } = input;
  const needed = checklist.requiredPaths.length + checklist.requireNewModules.length;
  if (checklist.requiredGitState) {
    return gitStateSatisfied(workspaceRoot, checklist.requiredGitState);
  }
  if (needed === 0) {
    // No explicit path list — mutate-only gate for greenfield-style freeform tasks.
    return mutatedPaths.length > 0;
  }
  const r = evaluateTaskChecklist({
    checklist,
    workspaceRoot,
    mutatedPaths,
    toolsUsed,
    claimsDone: true,
    claimsPartial: false,
  });
  return r.ok && (!r.missingPaths || r.missingPaths.length === 0);
}

export function retrievalToolsUsed(
  toolsUsed: Iterable<string>,
  checklist?: TaskChecklist | null,
): boolean {
  for (const n of toolsUsed) {
    if (RETRIEVAL_TOOLS.has(n)) return true;
  }
  // Soft: list_directory OR read_file satisfies retrieval-first for create/multi-file
  // restructure. Hard structural (registry extract / new modules) still need index tools.
  // `restructure` wins over a lone "structural split" false-positive (e.g. data "normalize").
  const hardStructural =
    !!checklist
    && (
      checklist.requireNewModules.length > 0
      || checklist.labels.some((l) =>
        /tools registry split|indexing\s*fa[cç]ade/i.test(l),
      )
    );
  const softOk =
    checklist
    && checklist.requireRetrieval
    && !hardStructural
    && (
      checklist.labels.includes('restructure')
      || !checklist.labels.some((l) => /split|façade|facade|indexing/i.test(l))
    );
  if (softOk) {
    for (const n of toolsUsed) {
      if (n === 'list_directory' || n === 'read_file') return true;
    }
  }
  return false;
}
