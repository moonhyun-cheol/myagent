import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  getMarketPipelineCapability,
  type MarketPipelineCapability,
} from './market-pipeline-capability.js';

export type MarketResearchPhase = 'research' | 'feasibility' | 'plan';

/**
 * Failure kinds surfaced to the user. The organization-module entry
 * (`pipelines/market_research.py`) emits `missing_deps` / `missing_api_key` /
 * `pipeline_failed` / `no_session` / `error` as the last stdout JSON line; the
 * host adds `no_python` / `no_org_module` / `no_script` / `empty_brief`.
 */
export type MarketPipelineFailureStatus =
  | 'missing_deps'
  | 'missing_api_key'
  | 'pipeline_failed'
  | 'no_session'
  | 'no_python'
  | 'no_org_module'
  | 'no_script'
  | 'empty_brief'
  | 'error';

export interface MarketPipelineRunResult {
  ok: boolean;
  phase: MarketResearchPhase;
  capability: MarketPipelineCapability;
  markdown?: string;
  session_id?: string;
  output_dir?: string;
  /** 'ok' on success, otherwise the failure kind. */
  status?: MarketPipelineFailureStatus | 'ok';
  /** User-facing message (shown directly unless used_fallback_chat). */
  error?: string;
  /** True only when the pipeline genuinely cannot run (org module absent). */
  used_fallback_chat?: boolean;
}

export interface MarketProcOutput {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface MarketReportFile {
  markdown: string;
  mtimeMs: number;
}

/** Slack for mtime vs. run-start comparison (filesystem mtime resolution). */
const FRESH_SLACK_MS = 2_000;

/**
 * Mutable state (session pointer, LangGraph checkpoints, default output) lives
 * OUTSIDE the organization module so a module update never wipes reports.
 * Mirrors `market_research.py::_state_dir`.
 */
export function resolveMarketStateDir(): string {
  const env = process.env.CQR_MARKET_STATE_DIR?.trim();
  if (env) return path.resolve(env);
  const local = process.env.LOCALAPPDATA?.trim();
  if (local) return path.join(local, 'MYAgent', 'organization', 'market_research');
  return path.join(os.homedir(), '.myagent', 'organization', 'market_research');
}

export function marketOutputRoot(): string {
  return path.join(resolveMarketStateDir(), 'output');
}

function reportFileName(phase: MarketResearchPhase): string {
  return phase === 'plan'
    ? 'final_product_plan.md'
    : phase === 'feasibility'
      ? 'feasibility_review.md'
      : 'research_report.md';
}

/** Read the phase report produced in THIS run's output dir only. */
export function readReportFile(outputDir: string, phase: MarketResearchPhase): MarketReportFile | null {
  const p = path.join(outputDir, reportFileName(phase));
  if (!existsSync(p)) return null;
  try {
    const markdown = readFileSync(p, 'utf8');
    if (!markdown.trim()) return null;
    return { markdown, mtimeMs: statSync(p).mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Extract the pipeline contract JSON from stdout. The entry prints a pretty
 * (indent=2) JSON object — top-level braces sit alone at column 0, nested
 * objects are indented — possibly after pipeline logs and before an `MD=` line.
 * Returns the last `pipeline:"market_research"` object, else the last object.
 */
export function parsePipelineResultJson(stdout: string): Record<string, unknown> | null {
  const lines = String(stdout ?? '').replace(/\r\n/g, '\n').split('\n');
  const objects: Record<string, unknown>[] = [];
  let open = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '{') {
      open = i;
    } else if (lines[i] === '}' && open >= 0) {
      const candidate = lines.slice(open, i + 1).join('\n');
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          objects.push(parsed as Record<string, unknown>);
        }
      } catch {
        /* not a complete object — ignore */
      }
      open = -1;
    }
  }
  if (!objects.length) return null;
  for (let i = objects.length - 1; i >= 0; i--) {
    if (objects[i].pipeline === 'market_research') return objects[i];
  }
  return objects[objects.length - 1];
}

function normalizeFailureStatus(raw: unknown): MarketPipelineFailureStatus {
  const s = typeof raw === 'string' ? raw : '';
  switch (s) {
    case 'missing_deps':
    case 'missing_api_key':
    case 'pipeline_failed':
    case 'no_session':
    case 'no_python':
      return s;
    default:
      return 'error';
  }
}

function asList(v: unknown): string {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string').join(', ');
  return typeof v === 'string' ? v : '';
}

