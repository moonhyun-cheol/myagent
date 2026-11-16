import { existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  getMarketPipelineCapability,
  type MarketPipelineCapability,
} from './market-pipeline-capability.js';

export type MarketResearchPhase = 'research' | 'feasibility' | 'plan';

/**
 * Failure kinds surfaced to the user. The organization-module entry
 * (`pipelines/market_research.py`) emits `missing_deps` / `missing_api_key` / `pipeline_failed` /
 * `no_session` / `needs_brief` / `insufficient_evidence` / `unavailable` / `error` as its stdout
 * JSON; the host adds `no_python` / `no_org_module` / `no_script` / `empty_brief`.
 * For `needs_brief` / `insufficient_evidence` / `unavailable` the entry's `error` is the guidance.
 */
export type MarketPipelineFailureStatus =
  | 'missing_deps'
  | 'missing_api_key'
  | 'pipeline_failed'
  | 'no_session'
  | 'needs_brief'
  | 'insufficient_evidence'
  | 'unavailable'
  | 'no_python'
  | 'no_org_module'
  | 'no_script'
  | 'empty_brief'
  | 'error';

/**
 * Brief fields the entry accepts as `--product=…` flags (mirrors `FIELD_FLAGS` in the entry).
 * `study` (`trend` | `product`) and `period` (`2024-2026`) select a market/trend study; modules
 * older than that reject the two flags, and the run is retried without them.
 */
export const MARKET_BRIEF_FIELDS = [
  'product',
  'product_en',
  'category',
  'season',
  'channel',
  'price_band',
  'competitors',
  'focus',
  'study',
  'period',
] as const;
const TREND_FIELDS: readonly MarketBriefField[] = ['study', 'period'];
export type MarketBriefField = (typeof MARKET_BRIEF_FIELDS)[number];
export type MarketBriefFields = Partial<Record<MarketBriefField, string>>;

/** One evidence item of `evidence_pack.json` (schema `cqr.market_research.evidence_pack/1`). */
export interface MarketEvidenceItem {
  id: string;
  kind: string;
  title: string;
  url: string;
  domain: string;
  source: string;
  excerpt: string;
  detail?: string;
  prices?: string[];
  page_prices?: string[];
  query?: string;
  /** Date the page declares, or the date in front of the search snippet (YYYY-MM-DD). */
  published?: string;
}

export interface MarketEvidencePack {
  schema?: string;
  market?: string;
  session_id?: string;
  brief?: Record<string, unknown>;
  stats?: Record<string, unknown>;
  evidence: MarketEvidenceItem[];
}

export interface MarketPipelineRunResult {
  ok: boolean;
  phase: MarketResearchPhase;
  capability: MarketPipelineCapability;
  markdown?: string;
  session_id?: string;
  output_dir?: string;
  /** `evidence_pack` for /심층리서치 (no synthesis inside the pipeline). */
  report_kind?: string;
  /** Parsed `evidence_pack.json` of this run, when the entry wrote one. */
  evidence_pack?: MarketEvidencePack;
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

/** `evidence_pack.json` written by this run's research phase, or null. */
export function readEvidencePack(outputDir: string): MarketEvidencePack | null {
  const p = path.join(outputDir, 'evidence_pack.json');
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as MarketEvidencePack;
    return parsed && Array.isArray(parsed.evidence) ? parsed : null;
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
    case 'needs_brief':
    case 'insufficient_evidence':
    case 'unavailable':
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
    case 'needs_brief':
      return pErr || '조사할 품목이나 카테고리를 찾지 못해 검색하지 않았습니다. 예: /심층리서치 품목: 스키바지 / 영문명: ski pants / 시즌: 2027 FW';
    case 'insufficient_evidence':
      return pErr || '브리프 주제에 맞는 미국 시장 근거가 부족해 리포트를 만들지 않았습니다.';
    case 'unavailable':
      return pErr || '이 단계는 지금 사용할 수 없습니다. /심층리서치 까지만 제공합니다.';
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
        report_kind: typeof parsed.report_kind === 'string' ? parsed.report_kind : undefined,
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
  fields: MarketBriefFields;
  outputDir: string;
  stateDir: string;
}

const PIPELINE_TIMEOUT_MS = 600_000;

/**
 * Run a child process without blocking the event loop (the research phase takes 30–80 s;
 * `spawnSync` froze every other request and the SSE status line for that long).
 */
function spawnCollect(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<MarketProcOutput> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, windowsHide: true });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-200_000);
    });
    const finish = (status: number | null, note = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr: note ? `${stderr}\n${note}` : stderr });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null, `시간 초과(${Math.round((opts.timeoutMs ?? PIPELINE_TIMEOUT_MS) / 1000)}초)로 중단했습니다.`);
    }, opts.timeoutMs ?? PIPELINE_TIMEOUT_MS);
    child.on('error', (e) => finish(null, e.message));
    child.on('close', (code) => finish(code));
  });
}

