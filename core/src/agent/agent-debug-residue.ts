/**
 * Debug mode residue report (fact only, never a gate — ADR-RE-006).
 *
 * At run end the host counts `@myagent-debug` markers left in files the agent mutated
 * during this session and reports them as an application notice. It does not block
 * completion and does not inspect the model's wording.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ApplicationNotice } from '../sessions/types.js';
import { DEBUG_LOG_DIR } from '../sessions/workspace-scratch-gitignore.js';

export const DEBUG_MARKER = '@myagent-debug';
const DEBUG_MARKER_END = `${DEBUG_MARKER}:end`;
const MAX_SCAN_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_FILES = 500;
const MAX_LISTED_FILES = 5;

export interface DebugResidueFile {
  path: string;
  /** Instrumentation sites: single marked lines + `:start` blocks (`:end` lines not counted). */
  sites: number;
}

export interface DebugResidue {
  sites: number;
  files: DebugResidueFile[];
  /** Workspace-relative trace files still present under `.myagent-debug/`. */
  traceFiles: string[];
}

function toRel(workspaceRoot: string, abs: string): string {
  return path.relative(workspaceRoot, abs).replace(/\\/g, '/');
}

/** Count marker sites in one text body. */
export function countDebugMarkerSites(text: string): number {
  if (!text.includes(DEBUG_MARKER)) return 0;
  let sites = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes(DEBUG_MARKER)) continue;
    if (line.includes(DEBUG_MARKER_END)) continue;
    sites += 1;
  }
  return sites;
}

export function scanDebugResidue(workspaceRoot: string, candidatePaths: Iterable<string>): DebugResidue {
  const root = path.resolve(workspaceRoot);
  const seen = new Set<string>();
  const files: DebugResidueFile[] = [];
  let sites = 0;
  for (const raw of candidatePaths) {
    if (seen.size >= MAX_SCAN_FILES) break;
    const p = String(raw ?? '').trim();
    if (!p) continue;
    const abs = path.resolve(root, p);
    const key = abs.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const rel = toRel(root, abs);
    // Only workspace files; trace output itself is not instrumentation.
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (rel === DEBUG_LOG_DIR || rel.startsWith(`${DEBUG_LOG_DIR}/`)) continue;
    try {
      const st = statSync(abs);
      if (!st.isFile() || st.size > MAX_SCAN_BYTES) continue;
      const n = countDebugMarkerSites(readFileSync(abs, 'utf8'));
      if (n > 0) {
        files.push({ path: rel, sites: n });
        sites += n;
      }
    } catch {
      /* deleted or unreadable — nothing left there */
    }
  }
  const traceFiles: string[] = [];
  const traceDir = path.join(root, DEBUG_LOG_DIR);
  try {
    if (existsSync(traceDir)) {
      for (const name of readdirSync(traceDir)) {
        const abs = path.join(traceDir, name);
        try {
          if (statSync(abs).isFile()) traceFiles.push(toRel(root, abs));
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
  files.sort((a, b) => b.sites - a.sites || a.path.localeCompare(b.path));
  return { sites, files, traceFiles };
}

/** Plain factual sentence for the notice body; null when nothing is left. */
export function formatDebugResidueMessage(r: DebugResidue): string | null {
  const parts: string[] = [];
  if (r.sites > 0) {
    const listed = r.files.slice(0, MAX_LISTED_FILES).map((f) => `${f.path} (${f.sites})`).join(', ');
    const more = r.files.length > MAX_LISTED_FILES ? ` 외 ${r.files.length - MAX_LISTED_FILES}개 파일` : '';
    parts.push(`임시 계측 ${r.sites}곳이 ${r.files.length}개 파일에 남아 있습니다: ${listed}${more}.`);
  }
  if (r.traceFiles.length > 0) {
    parts.push(`로그 파일 ${r.traceFiles.length}개가 남아 있습니다: ${r.traceFiles.slice(0, MAX_LISTED_FILES).join(', ')}.`);
  }
  return parts.length ? parts.join(' ') : null;
}

/**
 * Attach the residue fact to the run's notice. An existing continuation/failure notice keeps
 * its kind and gets the sentence appended; otherwise a `debug` notice is created.
 */
export function mergeDebugResidueNotice(
  existing: ApplicationNotice | undefined,
  r: DebugResidue,
): ApplicationNotice | undefined {
  const msg = formatDebugResidueMessage(r);
  if (!msg) return existing;
  if (existing) return { ...existing, message: `${existing.message} ${msg}` };
  return {
    kind: 'debug',
    title: r.sites > 0 ? '임시 계측 남음' : '디버그 로그 남음',
    message: msg,
  };
}
