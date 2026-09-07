import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  getMarketPipelineCapability,
  type MarketPipelineCapability,
} from './market-pipeline-capability.js';

export type MarketResearchPhase = 'research' | 'feasibility' | 'plan';

export interface MarketPipelineRunResult {
  ok: boolean;
  phase: MarketResearchPhase;
  capability: MarketPipelineCapability;
  markdown?: string;
  session_id?: string;
  output_dir?: string;
  error?: string;
  used_fallback_chat?: boolean;
}

function newestSessionDir(outputRoot: string): string | null {
  if (!existsSync(outputRoot)) return null;
  let best: { full: string; score: number } | null = null;
  for (const ent of readdirSync(outputRoot, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const full = path.join(outputRoot, ent.name);
    const files = [
      path.join(full, 'final_product_plan.md'),
      path.join(full, 'feasibility_review.md'),
      path.join(full, 'research_report.md'),
    ];
    let mtime = 0;
    let has = 0;
    for (const f of files) {
      if (!existsSync(f)) continue;
      has += 1;
      try {
        mtime = Math.max(mtime, statSync(f).mtimeMs);
      } catch {
        /* ignore */
      }
    }
    if (!has) continue;
    const score = has * 1e15 + mtime;
    if (!best || score > best.score) best = { full, score };
  }
  return best?.full ?? null;
}

function readPhaseMarkdown(outputDir: string, phase: MarketResearchPhase): string | null {
  const file =
    phase === 'plan'
      ? 'final_product_plan.md'
      : phase === 'feasibility'
        ? 'feasibility_review.md'
        : 'research_report.md';
  const p = path.join(outputDir, file);
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function runViaPipelineEntry(
  python: string,
  entry: string,
  phase: MarketResearchPhase,
  brief: string,
  outputDir: string,
  orgRoot: string,
): { status: number | null; stdout: string; stderr: string } {
  mkdirSync(outputDir, { recursive: true });
  const r = spawnSync(python, [entry, phase, brief, '--output-dir', outputDir], {
    cwd: orgRoot,
    encoding: 'utf8',
    timeout: 600_000,
    env: {
      ...process.env,
      CQR_MANAGER_ROOT: orgRoot,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
    },
    windowsHide: true,
  });
  return {
    status: r.status,
    stdout: String(r.stdout ?? ''),
    stderr: String(r.stderr ?? ''),
  };
}

function runViaPs1(
  script: string,
  phase: MarketResearchPhase,
  brief: string,
  python: string,
  orgRoot: string,
): { status: number | null; stdout: string; stderr: string } {
  const cmd =
    phase === 'research'
      ? ['심층리서치', brief]
      : phase === 'feasibility'
        ? ['pipeline', 'start', brief]
        : ['pipeline', 'approve', brief];
  const r = spawnSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...cmd],
    {
      cwd: path.dirname(path.dirname(script)),
      encoding: 'utf8',
      timeout: 600_000,
      env: {
        ...process.env,
        CQR_MANAGER_ROOT: orgRoot,
        CQR_PIPELINE_PYTHON: python,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
      windowsHide: true,
    },
  );
  return {
    status: r.status,
    stdout: String(r.stdout ?? ''),
    stderr: String(r.stderr ?? ''),
  };
}

export function runMarketPipeline(opts: {
  cqrRoot: string;
  phase: MarketResearchPhase;
  brief: string;
  sessionId?: string;
}): MarketPipelineRunResult {
  const capability = getMarketPipelineCapability(opts.cqrRoot);
  const phase = opts.phase;
  const brief = opts.brief.trim();

  if (!brief && phase !== 'plan') {
    return {
      ok: false,
      phase,
      capability,
      error: '브리프가 비어 있습니다. 예: /심층리서치 2027 FW 겨울 슬랙스 Amazon US pain…',
      used_fallback_chat: true,
    };
  }

  if (!capability.available || !capability.python || !capability.org_root) {
    return {
      ok: false,
      phase,
      capability,
      error: capability.message_ko,
      used_fallback_chat: true,
    };
  }

  const sessionKey = (opts.sessionId || 'session').replace(/[^\w.-]+/g, '_').slice(0, 48);
  const outputRoot = path.join(capability.org_root, 'market_research', 'output');
  const outputDir = path.join(outputRoot, `${sessionKey}-${Date.now().toString(36).slice(-6)}`);

  let proc: { status: number | null; stdout: string; stderr: string };
  if (capability.pipeline_entry) {
    proc = runViaPipelineEntry(
      capability.python,
      capability.pipeline_entry,
      phase,
      brief || '(approve)',
      outputDir,
      capability.org_root,
    );
  } else if (capability.script) {
    proc = runViaPs1(
      capability.script,
      phase,
      brief || '(approve)',
      capability.python,
      capability.org_root,
    );
  } else {
    return {
      ok: false,
      phase,
      capability,
      error: '실행 가능한 시장조사 엔트리가 없습니다.',
      used_fallback_chat: true,
    };
  }

  let resolvedDir = outputDir;
  let markdown = readPhaseMarkdown(resolvedDir, phase);
  if (!markdown) {
    const newest = newestSessionDir(outputRoot);
    if (newest) {
      resolvedDir = newest;
      markdown = readPhaseMarkdown(resolvedDir, phase);
    }
  }

  if (!markdown) {
    const detail = (proc.stderr || proc.stdout || '').trim().slice(0, 800);
    return {
      ok: false,
      phase,
      capability,
      output_dir: resolvedDir,
      error:
        `파이프라인은 실행됐지만 리포트 파일을 찾지 못했습니다.`
        + (detail ? `\n\n${detail}` : '')
        + '\n\n채팅 근거 조사로 이어서 작성합니다.',
      used_fallback_chat: true,
    };
  }

  void proc.status;

  return {
    ok: true,
    phase,
    capability,
    markdown,
    session_id: path.basename(resolvedDir),
    output_dir: resolvedDir,
  };
}
