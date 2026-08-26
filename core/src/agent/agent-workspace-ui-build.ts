/**
 * ui/workspace src mutate → dist build Exit Gate helpers.
 * Shell serves ui/workspace/dist, not Vite src.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { formatExitGateToolNudge, type VerifyWitness } from './agent-claim-gates.js';
import { normalizeAgentPath } from './agent-grounding.js';

const WORKSPACE_UI_SRC_RE = /(?:^|\/)ui\/workspace\/src\//i;
const WORKSPACE_BUILD_CMD_RE = /workspace:build|ui\/workspace.*\bbuild\b|npm\s+(?:--prefix\s+ui\/workspace\s+)?run\s+build/i;

export function normalizeWorkspaceRel(p: string): string {
  return normalizeAgentPath(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

export function isWorkspaceUiSourcePath(p: string): boolean {
  return WORKSPACE_UI_SRC_RE.test(normalizeWorkspaceRel(p));
}

export function sessionMutatesWorkspaceUiSource(paths: string[]): string[] {
  return [...new Set(paths.map(normalizeWorkspaceRel).filter(isWorkspaceUiSourcePath))];
}

export function commandLooksLikeWorkspaceUiBuild(command: string | null | undefined): boolean {
  return WORKSPACE_BUILD_CMD_RE.test(String(command || ''));
}

export function hasWorkspaceUiBuildWitness(witness: VerifyWitness | null | undefined): boolean {
  if (!witness?.ok) return false;
  if (witness.exitCode != null && witness.exitCode !== 0) return false;
  return commandLooksLikeWorkspaceUiBuild(witness.command);
}

function newestMtimeInTree(rootDir: string, depth = 0): number | null {
  if (!existsSync(rootDir) || depth > 6) return null;
  let newest: number | null = null;
  let entries: string[] = [];
  try {
    entries = readdirSync(rootDir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (name === '.' || name === '..' || name === 'node_modules') continue;
    const full = path.join(rootDir, name);
    try {
      const st = statSync(full);
      if (st.isDirectory()) {
        const child = newestMtimeInTree(full, depth + 1);
        if (child != null && (newest == null || child > newest)) newest = child;
      } else if (st.isFile()) {
        const ms = st.mtimeMs;
        if (newest == null || ms > newest) newest = ms;
      }
    } catch {
      /* skip */
    }
  }
  return newest;
}

function sourceMtimes(workspaceRoot: string, sourcePaths: string[]): number[] {
  const out: number[] = [];
  for (const rel of sourcePaths) {
    const abs = path.isAbsolute(rel) ? rel : path.join(workspaceRoot, rel);
    try {
      if (existsSync(abs)) out.push(statSync(abs).mtimeMs);
    } catch {
      /* skip */
    }
  }
  return out;
}

export type WorkspaceUiBuildProbe = {
  ok: boolean;
  reason: 'no_ui_src' | 'fresh' | 'missing_dist' | 'stale_dist' | 'build_witness';
  sourcePaths: string[];
  distNewestMs: number | null;
  sourceNewestMs: number | null;
};

export function probeWorkspaceUiBuildFreshness(
  workspaceRoot: string,
  paths: string[],
  verifyWitness?: VerifyWitness | null,
): WorkspaceUiBuildProbe {
  const sourcePaths = sessionMutatesWorkspaceUiSource(paths);
  if (!sourcePaths.length) {
    return {
      ok: true,
      reason: 'no_ui_src',
      sourcePaths,
      distNewestMs: null,
      sourceNewestMs: null,
    };
  }
  if (hasWorkspaceUiBuildWitness(verifyWitness)) {
    return {
      ok: true,
      reason: 'build_witness',
      sourcePaths,
      distNewestMs: null,
      sourceNewestMs: null,
    };
  }
  const distDir = path.join(workspaceRoot, 'ui', 'workspace', 'dist');
  const distNewestMs = newestMtimeInTree(distDir);
  const srcTimes = sourceMtimes(workspaceRoot, sourcePaths);
  const sourceNewestMs = srcTimes.length ? Math.max(...srcTimes) : null;
  if (distNewestMs == null) {
    return { ok: false, reason: 'missing_dist', sourcePaths, distNewestMs, sourceNewestMs };
  }
  if (sourceNewestMs != null && distNewestMs + 500 < sourceNewestMs) {
    return { ok: false, reason: 'stale_dist', sourcePaths, distNewestMs, sourceNewestMs };
  }
  return { ok: true, reason: 'fresh', sourcePaths, distNewestMs, sourceNewestMs };
}

export function formatWorkspaceUiBuildNudge(probe: WorkspaceUiBuildProbe): string {
  return formatExitGateToolNudge({
    gate: 'npm run workspace:build after ui/workspace/src mutate',
    toolName: 'run_terminal',
    args: { command: 'npm run workspace:build', confirm: true },
    detail: [
      'FALSE: shell serves ui/workspace/dist — src-only mutate leaves Preview buttons missing.',
      `Sources: ${probe.sourcePaths.slice(0, 6).join(', ')}`,
      `Probe: ${probe.reason}`,
      'Or report 미검증 / PARTIAL without 완료. First line = TOOL_CALL.',
    ].join('\n'),
  });
}

export function formatWorkspaceUiBuildRewrite(assistantText: string): string {
  const head = String(assistantText || '')
    .replace(/###\s*변경\s*증거[\s\S]*$/i, '')
    .trim()
    .slice(0, 1200);
  return [
    head,
    '',
    '---',
    '상태: PARTIAL / 미검증 — Preview 반영을 완료로 보려면 `npm run workspace:build`(dist)가 필요합니다.',
    '셸은 dist를 로드합니다. (다음 기능 턴을 막지는 않습니다 — Cursor형)',
  ].join('\n');
}

export const WORKSPACE_UI_BUILD_OPEN_GATE = {
  gate: 'npm run workspace:build after ui/workspace/src mutate (shell serves dist)',
  evidence: {
    kind: 'command_exit0' as const,
    command: 'npm run workspace:build',
    path: 'ui/workspace/dist',
  },
};
