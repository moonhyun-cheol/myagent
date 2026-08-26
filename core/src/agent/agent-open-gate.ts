/**
 * Session Exit Gate — one unclosed completion condition (disk/execution evidence).
 * Persisted on AgentRunMeta; injected into run-loop; Critic `next` seeds it.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { normalizeAgentPath } from './agent-grounding.js';
import type { VerifyWitness } from './agent-claim-gates.js';
import {
  commandLooksLikeWorkspaceUiBuild,
  hasWorkspaceUiBuildWitness,
  probeWorkspaceUiBuildFreshness,
} from './agent-workspace-ui-build.js';

export type OpenGateStatus = 'open' | 'closed';
export type OpenGateSource =
  | 'critic'
  | 'outcome'
  | 'verify'
  | 'review_followup'
  | 'manual';

export type OpenGateEvidenceKind =
  | 'path_exists'
  | 'mutate'
  | 'diagnostics_ok'
  | 'tests_ok'
  | 'marker'
  | 'command_exit0'
  | 'json_field';

export interface SessionOpenGate {
  updatedAt: string;
  status: OpenGateStatus;
  /** Single unclosed completion condition (Critic next / 다음 수정). */
  gate: string;
  source: OpenGateSource;
  evidence?: {
    kind: OpenGateEvidenceKind;
    path?: string;
    marker?: string;
    command?: string;
    jsonPath?: string;
  };
  parentRunId?: string;
  agentId?: string;
  closedAt?: string;
  closeReason?: string;
}

const NONE_RE = /^(?:없음|none|n\/a|na|-|—|–|\.|x)?$/i;

export function isNoneGateText(text: string | null | undefined): boolean {
  const t = String(text || '').trim();
  if (!t) return true;
  return NONE_RE.test(t) || /^(?:없음|none)\s*[.!]?\s*$/i.test(t);
}

/** True when meta openGate should force the next turn to close that gate only. */
export function openGateBlocksDoneClaim(gate: SessionOpenGate | null | undefined): boolean {
  if (!gate || gate.status !== 'open') return false;
  return !isNoneGateText(gate.gate);
}

/** Sticky workspace:build Exit Gate (shell serves dist). */
export function isWorkspaceUiBuildOpenGate(gate: SessionOpenGate | null | undefined): boolean {
  if (!gate) return false;
  const blob = `${gate.gate || ''} ${gate.evidence?.command || ''} ${gate.evidence?.path || ''}`;
  return /workspace:build/i.test(blob);
}

/**
 * Cursor-like: sticky UI-build Exit Gates must not hijack normal AGENT turns.
 * Keep only when the user message is primarily a build/refresh request —
 * NOT when `workspace:build` appears as Acceptance/Exit Gate text inside a feature brief
 * (that kept forcing build-only loops).
 */
export function shouldSuppressWorkspaceUiBuildGate(
  gate: SessionOpenGate | null | undefined,
  userMessage: string,
): boolean {
  if (!isWorkspaceUiBuildOpenGate(gate)) return false;
  const t = String(userMessage || '').trim();
  if (!t) return true;
  // Short/explicit build-only turns keep the gate.
  if (
    /^(?:npm\s+run\s+)?workspace:build\b/i.test(t)
    || /^(?:빌드\s*(?:해|실행)|dist\s*(?:빌드|갱신)|Preview\s*(?:갱신|빌드)|셸\s*(?:반영|빌드))\s*[.!]?\s*$/i.test(
      t,
    )
  ) {
    return false;
  }
  // Feature briefs that merely list workspace:build as Exit Gate → suppress sticky hijack.
  return true;
}

