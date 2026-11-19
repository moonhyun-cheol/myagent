/**
 * Session-scoped P0 constraint lock (plan → approve → mutate).
 * Written only when the user approves a PLAN (Build handoff), stored under
 * data/agent-constraints/<sessionId>.json and re-injected each agent turn.
 * Earlier chat prose is never parsed into constraints.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  emptyArtifactContract,
  formatArtifactContractSystemNote,
  mergeArtifactContracts,
  normalizeArtifactContract,
  type ArtifactContract,
  type ArtifactKind,
  type RuntimeSurface,
} from './agent-artifact-contract.js';

export type ConstraintMode = 'new_separate' | 'modify_existing' | 'unknown';

export interface LockedConstraints {
  updatedAt: string;
  mode: ConstraintMode;
  doNotTouch: string[];
  entry?: string;
  sources: Record<string, string>;
  requirementChecks: string[];
  rawLines: string[];
  /** Product modality contract (ADR-007 extension). */
  artifact?: ArtifactContract;
  artifactKind?: ArtifactKind;
  runtimeSurface?: RuntimeSurface;
}

/** Minimum done-check categories (shared by PLAN / AGENT / acceptance). */
export const DONE_CHECK_CATEGORIES = [
  '신규 vs 기존 분리(또는 명시적 기존 수정)',
  '산출물 종류(artifactKind) · runtimeSurface',
  '사용자 진입 UX',
  '데이터 출처(코드/옵션/매핑) — unknown면 invent 금지',
  '필수 env/secrets preflight',
  'do-not-touch 경로 미변경',
] as const;

function sanitizeSessionKey(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'default';
}

function constraintsDir(cqrRoot: string): string {
  return path.join(cqrRoot, 'data', 'agent-constraints');
}

export function lockedConstraintsPath(cqrRoot: string, sessionId: string): string {
  return path.join(constraintsDir(cqrRoot), `${sanitizeSessionKey(sessionId)}.json`);
}

export function loadLockedConstraints(
  cqrRoot: string,
  sessionId: string | undefined,
): LockedConstraints | null {
  if (!sessionId?.trim()) return null;
  const fp = lockedConstraintsPath(cqrRoot, sessionId);
  if (!existsSync(fp)) return null;
  try {
    const raw = JSON.parse(readFileSync(fp, 'utf8')) as LockedConstraints & { invalidated?: unknown };
    if (!raw || typeof raw !== 'object') return null;
    // Records invalidated by the retired direction-reversal path carry no usable P0.
    if (raw.invalidated === true) return null;
    return normalizeConstraints(raw);
  } catch {
    return null;
  }
}

export function saveLockedConstraints(
  cqrRoot: string,
  sessionId: string | undefined,
  constraints: LockedConstraints,
): void {
  if (!sessionId?.trim()) return;
  const dir = constraintsDir(cqrRoot);
  mkdirSync(dir, { recursive: true });
  const fp = lockedConstraintsPath(cqrRoot, sessionId);
  writeFileSync(fp, `${JSON.stringify(normalizeConstraints(constraints), null, 2)}\n`, 'utf8');
}

function emptyConstraints(partial?: Partial<LockedConstraints>): LockedConstraints {
  return normalizeConstraints({
    updatedAt: new Date().toISOString(),
    mode: 'unknown',
    doNotTouch: [],
    sources: {},
    requirementChecks: [],
    rawLines: [],
    ...partial,
  });
}

function artifactFromRaw(raw: Partial<LockedConstraints>): ArtifactContract | undefined {
  if (raw.artifact && typeof raw.artifact === 'object') {
    return normalizeArtifactContract(raw.artifact);
  }
  if (raw.artifactKind || raw.runtimeSurface) {
    return normalizeArtifactContract({
      artifactKind: raw.artifactKind,
      runtimeSurface: raw.runtimeSurface,
    });
  }
  return undefined;
}

function normalizeConstraints(raw: Partial<LockedConstraints>): LockedConstraints {
  const mode =
    raw.mode === 'new_separate' || raw.mode === 'modify_existing' || raw.mode === 'unknown'
      ? raw.mode
      : 'unknown';
  const artifact = artifactFromRaw(raw);
  return {
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
    mode,
    doNotTouch: Array.isArray(raw.doNotTouch)
      ? raw.doNotTouch.map((s) => String(s).trim()).filter(Boolean).slice(0, 32)
      : [],
    entry: typeof raw.entry === 'string' && raw.entry.trim() ? raw.entry.trim().slice(0, 200) : undefined,
    sources:
      raw.sources && typeof raw.sources === 'object' && !Array.isArray(raw.sources)
        ? Object.fromEntries(
            Object.entries(raw.sources)
              .map(([k, v]) => [String(k).trim(), String(v).trim()])
              .filter(([k, v]) => k && v)
              .slice(0, 12),
          )
        : {},
    requirementChecks: Array.isArray(raw.requirementChecks)
      ? raw.requirementChecks.map((s) => String(s).trim()).filter(Boolean).slice(0, 12)
      : [],
    rawLines: Array.isArray(raw.rawLines)
      ? raw.rawLines.map((s) => String(s).trim()).filter(Boolean).slice(0, 24)
      : [],
    artifact,
    artifactKind: artifact?.artifactKind,
    runtimeSurface: artifact?.runtimeSurface,
  };
}

