import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { readWorkspaceFile } from './dev-workspace-fs.js';

export const EXPLAIN_DOC_PATHS = ['AGENTS.md'] as const;

function resolveRulebookDocAbs(workspaceRoot: string, relUnderDocs: string): string | null {
  const linkPath = path.join(workspaceRoot, '.rulebook-link.yml');
  if (!existsSync(linkPath)) return null;
  const raw = readFileSync(linkPath, 'utf8');
  const dirMatch = raw.match(/^rulebook_dir:\s*(.+)$/m);
  if (!dirMatch) return null;
  let dir = dirMatch[1].trim();
  if (!path.isAbsolute(dir)) dir = path.resolve(workspaceRoot, dir);
  const abs = path.join(dir, 'docs', relUnderDocs);
  return existsSync(abs) ? abs : null;
}

export function tryReadWorkspaceText(
  workspaceRoot: string,
  relPath: string,
  maxChars = 12_000,
): string | null {
  try {
    const raw = readWorkspaceFile(workspaceRoot, relPath);
    return raw.length > maxChars ? `${raw.slice(0, maxChars)}\n\n… (truncated)` : raw;
  } catch {
    return null;
  }
}

/** Preload brief/status so explain/report never depends on flaky OWUI tool wrappers. */
export function loadExplainGrounding(workspaceRoot: string): string {
  const parts: string[] = [];
  for (const rel of EXPLAIN_DOC_PATHS) {
    const body = tryReadWorkspaceText(workspaceRoot, rel);
    if (body) parts.push(`## ${rel}\n\n${body}`);
  }
  for (const rel of ['00_PROJECT_BRIEF.md', '01_CURRENT_STATUS.md'] as const) {
    const abs = resolveRulebookDocAbs(workspaceRoot, rel);
    if (!abs) continue;
    const body = tryReadWorkspaceText(workspaceRoot, abs);
    if (body) parts.push(`## RULEBOOK/docs/${rel}\n\n${body}`);
  }
  return parts.join('\n\n') || '문서 파일을 읽지 못했습니다. 알려진 구조: Core API :10200, 제품 UI ui/workspace.';
}

export function buildFallbackProjectReport(grounding: string): string {
  const brief = grounding.match(/## (?:RULEBOOK\/docs\/)?00_PROJECT_BRIEF\.md\n\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim();
  const status = grounding.match(/## (?:RULEBOOK\/docs\/)?01_CURRENT_STATUS\.md\n\n([\s\S]*?)$/)?.[1]?.trim();
  const lines = [
    '## MY Agent 프로젝트 보고',
    '',
    '모델 응답이 비어 문서 기준으로 요약합니다.',
    '',
  ];
  if (brief) {
    lines.push('### 개요', brief.slice(0, 3500), '');
  } else {
    lines.push(
      '### 개요',
      'MY Agent는 Windows 휴대용 AI 워크벤치입니다. Core API(`127.0.0.1:10200`) + WebView2, 제품 UI `ui/workspace`.',
      '',
    );
  }
  if (status) {
    lines.push('### 현황 발췌', status.slice(0, 2500));
  }
  return lines.join('\n');
}