/** Build the Korean user-facing message for a failure status. */
export function marketFailureMessage(
  status: MarketPipelineFailureStatus,
  parsed: Record<string, unknown> | null | undefined,
  outputDir: string | null,
): string {
  const missing = asList(parsed?.missing);
  const pErr = typeof parsed?.error === 'string' ? parsed.error : '';
  const pHint = typeof parsed?.hint === 'string' ? parsed.hint : '';
  const provider = typeof parsed?.provider === 'string' ? parsed.provider : '';
  const join = (lines: Array<string | null | undefined>) => lines.filter(Boolean).join('\n');

  switch (status) {
    case 'missing_deps':
      return join([
        '시장조사 실행 환경에 필요한 Python 패키지가 없습니다.',
        missing ? `누락 패키지: ${missing}` : null,
        "해결: Work Kit 관리자에서 'CQR 상품개발' 키트를 적용(또는 다시 적용)하거나, CQR_PIPELINE_PYTHON 을 전용 venv 의 python 으로 지정하세요.",
        pHint || null,
      ]);
    case 'no_python':
      return join([
        '시장조사 Python 실행 환경(runtime/pipeline-venv)을 찾지 못했습니다.',
        "해결: Work Kit 관리자에서 'CQR 상품개발' 키트를 적용하거나 <설치 루트>\\runtime\\pipeline-venv 를 설치하세요. (또는 CQR_PIPELINE_PYTHON 환경변수 지정)",
      ]);
    case 'missing_api_key':
      return join([
        'LLM API 키가 없어 시장조사를 실행할 수 없습니다.',
        missing ? `필요한 키: ${missing}` : null,
        provider ? `LLM_PROVIDER=${provider}` : null,
        '설정 위치: 호스트 앱의 LLM 연결(API 키) 설정에서 해당 키를 추가하세요.',
      ]);
    case 'no_session':
      return pErr || '활성 시장조사 세션이 없습니다. 먼저 /타당성 을 실행한 뒤 /기획서(승인) 으로 이어가세요.';
    case 'pipeline_failed':
      return join([
        '시장조사 파이프라인이 리포트를 생성하지 못했습니다.',
        pErr ? `오류: ${pErr}` : null,
        outputDir ? `출력 폴더: ${outputDir}` : null,
      ]);
    case 'error':
    default:
      return join([
        '시장조사 파이프라인 실행 중 오류가 발생했습니다.',
        pErr ? `오류: ${pErr}` : null,
        outputDir ? `출력 폴더: ${outputDir}` : null,
      ]);
  }
}

/**
 * Pure interpreter: given the process output and the report file read from the
 * CURRENT run's output dir, decide ok / failure. No filesystem scanning of old
 * sessions — a success requires a report created during this run.
 */
export function interpretMarketPipelineResult(args: {
  phase: MarketResearchPhase;
  capability: MarketPipelineCapability;
  outputDir: string;
  proc: MarketProcOutput;
  report: MarketReportFile | null;
  startedAtMs: number;
}): MarketPipelineRunResult {
  const { phase, capability, outputDir, proc, report, startedAtMs } = args;
  const parsed = parsePipelineResultJson(proc.stdout);
  const freshReport = report && report.mtimeMs >= startedAtMs - FRESH_SLACK_MS ? report : null;

  // (1) Entry reported success — trust it only if a report exists from THIS run.
  if (parsed && parsed.ok === true) {
    if (freshReport) {
      const sid = typeof parsed.session_id === 'string' ? parsed.session_id : path.basename(outputDir);
      return {
        ok: true,
        phase,
        capability,
        markdown: freshReport.markdown,
        session_id: sid,
        output_dir: outputDir,
        status: 'ok',
      };
    }
    return {
      ok: false,
      phase,
      capability,
      output_dir: outputDir,
      status: 'pipeline_failed',
      error: marketFailureMessage(
        'pipeline_failed',
        { error: `리포트(${reportFileName(phase)})가 이번 실행에서 생성되지 않았습니다.` },
        outputDir,
      ),
      used_fallback_chat: false,
    };
  }

  // (2) Entry reported a structured failure — show it, do NOT fall back to chat.
  if (parsed && parsed.ok === false) {
    const status = normalizeFailureStatus(parsed.status);
    return {
      ok: false,
      phase,
      capability,
      output_dir: outputDir,
      status,
      error: marketFailureMessage(status, parsed, outputDir),
      used_fallback_chat: false,
    };
  }

  // (3) No contract JSON. ps1 legacy path may still have written a report.
  if (freshReport) {
    return {
      ok: true,
      phase,
      capability,
      markdown: freshReport.markdown,
      session_id: path.basename(outputDir),
      output_dir: outputDir,
      status: 'ok',
    };
  }

  // (4) No JSON and no fresh report → opaque error from exit code + stderr tail.
  const tail = (proc.stderr || proc.stdout || '').trim().slice(-800);
  return {
    ok: false,
    phase,
    capability,
    output_dir: outputDir,
    status: 'error',
    error: marketFailureMessage(
      'error',
      { error: tail || `종료 코드 ${proc.status ?? 'null'} — 결과(JSON)를 읽지 못했습니다.` },
      outputDir,
    ),
    used_fallback_chat: false,
  };
}

