/**
 * P0 — post-mutate structure gate.
 * After edit_file / write_file / apply_patch lands on disk:
 * - JS: node --check
 * - JSON: JSON.parse
 * - TS/TSX: module-scope duplicate declaration scan (no tsc spawn — keep harness light)
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const JS_EXT_RE = /\.(?:js|mjs|cjs)$/i;
const JSON_EXT_RE = /\.json$/i;
const TS_EXT_RE = /\.(?:ts|tsx)$/i;
const POST_MUTATE_SYNTAX_FAILED_RE = /\bERROR:\s*POST_MUTATE_SYNTAX_FAILED\b/;
const POST_MUTATE_SYNTAX_TOOLS = new Set(['write_file', 'edit_file', 'apply_patch']);

/** Top-level decl keywords; indented lines are skipped (class methods, nested blocks). */
const TOP_LEVEL_DECL_RE =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:type|interface|function|class|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/;

export type SyntaxCheckFileResult = {
  path: string;
  ok: boolean;
  checker: 'node --check' | 'JSON.parse' | 'duplicate-decl' | 'skip';
  detail: string;
};

export type PostMutateSyntaxResult = {
  applicable: boolean;
  ok: boolean;
  checked: SyntaxCheckFileResult[];
};

function normalizeRel(p: string): string {
  return String(p || '').trim().replace(/\\/g, '/');
}

function resolveAbs(workspaceRoot: string, relOrAbs: string): string {
  const raw = String(relOrAbs || '').trim();
  if (!raw) return '';
  if (path.isAbsolute(raw) || raw.startsWith('\\\\')) return path.normalize(raw);
  return path.resolve(workspaceRoot, raw);
}

function checkJsFile(abs: string, timeoutMs: number): SyntaxCheckFileResult {
  const proc = spawnSync(process.execPath, ['--check', abs], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 512_000,
    shell: false,
    env: process.env,
  });
  const timedOut = proc.error?.message?.includes('ETIMEDOUT') ?? false;
  const exitCode = proc.status ?? (proc.error ? 1 : 0);
  const detail = [proc.stdout ?? '', proc.stderr ?? '', proc.error?.message ?? '']
    .filter(Boolean)
    .join('\n')
    .trim();
  const ok = exitCode === 0 && !timedOut && !proc.error;
  return {
    path: abs,
    ok,
    checker: 'node --check',
    detail: ok ? 'ok' : detail || `exit ${exitCode}`,
  };
}