export function normalizeSessionOpenGate(
  raw: Partial<SessionOpenGate> | null | undefined,
): SessionOpenGate | null {
  if (!raw || typeof raw !== 'object') return null;
  const gate = String(raw.gate || '').trim().slice(0, 500);
  if (!gate || isNoneGateText(gate)) return null;
  const status: OpenGateStatus = raw.status === 'closed' ? 'closed' : 'open';
  const source = (['critic', 'outcome', 'verify', 'review_followup', 'manual'] as const).includes(
    raw.source as OpenGateSource,
  )
    ? (raw.source as OpenGateSource)
    : 'manual';
  const out: SessionOpenGate = {
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
    status,
    gate,
    source,
  };
  if (raw.evidence && typeof raw.evidence === 'object') {
    out.evidence = {
      kind: (raw.evidence.kind as OpenGateEvidenceKind) || 'mutate',
      path: raw.evidence.path ? String(raw.evidence.path).replace(/\\/g, '/') : undefined,
      marker: raw.evidence.marker ? String(raw.evidence.marker) : undefined,
      command: raw.evidence.command ? String(raw.evidence.command) : undefined,
      jsonPath: raw.evidence.jsonPath ? String(raw.evidence.jsonPath) : undefined,
    };
  }
  if (typeof raw.parentRunId === 'string' && raw.parentRunId.trim()) {
    out.parentRunId = raw.parentRunId.trim();
  }
  if (typeof raw.agentId === 'string' && raw.agentId.trim()) {
    out.agentId = raw.agentId.trim();
  }
  if (typeof raw.closedAt === 'string') out.closedAt = raw.closedAt;
  if (typeof raw.closeReason === 'string') out.closeReason = raw.closeReason.slice(0, 200);
  return out;
}

/** Normalize Critic `next` payload to a single gate string (never a laundry list). */
function singleGateFromNextValue(next: unknown): string | null {
  if (typeof next === 'string') {
    const n = next.trim();
    if (isNoneGateText(n)) return null;
    // "a; b; c" / multi-line bullets → first item only
    const first = n.split(/\n|;|・|•/).map((s) => s.replace(/^[\d.)\-\s]+/, '').trim()).find(Boolean);
    if (!first || isNoneGateText(first)) return null;
    return first.slice(0, 500);
  }
  if (Array.isArray(next)) {
    for (const item of next) {
      const g = singleGateFromNextValue(item);
      if (g) return g;
    }
    return null;
  }
  return null;
}

