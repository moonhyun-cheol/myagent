/**
 * Session-scoped P0 constraint lock (plan → approve → mutate).
 * Stored under data/agent-constraints/<sessionId>.json and re-injected each agent turn.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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
  invalidated?: boolean;
  invalidateReason?: string;
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

/**
 * Direction reversal — short correction utterances only.
 * Avoid sticky false positives from prose containing 「아니라」 mid-sentence.
 */
const DIRECTION_REVERSAL_RE =
  /^(?:그런데|근데)?\s*(?:아니(?:지|야)|반대(?:야|다|로)?|그게\s*아니라|반대로|잘못\s*(?:이해|짚)|다시\s*정리)\b/i;

const DIRECTION_REVERSAL_LOOSE_RE =
  /(?:^|[\n.。])\s*(?:아니지|아니야|반대야|그게\s*아니라|잘못\s*이해)/i;

export function looksLikeDirectionReversal(message: string): boolean {
  const t = String(message || '').trim();
  if (!t) return false;
  // Long task briefs (code-chip mutate prompts) must not trip on incidental 「아니라」.
  if (t.length > 160) return DIRECTION_REVERSAL_LOOSE_RE.test(t.slice(0, 200));
  return DIRECTION_REVERSAL_RE.test(t) || DIRECTION_REVERSAL_LOOSE_RE.test(t);
}

const NEW_SEPARATE_RE =
  /(?:새\s*프로그램|신규\s*(?:확장|폴더|프로젝트)|기존\s*(?:유지|보존).*새|별도\s*(?:폴더|확장|프로그램)|기존.*건드리지\s*말)/i;

const MODIFY_EXISTING_RE =
  /(?:기존\s*(?:파일|프로그램|확장).*수정|그\s*파일\s*(?:고쳐|바꿔)|현재\s*코드\s*(?:개조|수정))/i;

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
    const raw = JSON.parse(readFileSync(fp, 'utf8')) as LockedConstraints;
    if (!raw || typeof raw !== 'object') return null;
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

export function clearLockedConstraints(cqrRoot: string, sessionId: string | undefined): void {
  if (!sessionId?.trim()) return;
  const fp = lockedConstraintsPath(cqrRoot, sessionId);
  if (existsSync(fp)) unlinkSync(fp);
}

/** Clear sticky INVALIDATED after code-chip AGENT execute (PLAN rewrite not required). */
export function clearStickyInvalidation(
  current: LockedConstraints | null,
): LockedConstraints | null {
  if (!current?.invalidated) return current;
  return {
    ...current,
    updatedAt: new Date().toISOString(),
    invalidated: false,
    invalidateReason: undefined,
    rawLines: current.rawLines.filter((l) => !/^INVALIDATED:/i.test(l)).slice(0, 24),
  };
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
    invalidated: raw.invalidated === true,
    invalidateReason:
      typeof raw.invalidateReason === 'string' ? raw.invalidateReason.slice(0, 240) : undefined,
    artifact,
    artifactKind: artifact?.artifactKind,
    runtimeSurface: artifact?.runtimeSurface,
  };
}

/** Attach / merge artifact contract onto locked constraints. */
export function withArtifactContract(
  constraints: LockedConstraints | null | undefined,
  contract: ArtifactContract,
): LockedConstraints {
  const base = constraints ?? emptyConstraints();
  const merged = mergeArtifactContracts(base.artifact, contract);
  const doNotTouch = [
    ...new Set([...base.doNotTouch, ...merged.legacyIsolateGlobs]),
  ].slice(0, 32);
  return normalizeConstraints({
    ...base,
    updatedAt: new Date().toISOString(),
    doNotTouch,
    artifact: merged,
    artifactKind: merged.artifactKind,
    runtimeSurface: merged.runtimeSurface,
  });
}

function inferModeFromText(text: string): ConstraintMode {
  if (NEW_SEPARATE_RE.test(text)) return 'new_separate';
  if (MODIFY_EXISTING_RE.test(text)) return 'modify_existing';
  return 'unknown';
}

