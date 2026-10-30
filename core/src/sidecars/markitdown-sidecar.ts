/**
 * markitdown sidecar (MS) — multi-format → markdown (ADR-009 Wave 3 / OSS-B04).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { SidecarResult } from './types.js';
import { resolveBundledMarkitdownBinary } from './oss-paths.js';

/** Explicit character pages, including very long lines. Re-conversion must match this hash. */
export function paginateMarkitdownText(text: string, startChar = 0, maxChars = 12_000) {
  const start = Number.isFinite(startChar) ? Math.max(0, Math.floor(startChar)) : 0;
  const count = Number.isFinite(maxChars) ? Math.max(1, Math.min(80_000, Math.floor(maxChars))) : 12_000;
  const end = Math.min(text.length, start + count);
  return {
    text: text.slice(start, end),
    coverage: { total_chars: text.length, start_char: Math.min(start, text.length), end_char: end,
      truncated: start > 0 || end < text.length,
      next_start_char: end < text.length ? end : null,
      sha256: createHash('sha256').update(text).digest('hex'),
      guidance: '미조회 부분은 markitdown_convert에 같은 path와 next_start_char를 start_char로 전달해 가져오세요. 재변환의 sha256이 바뀌면 결과를 혼합하지 마세요.',
    },
  };
}

export function runMarkitdownSidecar(opts: {
  filePath: string;
  timeoutMs?: number;
  cqrRoot?: string;
  startChar?: number;
  maxChars?: number;
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
  const page = paginateMarkitdownText(out, opts.startChar, opts.maxChars);
  const complete = r.status === 0 && !r.error;
  return {
    ok: complete && out.length > 0,
    engine: 'markitdown',
    summaryKo:
      r.status === 0
        ? `markitdown → markdown ${out.length} chars (${path.basename(file)}).`
        : `markitdown 실패: ${err.slice(0, 300) || `exit ${r.status}`}`,
    artifacts: [],
    mutations: [],
    evidence: [{ kind: 'stdout', detail: page.text }],
    error: complete && out.length > 0 ? undefined : 'MARKITDOWN_EXIT',
    rawLog: page.text,
    coverage: { ...page.coverage, source_complete: complete,
      ...(!complete ? { warning: '변환이 정상 완료되지 않았습니다. 출력 일부가 유실됐을 수 있으므로 전체 문서를 읽었다고 판단하지 마세요.' } : {}) },
  };
}