/** Parse labelled P0 / constraint fields from an approved PLAN block (no prose inference). */
export function extractLockedConstraintsFromText(text: string): LockedConstraints | null {
  const t = String(text || '');
  if (!t.trim()) return null;
  const hasPlanCue =
    /^PLAN\s*:/im.test(t)
    || /P0\s*제약/i.test(t)
    || /손대지\s*말\s*것/i.test(t)
    || /신규\s*\/\s*기존|신규\/기존/i.test(t)
    || /요구\s*체크/i.test(t);
  if (!hasPlanCue) return null;

  const rawLines: string[] = [];
  const doNotTouch: string[] = [];
  const sources: Record<string, string> = {};
  const requirementChecks: string[] = [];
  let entry: string | undefined;
  let mode: ConstraintMode = 'unknown';
  let artifactPartial: Partial<ArtifactContract> = {};

  const fieldRe =
    /^(?:P0(?:\s*제약[^:]*)?|신규\s*\/\s*기존|신규\/기존|손대지\s*말\s*것|진입점|데이터\s*출처|요구\s*체크|artifactKind|runtimeSurface|requiredSecrets)\s*[:：]\s*(.*)$/i;

  for (const raw of t.split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-*•]\s*/, '').trim();
    if (!line) continue;
    const m = line.match(fieldRe);
    if (!m) continue;
    rawLines.push(line.slice(0, 240));
    const label = line.split(/[:：]/)[0]?.toLowerCase() ?? '';
    const value = (m[1] ?? '').trim();
    if (!value || /^[\(（]?잠금[\)）]?$/.test(value)) continue;
    if (/신규|기존/.test(label) && !/^p0\b/i.test(label)) {
      if (/신규\s*분리|새\s*프로그램|별도/.test(value)) mode = 'new_separate';
      else if (/기존\s*수정|개조/.test(value)) mode = 'modify_existing';
    } else if (/^p0(\s*제약.*)?$/i.test(label)) {
      // Compact PLAN P0: 신규/기존 | artifactKind | 손대지 말 것: x | 진입점: y | …
      if (/신규\s*분리|새\s*프로그램|별도/.test(value)) mode = 'new_separate';
      else if (/기존\s*수정|개조|기존/.test(value) && !/신규/.test(value.split('|')[0] ?? '')) {
        mode = 'modify_existing';
      } else if (/신규/.test(value)) {
        mode = 'new_separate';
      }
      for (const part of value.split('|').map((p) => p.trim()).filter(Boolean)) {
        const kv = part.match(/^(손대지\s*말\s*것|do-not-touch|진입점|artifactKind|runtimeSurface|필수\s*env|requiredSecrets)\s*[:：]\s*(.+)$/i);
        if (kv) {
          const k = kv[1].toLowerCase();
          const v = kv[2].trim();
          if (/손대지|do-not-touch/i.test(k)) {
            for (const p of v.split(/[,，、|;]/)) {
              const pathPart = p.trim().replace(/^[`'"\[]+|[`'"\]]+$/g, '');
              if (pathPart && !/^없음$/.test(pathPart)) doNotTouch.push(pathPart.slice(0, 200));
            }
          } else if (/진입/.test(k)) {
            entry = v.slice(0, 200);
          } else if (/artifactkind/i.test(k)) {
            artifactPartial.artifactKind = v as ArtifactKind;
          } else if (/runtimesurface/i.test(k)) {
            artifactPartial.runtimeSurface = v as RuntimeSurface;
          } else if (/requiredsecrets|필수/i.test(k)) {
            if (!/^없음$/.test(v)) {
              artifactPartial.requiredSecrets = v.split(/[,，、|;]/).map((s) => s.trim()).filter(Boolean);
            }
          }
        }
      }
    } else if (/손대지/.test(label)) {
      for (const part of value.split(/[,，、|;]/)) {
        const p = part.trim().replace(/^[`'"\[]+|[`'"\]]+$/g, '');
        if (p && !/^없음$/.test(p)) doNotTouch.push(p.slice(0, 200));
      }
    } else if (/진입/.test(label)) {
      entry = value.slice(0, 200);
    } else if (/artifactkind/i.test(label)) {
      artifactPartial.artifactKind = value.trim() as ArtifactKind;
    } else if (/runtimesurface/i.test(label)) {
      artifactPartial.runtimeSurface = value.trim() as RuntimeSurface;
    } else if (/requiredsecrets/i.test(label)) {
      artifactPartial.requiredSecrets = value
        .split(/[,，、|;]/)
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (/데이터|출처/.test(label)) {
      for (const part of value.split(/[,，、|;]/)) {
        const kv = part.trim().match(/^([^:=]+)[=:：]\s*(.+)$/);
        if (kv) sources[kv[1].trim()] = kv[2].trim().slice(0, 120);
        else if (part.trim()) {
          sources[`src${Object.keys(sources).length + 1}`] = part.trim().slice(0, 120);
        }
      }
    } else if (/요구\s*체크/.test(label)) {
      for (const part of value.split(/[,，、|;|\[\]]/)) {
        const c = part.replace(/^\s*\[[ xX]?\]\s*/, '').trim();
        if (c) requirementChecks.push(c.slice(0, 120));
      }
    }
  }

  const artifact = Object.keys(artifactPartial).length
    ? normalizeArtifactContract(artifactPartial)
    : emptyArtifactContract();

  if (
    mode === 'unknown'
    && !doNotTouch.length
    && !entry
    && !Object.keys(sources).length
    && !requirementChecks.length
    && !rawLines.length
    && artifact.artifactKind === 'unknown'
  ) {
    return null;
  }

  return emptyConstraints({
    mode,
    doNotTouch: [...new Set(doNotTouch)].slice(0, 32),
    entry,
    sources,
    requirementChecks: requirementChecks.length
      ? requirementChecks
      : [...DONE_CHECK_CATEGORIES],
    rawLines,
    artifact,
    artifactKind: artifact.artifactKind,
    runtimeSurface: artifact.runtimeSurface,
  });
}

/** Resolve only constraints saved by an approved PLAN; chat history is never parsed. */
export function resolveLockedConstraintsForTurn(opts: {
  cqrRoot: string;
  sessionId?: string;
  userMessage: string;
}): LockedConstraints | null {
  const current = loadLockedConstraints(opts.cqrRoot, opts.sessionId);
  // Drop records created by the retired prose inference path.
  if (current?.rawLines.some((line) => /^inferred (?:from user message|artifactKind)/i.test(line))) {
    return null;
  }
  return current;
}

export function persistConstraintsFromAssistantText(opts: {
  cqrRoot: string;
  sessionId?: string;
  assistantText: string;
  previous?: LockedConstraints | null;
}): LockedConstraints | null {
  const extracted = extractLockedConstraintsFromText(opts.assistantText);
  if (!extracted) return opts.previous ?? null;
  // Fresh PLAN replaces the previous lock; keep/merge artifact from previous + extracted.
  const artifact = mergeArtifactContracts(opts.previous?.artifact, extracted.artifact ?? emptyArtifactContract());
  const next: LockedConstraints = {
    ...extracted,
    doNotTouch: [...new Set([...extracted.doNotTouch, ...artifact.legacyIsolateGlobs])].slice(0, 32),
    artifact,
    artifactKind: artifact.artifactKind,
    runtimeSurface: artifact.runtimeSurface,
  };
  saveLockedConstraints(opts.cqrRoot, opts.sessionId, next);
  return next;
}

export function formatLockedConstraintsSystemNote(
  constraints: LockedConstraints | null | undefined,
): string {
  if (!constraints) return '';
  const lines = [
    '## Locked constraints (session P0 — prefer over earlier chat guesses)',
  ];
  lines.push(`mode: ${constraints.mode}`);
  if (constraints.entry) lines.push(`entry: ${constraints.entry}`);
  if (constraints.doNotTouch.length) {
    lines.push(`do-not-touch: ${constraints.doNotTouch.join(', ')}`);
    lines.push('FORBIDDEN: edit_file/apply_patch/write_file/delete_file on do-not-touch paths.');
  }
  const srcEntries = Object.entries(constraints.sources);
  if (srcEntries.length) {
    lines.push(`sources: ${srcEntries.map(([k, v]) => `${k}=${v}`).join('; ')}`);
  }
  const checks = constraints.requirementChecks.length
    ? constraints.requirementChecks
    : [...DONE_CHECK_CATEGORIES];
  lines.push(`requirement checks: ${checks.join(' | ')}`);
  if (constraints.rawLines.length) {
    lines.push('raw P0 lines:');
    for (const row of constraints.rawLines.slice(0, 8)) lines.push(`- ${row}`);
  }
  lines.push(
    'Before 「완료」: mark each requirement check 충족/부분/미충족; if any 미충족, do not claim done.',
  );
  const artNote = formatArtifactContractSystemNote(constraints.artifact);
  if (artNote) lines.push(artNote);
  return lines.join('\n');
}