function checkJsonFile(abs: string): SyntaxCheckFileResult {
  try {
    JSON.parse(readFileSync(abs, 'utf8'));
    return { path: abs, ok: true, checker: 'JSON.parse', detail: 'ok' };
  } catch (e: unknown) {
    return {
      path: abs,
      ok: false,
      checker: 'JSON.parse',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Count module-scope declarations. Catches agent "refine = append" failures
 * (same export/const pasted 2–4 times) without spawning tsc.
 */
export function findDuplicateModuleDecls(
  source: string,
): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  let inBlockComment = false;

  for (const rawLine of source.split(/\r?\n/)) {
    let line = rawLine;
    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end < 0) continue;
      line = line.slice(end + 2);
      inBlockComment = false;
    }

    const blockStart = line.indexOf('/*');
    const lineComment = line.indexOf('//');
    if (blockStart >= 0 && (lineComment < 0 || blockStart < lineComment)) {
      const end = line.indexOf('*/', blockStart + 2);
      if (end < 0) {
        line = line.slice(0, blockStart);
        inBlockComment = true;
      } else {
        line = line.slice(0, blockStart) + line.slice(end + 2);
      }
    } else if (lineComment >= 0) {
      line = line.slice(0, lineComment);
    }

    // Indented → nested (method / block). Only column-0 decls are module scope.
    if (/^\s/.test(line)) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;

    const m = trimmed.match(TOP_LEVEL_DECL_RE);
    if (!m?.[1]) continue;
    const name = m[1];
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function checkTsDuplicateDecls(abs: string): SyntaxCheckFileResult {
  let source: string;
  try {
    source = readFileSync(abs, 'utf8');
  } catch (e: unknown) {
    return {
      path: abs,
      ok: false,
      checker: 'duplicate-decl',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
  const dups = findDuplicateModuleDecls(source);
  if (!dups.length) {
    return { path: abs, ok: true, checker: 'duplicate-decl', detail: 'ok' };
  }
  return {
    path: abs,
    ok: false,
    checker: 'duplicate-decl',
    detail: dups.map((d) => `${d.name} appears ${d.count} times`).join('\n'),
  };
}

/** Check mutated paths: JS/JSON parse + TS/TSX duplicate decls. */
export function checkPostMutateSyntax(
  workspaceRoot: string,
  paths: string[],
  opts?: { timeoutMs?: number; maxFiles?: number },
): PostMutateSyntaxResult {
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const maxFiles = opts?.maxFiles ?? 12;
  const checked: SyntaxCheckFileResult[] = [];
  const seen = new Set<string>();

  for (const raw of paths) {
    const rel = normalizeRel(raw);
    if (!rel) continue;
    const abs = resolveAbs(workspaceRoot, rel);
    if (!abs || seen.has(abs) || !existsSync(abs)) continue;
    seen.add(abs);

    if (JS_EXT_RE.test(rel) || JS_EXT_RE.test(abs)) {
      checked.push(checkJsFile(abs, timeoutMs));
    } else if (JSON_EXT_RE.test(rel) || JSON_EXT_RE.test(abs)) {
      checked.push(checkJsonFile(abs));
    } else if (TS_EXT_RE.test(rel) || TS_EXT_RE.test(abs)) {
      checked.push(checkTsDuplicateDecls(abs));
    }

    if (checked.length >= maxFiles) break;
  }

  if (!checked.length) {
    return { applicable: false, ok: true, checked: [] };
  }
  return {
    applicable: true,
    ok: checked.every((c) => c.ok),
    checked,
  };
}

export function formatSyntaxBrokenAppendix(result: PostMutateSyntaxResult): string {
  if (!result.applicable || result.ok) return '';
  const fails = result.checked.filter((c) => !c.ok);
  const hasDup = fails.some((f) => f.checker === 'duplicate-decl');
  return [
    '',
    'ERROR: POST_MUTATE_SYNTAX_FAILED',
    hasDup
      ? 'Post-mutate gate failed: duplicate module-scope declarations (refine appended instead of replacing). Delete the older copies — keep one definition of each name.'
      : 'Post-mutate syntax gate failed. Disk write landed but the file does not parse.',
    'Do NOT claim 완료. First line = TOOL_CALL read_file on the broken path, then edit_file/apply_patch to fix, then continue.',
    ...fails.map(
      (f) =>
        `- ${f.path}\n  checker=${f.checker}\n  ${f.detail.split(/\r?\n/).slice(0, 12).join('\n  ')}`,
    ),
  ].join('\n');
}

/** Append syntax gate to a successful mutate tool output. */
export function appendPostMutateSyntaxCheck(
  workspaceRoot: string,
  paths: string[],
  output: string,
): string {
  const result = checkPostMutateSyntax(workspaceRoot, paths);
  const appendix = formatSyntaxBrokenAppendix(result);
  return appendix ? `${output.trimEnd()}\n${appendix}` : output;
}

export function outputHasSyntaxBroken(output: string): boolean {
  return POST_MUTATE_SYNTAX_FAILED_RE.test(String(output || ''));
}

/**
 * Only mutation tools can carry the appendix produced by appendPostMutateSyntaxCheck.
 * Read/search output may legitimately contain the marker as source text and must not
 * start the autonomous syntax-repair loop.
 */
export function toolOutputHasSyntaxBroken(toolName: string, output: string): boolean {
  return POST_MUTATE_SYNTAX_TOOLS.has(String(toolName || ''))
    && outputHasSyntaxBroken(output);
}

export function formatSyntaxBrokenRepairPrompt(payload: {
  output: string;
  attempt: number;
  maxAttempts: number;
  mutatedPaths?: string[];
}): string {
  const paths = (payload.mutatedPaths ?? []).filter(Boolean).slice(0, 12);
  const primaryPath = paths[0];
  const nextCall = primaryPath
    ? `TOOL_CALL: ${JSON.stringify({ name: 'read_file', arguments: { path: primaryPath } })}`
    : 'TOOL_CALL: {"name":"run_diagnostics","arguments":{}}';
  return [
    `INTERNAL_VERIFY_FAILED kind=syntax attempt=${payload.attempt}/${payload.maxAttempts}`,
    paths.length ? `mutated: ${paths.join(', ')}` : null,
    'EXIT_GATE (close this one only): fix the post-mutate parse or duplicate-declaration failure',
    'Do NOT apologize. Do NOT claim success. First line = TOOL_CALL.',
    nextCall,
    'Then edit_file/apply_patch (replace — do not append a second copy of the same export/const), then continue.',
    '',
    '--- syntax gate output ---',
    payload.output.trim().slice(0, 12_000) || '(no output)',
  ]
    .filter((l) => l !== null)
    .join('\n');
}
