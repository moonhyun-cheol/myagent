import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveOrganizationModuleRoot } from './organization-module-root.js';
import { getOrganizationSkillDef } from './organization-skill-store.js';

export type MarketPipelineStatus =
  | 'ready'
  | 'no_org_module'
  | 'no_script'
  | 'no_python'
  | 'stub_only';

export interface MarketPipelineCapability {
  available: boolean;
  status: MarketPipelineStatus;
  message_ko: string;
  org_root: string | null;
  script: string | null;
  pipeline_entry: string | null;
  pipeline_venv: string | null;
  python: string | null;
}

const MARKET_SLASH: Array<{ prefix: string; phase: 'research' | 'feasibility' | 'plan'; toolId: string }> = [
  { prefix: '/심층리서치', phase: 'research', toolId: 'market_deep_research' },
  { prefix: '/딥리서치', phase: 'research', toolId: 'market_deep_research' },
  { prefix: '/타당성', phase: 'feasibility', toolId: 'market_feasibility' },
  { prefix: '/기획서', phase: 'plan', toolId: 'market_product_plan' },
];

export function listMarketResearchSlashPrefixes(): string[] {
  return MARKET_SLASH.map((item) => item.prefix);
}

export function matchMarketResearchSlash(message: string): {
  toolId: string;
  phase: 'research' | 'feasibility' | 'plan';
  brief: string;
  commandText: string;
} | null {
  const trimmed = message.trim();
  if (!trimmed.startsWith('/')) return null;
  for (const item of MARKET_SLASH) {
    const escaped = item.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${escaped}(?:\\s+|$)`, 'i');
    if (!re.test(trimmed)) continue;
    const brief = trimmed.slice(item.prefix.length).trim();
    return {
      toolId: item.toolId,
      phase: item.phase,
      brief,
      commandText: trimmed,
    };
  }
  return null;
}

export function isMarketResearchToolId(toolId: string | undefined): boolean {
  return (
    toolId === 'market_deep_research'
    || toolId === 'market_feasibility'
    || toolId === 'market_product_plan'
  );
}

function firstExisting(candidates: Array<string | null | undefined>): string | null {
  for (const c of candidates) {
    if (c && existsSync(c)) return path.resolve(c);
  }
  return null;
}

function resolvePythonCandidates(cqrRoot: string, orgRoot: string | null): string[] {
  const out: string[] = [];
  if (process.env.CQR_PIPELINE_PYTHON?.trim()) out.push(process.env.CQR_PIPELINE_PYTHON.trim());
  if (process.env.CQR_PIPELINE_VENV?.trim()) {
    out.push(path.join(process.env.CQR_PIPELINE_VENV.trim(), 'Scripts', 'python.exe'));
    out.push(path.join(process.env.CQR_PIPELINE_VENV.trim(), 'bin', 'python'));
  }
  out.push(path.join(cqrRoot, 'runtime', 'pipeline-venv', 'Scripts', 'python.exe'));
  if (orgRoot) {
    out.push(path.join(orgRoot, 'market_research', 'cqr_product_pipeline', '.venv', 'Scripts', 'python.exe'));
  }
  out.push(path.join('C:', 'Users', 'Temp', 'cqr-pipeline-venv', 'Scripts', 'python.exe'));
  // PATH python (deployed PCs without dedicated venv)
  try {
    const which = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['python'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const lines = String(which.stdout ?? '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    out.push(...lines);
  } catch {
    /* ignore */
  }
  return out;
}

export function getMarketPipelineCapability(cqrRoot: string): MarketPipelineCapability {
  const orgRoot = resolveOrganizationModuleRoot(cqrRoot);
  if (!orgRoot) {
    return {
      available: false,
      status: 'no_org_module',
      message_ko: '조직 모듈이 설치되지 않았습니다. 모듈 업데이트 후 다시 시도하세요.',
      org_root: null,
      script: null,
      pipeline_entry: null,
      pipeline_venv: null,
      python: null,
    };
  }

  const script = firstExisting([
    path.join(orgRoot, 'market_research', 'scripts', 'run.ps1'),
  ]);
  const pipelineEntry = firstExisting([
    path.join(orgRoot, 'pipelines', 'market_research.py'),
  ]);
  const def = getOrganizationSkillDef('market_research', cqrRoot);
  const declaredEntry = def?.pipeline_script
    ? firstExisting([path.join(orgRoot, def.pipeline_script)])
    : null;
  const entry = declaredEntry ?? pipelineEntry;

  const python = firstExisting(resolvePythonCandidates(cqrRoot, orgRoot));
  const pipelineVenv = firstExisting([
    path.join(cqrRoot, 'runtime', 'pipeline-venv', 'Scripts', 'python.exe'),
    orgRoot
      ? path.join(orgRoot, 'market_research', 'cqr_product_pipeline', '.venv', 'Scripts', 'python.exe')
      : null,
  ]);

  if (!script && !entry) {
    return {
      available: false,
      status: 'no_script',
      message_ko: '시장조사 파이프라인 스크립트가 조직 모듈에 없습니다.',
      org_root: orgRoot,
      script: null,
      pipeline_entry: null,
      pipeline_venv: pipelineVenv,
      python,
    };
  }

  if (!python) {
    return {
      available: false,
      status: 'no_python',
      message_ko:
        '시장조사 Python이 없습니다. 운영 허브/본인 PC에 runtime/pipeline-venv를 설치하거나 CQR_PIPELINE_PYTHON을 설정하세요. 지금은 채팅 근거 조사로 진행합니다.',
      org_root: orgRoot,
      script,
      pipeline_entry: entry,
      pipeline_venv: null,
      python: null,
    };
  }

  return {
    available: true,
    status: 'ready',
    message_ko: '시장조사 파이프라인을 실행할 수 있습니다.',
    org_root: orgRoot,
    script,
    pipeline_entry: entry,
    pipeline_venv: pipelineVenv,
    python,
  };
}
