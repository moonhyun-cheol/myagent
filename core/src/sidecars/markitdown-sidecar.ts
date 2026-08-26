/**
 * markitdown sidecar (MS) — multi-format → markdown (ADR-009 Wave 3 / OSS-B04).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { SidecarResult } from './types.js';
import { resolveBundledMarkitdownBinary } from './oss-paths.js';

export function runMarkitdownSidecar(opts: {
  filePath: string;
  timeoutMs?: number;
  cqrRoot?: string;
}): SidecarResult {
  const bin = resolveBundledMarkitdownBinary(process.env, opts.cqrRoot);
  if (!bin) {
    return {
      ok: false,
      engine: 'markitdown',
      summaryKo:
        'markitdown이 없습니다. install/START가 runtime/oss-sidecars에 설치하거나 `pip install markitdown` 후 재시도하세요.',
      artifacts: [],
      mutations: [],
      evidence: [],
      error: 'MARKITDOWN_NOT_FOUND',
    };
  }
  const file = path.resolve(opts.filePath);
  if (!existsSync(file)) {
    return {
      ok: false,
      engine: 'markitdown',
      summaryKo: `파일 없음: ${file}`,
      artifacts: [],
      mutations: [],
      evidence: [],
      error: 'FILE_NOT_FOUND',
    };
  }
  const r = spawnSync(bin, [file], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: opts.timeoutMs ?? 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const out = String(r.stdout || '');
  const err = String(r.stderr || '');
  return {
    ok: r.status === 0 && out.length > 0,
    engine: 'markitdown',
    summaryKo:
      r.status === 0
        ? `markitdown → markdown ${out.length} chars (${path.basename(file)}).`
        : `markitdown 실패: ${err.slice(0, 300) || `exit ${r.status}`}`,
    artifacts: [],
    mutations: [],
    evidence: [{ kind: 'stdout', detail: out.slice(0, 12_000) }],
    error: r.status === 0 && out.length > 0 ? undefined : 'MARKITDOWN_EXIT',
    rawLog: out.slice(0, 80_000),
  };
}