/** Extract Critic `next` / 다음 수정 as a single gate string. */
export function parseCriticNext(text: string): string | null {
  const raw = String(text || '');
  const jsonBlock = raw.match(/```json\s*([\s\S]*?)```/i);
  const candidate =
    jsonBlock?.[1]?.trim()
    || raw.match(/\{[\s\S]*"next"\s*:\s*(?:"[^"]*"|\[)[\s\S]*\}/i)?.[0];
  if (candidate) {
    try {
      const doc = JSON.parse(candidate) as { next?: unknown };
      const g = singleGateFromNextValue(doc.next);
      if (g) return g;
    } catch {
      const m = candidate.match(/"next"\s*:\s*"((?:\\.|[^"\\])*)"/i);
      if (m?.[1]) {
        const g = singleGateFromNextValue(m[1].replace(/\\"/g, '"'));
        if (g) return g;
      }
      const arr = candidate.match(/"next"\s*:\s*\[\s*"((?:\\.|[^"\\])*)"/i);
      if (arr?.[1]) {
        const g = singleGateFromNextValue(arr[1].replace(/\\"/g, '"'));
        if (g) return g;
      }
    }
  }
  // First prose line only (avoid multi-line re-plan lists).
  const line = raw.match(/(?:다음\s*수정|next(?:\s*gate)?)\s*[:：]\s*(.+)$/im);
  if (line?.[1]) {
    return singleGateFromNextValue(line[1].replace(/\s+/g, ' ').trim());
  }
  return null;
}

export function formatOpenGateSystemNote(gate: SessionOpenGate): string {
  return [
    '## Session Exit Gate (OPEN — close this first)',
    `GATE: ${gate.gate}`,
    `source=${gate.source} updatedAt=${gate.updatedAt}`,
    'Rules:',
    '- This turn: close ONLY this gate. Do not re-diagnose the whole task. Do not invent a new laundry list.',
    '- Closing evidence must be on disk / command exit / verify witness — not user text like "설치함".',
    '- Do NOT end with 「다음 조치: …」 and wait. Tool-call until this gate closes or you are blocked.',
    '- After this gate closes, answer the user in the form you judge most useful; do not add a local work-report template.',
    gate.evidence?.path ? `evidence.path hint: ${gate.evidence.path}` : '',
    gate.evidence?.kind ? `evidence.kind hint: ${gate.evidence.kind}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatOpenGateNudge(gate: SessionOpenGate): string {
  return [
    'EXIT_GATE: Session openGate is still OPEN. Do not claim overall 완료.',
    `Close this gate first: ${gate.gate}`,
    'Call tools now (mutate / run_diagnostics / run_tests as needed). One gate only — no full re-plan.',
  ].join('\n');
}

export function formatOpenGateRewrite(gate: SessionOpenGate): string {
  return [
    `미닫힌 Exit Gate — 완료로 확정하지 않습니다.`,
    `GATE: ${gate.gate}`,
    '디스크·실행 증거로 이 게이트를 닫은 뒤 다시 보고하세요. (전체 재진단·다음 조치 위임 금지)',
  ].join('\n');
}

/** Path-like tokens in gate text (best-effort). */
export function extractPathsFromGateText(gateText: string): string[] {
  const hits = String(gateText || '').match(
    /[\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|html|css|md|py|go|rs)/gi,
  );
  if (!hits?.length) return [];
  return [...new Set(hits.map((p) => p.replace(/\\/g, '/')))].slice(0, 8);
}

export function openGateLikelyAddressed(
  gate: SessionOpenGate,
  mutatedPaths: string[],
  workspaceRoot?: string,
  verifyWitness?: VerifyWitness | null,
): boolean {
  if (!openGateBlocksDoneClaim(gate)) return false;

  // command_exit0 (e.g. npm run workspace:build) — witness or fresh dist.
  if (gate.evidence?.kind === 'command_exit0') {
    if (hasWorkspaceUiBuildWitness(verifyWitness)) return true;
    if (
      commandLooksLikeWorkspaceUiBuild(gate.evidence.command)
      && workspaceRoot
    ) {
      const probe = probeWorkspaceUiBuildFreshness(workspaceRoot, mutatedPaths, verifyWitness);
      if (probe.ok && probe.reason !== 'no_ui_src') return true;
      // Dist path exists and was rebuilt even when source list empty this turn.
      if (gate.evidence.path && workspaceRoot) {
        const abs = path.isAbsolute(gate.evidence.path)
          ? gate.evidence.path
          : path.join(workspaceRoot, gate.evidence.path);
        if (existsSync(abs) && hasWorkspaceUiBuildWitness(verifyWitness)) return true;
      }
    }
  }

  const norms = mutatedPaths.map((p) => normalizeAgentPath(p).toLowerCase());
  const hintPath = gate.evidence?.path
    ? normalizeAgentPath(gate.evidence.path).toLowerCase()
    : '';
  if (hintPath) {
    if (norms.some((m) => m === hintPath || m.endsWith(`/${hintPath}`) || hintPath.endsWith(`/${m}`) || m.includes(hintPath) || hintPath.includes(m))) {
      return true;
    }
    if (workspaceRoot) {
      const abs = path.isAbsolute(gate.evidence!.path!)
        ? gate.evidence!.path!
        : path.join(workspaceRoot, gate.evidence!.path!);
      if (gate.evidence?.kind === 'path_exists' && existsSync(abs)) return true;
    }
  }
  const fromText = extractPathsFromGateText(gate.gate);
  if (fromText.length) {
    const pathExistsOnDisk = (relOrAbs: string): boolean => {
      if (!workspaceRoot) return false;
      try {
        const abs = path.isAbsolute(relOrAbs)
          ? relOrAbs
          : path.join(workspaceRoot, relOrAbs);
        return existsSync(abs);
      } catch {
        return false;
      }
    };
    const hit = fromText.some((p) => {
      const n = p.toLowerCase();
      return norms.some(
        (m) => m.endsWith(`/${n}`) || m.includes(n) || n.includes(path.basename(m)),
      );
    });
    if (hit) return true;
    // path_exists / mutate gate: files already on disk close the gate (resume / partial recreate).
    if (
      gate.evidence?.kind === 'path_exists'
      || gate.evidence?.kind === 'mutate'
    ) {
      return fromText.every((p) => pathExistsOnDisk(p));
    }
    return false;
  }
  // Vague gate ("재검토") — only Critic PASS may clear (caller).
  return false;
}

export function buildOpenGateFromCriticNext(
  next: string,
  opts?: {
    source?: OpenGateSource;
    parentRunId?: string;
    agentId?: string;
    evidencePath?: string;
  },
): SessionOpenGate | null {
  const gate = String(next || '').trim();
  if (isNoneGateText(gate)) return null;
  const paths = extractPathsFromGateText(gate);
  return normalizeSessionOpenGate({
    updatedAt: new Date().toISOString(),
    status: 'open',
    gate,
    source: opts?.source ?? 'critic',
    parentRunId: opts?.parentRunId,
    agentId: opts?.agentId,
    evidence: opts?.evidencePath || paths[0]
      ? {
          kind: 'mutate',
          path: opts?.evidencePath || paths[0],
        }
      : undefined,
  });
}