/** Parse P0 / constraint lines from a PLAN (or freeform) assistant block. */
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
      else if (inferModeFromText(value) !== 'unknown') mode = inferModeFromText(value);
    } else if (/^p0(\s*제약.*)?$/i.test(label)) {
      // Compact PLAN P0: 신규/기존 | artifactKind | 손대지 말 것: x | 진입점: y | …
      if (/신규\s*분리|새\s*프로그램|별도/.test(value)) mode = 'new_separate';
      else if (/기존\s*수정|개조|기존/.test(value) && !/신규/.test(value.split('|')[0] ?? '')) {
        mode = 'modify_existing';
      } else if (inferModeFromText(value) !== 'unknown') {
        mode = inferModeFromText(value);
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
          continue;
        }
        if (/^(ui_|shell_|core_|node_|unknown)/i.test(part) || /^(react|wpf|api)\b/i.test(part)) {
          if (!artifactPartial.artifactKind) artifactPartial.artifactKind = part as ArtifactKind;
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

  // Fallback: pull do-not-touch paths from freeform mentions.
  if (!doNotTouch.length) {
    const dn = t.match(/손대지\s*말\s*것\s*[:：]\s*([^\n]+)/i);
    if (dn?.[1]) {
      for (const part of dn[1].split(/[,，、|;]/)) {
        const p = part.trim().replace(/^[`'"\[]+|[`'"\]]+$/g, '');
        if (p && !/^없음$/.test(p)) doNotTouch.push(p.slice(0, 200));
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

export function extractLockedConstraintsFromHistory(
  history: Array<{ role?: string; content?: string }> | undefined,
): LockedConstraints | null {
  if (!history?.length) return null;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const msg = history[i];
    if (msg?.role !== 'assistant') continue;
    const extracted = extractLockedConstraintsFromText(String(msg.content ?? ''));
    if (extracted) return extracted;
  }
  return null;
}

export function invalidateLockedConstraints(
  current: LockedConstraints | null,
  reason: string,
): LockedConstraints {
  const base = current ?? emptyConstraints();
  return {
    ...base,
    updatedAt: new Date().toISOString(),
    invalidated: true,
    invalidateReason: reason.slice(0, 240),
    rawLines: [
      ...base.rawLines.slice(0, 20),
      `INVALIDATED: ${reason.slice(0, 200)}`,
    ],
  };
}

/** Resolve only explicitly structured constraints; never infer intent from the latest prose. */
export function resolveLockedConstraintsForTurn(opts: {
  cqrRoot: string;
  sessionId?: string;
  userMessage: string;
  history?: Array<{ role?: string; content?: string }>;
  /**
   * Code-chip AGENT with mutations: sticky INVALIDATED must not force PLAN rewrite
   * every turn — clear unless this message is an explicit direction reversal.
   */
  agentMutateTurn?: boolean;
}): LockedConstraints | null {
  let current =
    loadLockedConstraints(opts.cqrRoot, opts.sessionId)
    ?? extractLockedConstraintsFromHistory(opts.history);

  // Drop records created by the retired prose inference path.
  if (current?.rawLines.some((line) => /^inferred (?:from user message|artifactKind)/i.test(line))) {
    current = null;
  }

  // Code chip / AGENT execute: drop sticky invalidation so UI/thought stops spamming.
  if (opts.agentMutateTurn && current?.invalidated) {
    current = clearStickyInvalidation(current);
    if (current) {
      saveLockedConstraints(opts.cqrRoot, opts.sessionId, current);
    }
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
  // Fresh PLAN replaces invalidation; keep/merge artifact from previous + extracted.
  const artifact = mergeArtifactContracts(opts.previous?.artifact, extracted.artifact ?? emptyArtifactContract());
  const next: LockedConstraints = {
    ...extracted,
    doNotTouch: [...new Set([...extracted.doNotTouch, ...artifact.legacyIsolateGlobs])].slice(0, 32),
    artifact,
    artifactKind: artifact.artifactKind,
    runtimeSurface: artifact.runtimeSurface,
    invalidated: false,
    invalidateReason: undefined,
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
  if (constraints.invalidated) {
    lines.push(
      'STATUS: INVALIDATED — prior design discarded after user direction correction.',
      `Reason: ${constraints.invalidateReason || 'direction reversal'}`,
      'Rewrite PLAN with fresh P0 before any mutate. Do not reuse discarded paths/flow.',
      'If modality flipped away from web: isolate prior SPA under _web_legacy/ / _legacy/; add those paths to do-not-touch.',
    );
    const artNote = formatArtifactContractSystemNote(constraints.artifact);
    if (artNote) lines.push(artNote.replace(/^## Artifact contract[^\n]*\n/, '### Pending artifact (new direction)\n'));
    return lines.join('\n');
  }
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

export function formatDoneCheckSystemNote(): string {
  return [
    '## Done-check categories (required before 완료)',
    ...DONE_CHECK_CATEGORIES.map((c, i) => `${i + 1}) ${c}`),
    'Mark each 충족/부분/미충족. Any 미충족 → do not say 완료/완성.',
  ].join('\n');
}