/** `--product=값` flags; `=` keeps values that start with `-` or `$` intact. */
export function marketFieldArgs(fields: MarketBriefFields): string[] {
  const out: string[] = [];
  for (const name of MARKET_BRIEF_FIELDS) {
    const value = fields[name]?.replace(/\s+/g, ' ').trim();
    if (value) out.push(`--${name.replace(/_/g, '-')}=${value}`);
  }
  return out;
}

/** argparse of an entry without `--study` / `--period` exits 2 with "unrecognized arguments" and no JSON. */
export function rejectedTrendFlags(proc: MarketProcOutput, fields: MarketBriefFields): boolean {
  if (!TREND_FIELDS.some((name) => fields[name]?.trim())) return false;
  if (parsePipelineResultJson(proc.stdout)) return false;
  return /unrecognized arguments:.*--(?:study|period)\b/.test(proc.stderr ?? '');
}

function runViaPipelineEntry(ctx: SpawnContext): Promise<MarketProcOutput> {
  const { capability, phase, brief, fields, outputDir, stateDir } = ctx;
  // The entry creates the output folder itself, and only after its brief gate passed.
  // argparse reads a value starting with "-" as an option; a leading space keeps it positional
  // (the entry strips it). A "--" separator is rejected by the entry's parser.
  const positional = brief.startsWith('-') ? ` ${brief}` : brief;
  const args = [capability.pipeline_entry!, phase, positional, '--output-dir', outputDir];
  if (phase === 'research') args.push(...marketFieldArgs(fields));
  return spawnCollect(capability.python!, args, {
    cwd: capability.org_root!,
    env: {
      ...process.env,
      CQR_MANAGER_ROOT: capability.org_root!,
      CQR_MARKET_STATE_DIR: stateDir,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
    },
  });
}

function runViaPs1(ctx: SpawnContext): Promise<MarketProcOutput> {
  const { capability, phase, brief, stateDir } = ctx;
  const script = capability.script!;
  const cmd =
    phase === 'research'
      ? ['심층리서치', brief]
      : phase === 'feasibility'
        ? ['pipeline', 'start', brief]
        : ['pipeline', 'approve', brief];
  return spawnCollect('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...cmd], {
    cwd: path.dirname(path.dirname(script)),
    env: {
      ...process.env,
      CQR_MANAGER_ROOT: capability.org_root!,
      CQR_MARKET_STATE_DIR: stateDir,
      CQR_PIPELINE_PYTHON: capability.python!,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
    },
  });
}

function defaultSpawn(ctx: SpawnContext): Promise<MarketProcOutput> {
  if (ctx.capability.pipeline_entry) return runViaPipelineEntry(ctx);
  return runViaPs1(ctx);
}

export async function runMarketPipeline(opts: {
  cqrRoot: string;
  phase: MarketResearchPhase;
  brief: string;
  /** Structured brief fields (research only); passed as flags, they win over the sentence. */
  fields?: MarketBriefFields;
  sessionId?: string;
  /** Test seams. */
  capabilityOverride?: MarketPipelineCapability;
  spawnOverride?: (ctx: SpawnContext) => MarketProcOutput | Promise<MarketProcOutput>;
  readReportOverride?: (outputDir: string, phase: MarketResearchPhase) => MarketReportFile | null;
  readPackOverride?: (outputDir: string) => MarketEvidencePack | null;
  nowOverride?: number;
}): Promise<MarketPipelineRunResult> {
  const phase = opts.phase;
  const brief = opts.brief.trim();
  const fields = opts.fields ?? {};
  const hasFields = MARKET_BRIEF_FIELDS.some((name) => fields[name]?.trim());
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

  if (!brief && !(phase === 'research' && hasFields) && phase !== 'plan') {
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
  const spawnCtx: SpawnContext = {
    capability,
    phase,
    brief: brief || (phase === 'plan' ? '(approve)' : ''),
    fields,
    outputDir,
    stateDir,
  };
  let proc = await spawnImpl(spawnCtx);
  if (phase === 'research' && rejectedTrendFlags(proc, fields)) {
    // An organization module older than the market/trend study: run its product study instead.
    const older: MarketBriefFields = { ...fields };
    for (const name of TREND_FIELDS) delete older[name];
    proc = await spawnImpl({ ...spawnCtx, fields: older });
  }

  const readReport = opts.readReportOverride ?? readReportFile;
  const report = readReport(outputDir, phase);

  const result = interpretMarketPipelineResult({ phase, capability, outputDir, proc, report, startedAtMs });
  if (result.ok && phase === 'research') {
    const pack = (opts.readPackOverride ?? readEvidencePack)(outputDir);
    if (pack) result.evidence_pack = pack;
  }
  return result;
}