interface SpawnContext {
  capability: MarketPipelineCapability;
  phase: MarketResearchPhase;
  brief: string;
  outputDir: string;
  stateDir: string;
}

function runViaPipelineEntry(ctx: SpawnContext): MarketProcOutput {
  const { capability, phase, brief, outputDir, stateDir } = ctx;
  const r = spawnSync(capability.python!, [capability.pipeline_entry!, phase, brief, '--output-dir', outputDir], {
    cwd: capability.org_root!,
    encoding: 'utf8',
    timeout: 600_000,
    env: {
      ...process.env,
      CQR_MANAGER_ROOT: capability.org_root!,
      CQR_MARKET_STATE_DIR: stateDir,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
    },
    windowsHide: true,
  });
  return { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
}

function runViaPs1(ctx: SpawnContext): MarketProcOutput {
  const { capability, phase, brief, stateDir } = ctx;
  const script = capability.script!;
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
        CQR_MANAGER_ROOT: capability.org_root!,
        CQR_MARKET_STATE_DIR: stateDir,
        CQR_PIPELINE_PYTHON: capability.python!,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
      windowsHide: true,
    },
  );
  return { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
}

function defaultSpawn(ctx: SpawnContext): MarketProcOutput {
  mkdirSync(ctx.outputDir, { recursive: true });
  if (ctx.capability.pipeline_entry) return runViaPipelineEntry(ctx);
  return runViaPs1(ctx);
}

export function runMarketPipeline(opts: {
  cqrRoot: string;
  phase: MarketResearchPhase;
  brief: string;
  sessionId?: string;
  /** Test seams. */
  capabilityOverride?: MarketPipelineCapability;
  spawnOverride?: (ctx: SpawnContext) => MarketProcOutput;
  readReportOverride?: (outputDir: string, phase: MarketResearchPhase) => MarketReportFile | null;
  nowOverride?: number;
}): MarketPipelineRunResult {
  const phase = opts.phase;
  const brief = opts.brief.trim();
  const capability = opts.capabilityOverride ?? getMarketPipelineCapability(opts.cqrRoot);

  // Genuinely cannot run → fall through to org skill LLM chat (CQR_MARKET_INJECT),
  // carrying a one-line reason so the user knows why the pipeline didn't run.
  if (!capability.org_root) {
    return {
      ok: false,
      phase,
      capability,
      status: 'no_org_module',
      error: capability.message_ko || '조직 모듈이 설치되지 않아 시장조사 파이프라인을 실행할 수 없습니다.',
      used_fallback_chat: true,
    };
  }
  if (!capability.pipeline_entry && !capability.script) {
    return {
      ok: false,
      phase,
      capability,
      status: 'no_script',
      error: capability.message_ko || '시장조사 파이프라인 스크립트가 조직 모듈에 없습니다.',
      used_fallback_chat: true,
    };
  }

  if (!brief && phase !== 'plan') {
    return {
      ok: false,
      phase,
      capability,
      status: 'empty_brief',
      error: '브리프가 비어 있습니다. 예: /심층리서치 2027 FW 겨울 슬랙스 Amazon US pain point',
      used_fallback_chat: false,
    };
  }

  // No python anywhere → visible guidance (not a silent chat fallback).
  if (!capability.python) {
    return {
      ok: false,
      phase,
      capability,
      status: 'no_python',
      error: marketFailureMessage('no_python', null, null),
      used_fallback_chat: false,
    };
  }

  const stateDir = resolveMarketStateDir();
  const outputRoot = path.join(stateDir, 'output');
  const sessionKey = (opts.sessionId || 'session').replace(/[^\w.-]+/g, '_').slice(0, 48);
  const outputDir = path.join(outputRoot, `${sessionKey}-${Date.now().toString(36).slice(-6)}`);
  const startedAtMs = opts.nowOverride ?? Date.now();

  const spawnImpl = opts.spawnOverride ?? defaultSpawn;
  const proc = spawnImpl({ capability, phase, brief: brief || '(approve)', outputDir, stateDir });

  const readReport = opts.readReportOverride ?? readReportFile;
  const report = readReport(outputDir, phase);

  return interpretMarketPipelineResult({ phase, capability, outputDir, proc, report, startedAtMs });
}
