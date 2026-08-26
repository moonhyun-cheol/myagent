/**
 * Thin CLI probes for repomix / ast-grep (ADR-009 Wave 2 OSS-A09/A10).
 * Prefers runtime/oss-sidecars portable bins from install bootstrap.
 */
import { spawnSync } from 'node:child_process';
import type { SidecarResult } from './types.js';
import { resolveBundledAstGrepBinary, resolveBundledRepomixBinary } from './oss-paths.js';

export function runRepomixSidecar(opts: {
  workspaceRoot: string;
  args?: string[];
}): SidecarResult {
  const bin = resolveBundledRepomixBinary();
  if (!bin) {
    return {
      ok: false,
      engine: 'repomix',
      summaryKo:
        'repomix가 없습니다. install/START(oss-sidecars) 또는 `npm i -g repomix` 후 재시도하세요.',
      artifacts: [],
      mutations: [],
      evidence: [],
      error: 'REPOMIX_NOT_FOUND',
    };
  }
  const r = spawnSync(bin, opts.args?.length ? opts.args : ['--stdout'], {
    cwd: opts.workspaceRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    shell: process.platform === 'win32' && bin.endsWith('.cmd'),
  });
  const out = String(r.stdout || '');
  return {
    ok: r.status === 0,
    engine: 'repomix',
    summaryKo:
      r.status === 0
        ? `repomix 출력 ${out.length} chars (지식 컨텍스트용).`
        : `repomix 실패: ${String(r.stderr || '').slice(0, 300)}`,
    artifacts: [],
    mutations: [],
    evidence: [{ kind: 'stdout', detail: out.slice(0, 12_000) }],
    error: r.status === 0 ? undefined : 'REPOMIX_EXIT',
    rawLog: out.slice(0, 50_000),
  };
}

export function runAstGrepSidecar(opts: {
  workspaceRoot: string;
  pattern: string;
  lang?: string;
}): SidecarResult {
  const bin = resolveBundledAstGrepBinary();
  if (!bin) {
    return {
      ok: false,
      engine: 'ast-grep',
      summaryKo:
        'ast-grep(sg)가 없습니다. install/START가 runtime/oss-sidecars/bin에 설치합니다.',
      artifacts: [],
      mutations: [],
      evidence: [],
      error: 'AST_GREP_NOT_FOUND',
    };
  }
  const args = ['run', '--pattern', opts.pattern];
  if (opts.lang) args.push('--lang', opts.lang);
  const r = spawnSync(bin, args, {
    cwd: opts.workspaceRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const out = String(r.stdout || '');
  return {
    ok: r.status === 0,
    engine: 'ast-grep',
    summaryKo:
      r.status === 0
        ? `ast-grep 매치 출력 ${out.length} chars.`
        : `ast-grep 실패: ${String(r.stderr || '').slice(0, 300)}`,
    artifacts: [],
    mutations: [],
    evidence: [{ kind: 'stdout', detail: out.slice(0, 12_000) }],
    error: r.status === 0 ? undefined : 'AST_GREP_EXIT',
    rawLog: out.slice(0, 50_000),
  };
}
